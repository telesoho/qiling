import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { QiLingPhase } from '../lib/phase'
import { readLine, subscribeLine, type PetLine } from '../lib/line'
import { closeSpeechBubble, loadQiLingSettings, saveQiLingSettings, watchQiLingSettings } from '../lib/settings'
import { usePetSpeech } from '../lib/speech'
import { loadAnimLibrary, phaseDurationMs, phaseImageUrl, preloadTrack, type AnimLibrary } from './anim'
import { publishBubble } from './bubbleSync'
import { PetSpeechBubble } from './PetControls'
import { PickupSprite } from './PickupSprite'
import { pickupPhaseAfterPress, pickupPhaseAfterRelease, pickupSegments, type PickupPhase } from './pickup'
import { IDLE_BEATS, PET_STATES, bubbleLine, petState, pickIdleBeat, playbackFor, poseForLine, type IdleBeat, type LinePhase, type PetStateId } from './states'
import { inTauri, petWindowIsOpen, publishPet, readPetState, setPetWindowOpen, subscribePet } from './sync'
import { usePetDrag } from './usePetDrag'

function speakPhase(phase: LinePhase): QiLingPhase {
  if (phase === 'thinking') return 'analyzing'
  if (phase === 'say') return 'ready'
  return 'idle'
}

export default function PetApp(): JSX.Element {
  const [line, setLine] = useState<PetLine>(readLine)
  const [voice, setVoiceOn] = useState(() => loadQiLingSettings().voice)
  const [stateId, setStateId] = useState<PetStateId>(() => {
    const current = readLine()
    if (current.phase !== 'idle') {
      return poseForLine({ ...current, voice: loadQiLingSettings().voice, playback: 'waiting' })
    }
    return readPetState()
  })
  const [beat, setBeat] = useState<IdleBeat>('breath')
  const [pickup, setPickup] = useState<PickupPhase>('idle')
  const [library, setLibrary] = useState<AnimLibrary | null>(null)
  const [shown, setShown] = useState(() => !inTauri())
  const [bubbleOpen, setBubbleOpen] = useState(() => loadQiLingSettings().bubble)
  const [ready, setReady] = useState(() => !inTauri())
  const published = useRef<PetStateId | null>(null)
  const sawLine = useRef(false)
  const stateRef = useRef(stateId)
  stateRef.current = stateId
  const state = petState(stateId)
  const idle = stateId === 'idle' ? IDLE_BEATS[beat] : null
  const preview = !inTauri()
  const forcedId =
    preview && typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('track')
      : null
  const forcedTrack = forcedId ? library?.byId.get(forcedId) : undefined
  const pickupTrack = forcedTrack ?? library?.byTag('pickup')
  const segments = useMemo(() => pickupSegments(pickupTrack), [pickupTrack])
  const activeTrack = forcedTrack ?? (idle ? library?.byTag(idle.track) : library?.byTag(state.track))
  const fallbackSrc = `/pet/${idle?.file ?? state.file}`
  const poseSrc = phaseImageUrl(activeTrack, 'idle') ?? fallbackSrc
  const speechPhaseNow = ready ? speakPhase(line.phase) : 'idle'
  const speechText = ready ? line.text : ''
  const speech = usePetSpeech({
    voice,
    visible: ready && shown,
    phase: speechPhaseNow,
    text: speechText,
  })
  const playback = playbackFor({
    voice,
    phase: line.phase,
    text: line.text,
    audible: speech.audible,
    audibleLine: speech.audibleLine,
    heardLine: speech.heardLine,
  })
  const bubbleText = bubbleLine(stateId, line.text, idle?.line)
  const interruptRef = useRef(speech.interrupt)
  interruptRef.current = speech.interrupt
  const drag = usePetDrag({
    onGrab: () => setPickup((phase) => pickupPhaseAfterPress(segments, phase)),
    onRelease: () => setPickup((phase) => pickupPhaseAfterRelease(segments, phase)),
  })

  useEffect(() => {
    let alive = true
    loadAnimLibrary()
      .then((next) => {
        if (alive) setLibrary(next)
      })
      .catch((error) => {
        console.warn('动画目录不可用', error)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!library) return
    const tracks = [
      pickupTrack,
      forcedTrack,
      library.byTag('idle'),
      library.byTag('butterfly'),
      library.byTag('angry'),
    ]
    for (const track of tracks) {
      if (track) void preloadTrack(track)
    }
  }, [library, pickupTrack, forcedTrack])

  useEffect(() => {
    if (!segments && pickup !== 'idle') setPickup('idle')
  }, [segments, pickup])

  useEffect(() => subscribeLine(setLine), [])

  useEffect(() => watchQiLingSettings((next) => {
    setVoiceOn(next.voice)
    setBubbleOpen(next.bubble)
  }), [])

  useEffect(() => {
    if (!inTauri()) return
    publishBubble({
      text: bubbleText,
      voice,
      speaking: speech.speaking,
      open: bubbleOpen && shown && ready,
    })
  }, [bubbleText, voice, speech.speaking, bubbleOpen, shown, ready])

  useEffect(() => {
    if (!inTauri()) return
    let dead = false
    let stop = () => {}
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('qiling-interrupt', () => interruptRef.current()))
      .then((unlisten) => {
        if (dead) unlisten()
        else stop = unlisten
      })
      .catch(() => {})
    return () => {
      dead = true
      stop()
    }
  }, [])

  useEffect(() => {
    if (stateId !== 'idle' || forcedTrack) {
      setBeat('breath')
      return
    }
    const beatMs = (name: IdleBeat) =>
      phaseDurationMs(library?.byTag(IDLE_BEATS[name].track), 'idle') ?? IDLE_BEATS[name].ms
    let timer = 0
    const breathe = () => {
      setBeat('breath')
      timer = window.setTimeout(() => {
        const next = pickIdleBeat(Math.random())
        if (next === 'breath') {
          breathe()
          return
        }
        setBeat(next)
        timer = window.setTimeout(breathe, beatMs(next))
      }, beatMs('breath'))
    }
    breathe()
    return () => window.clearTimeout(timer)
  }, [stateId, forcedTrack, library])

  useEffect(() => {
    if (!inTauri()) return
    let alive = true
    petWindowIsOpen()
      .then((open) => {
        if (!alive) return
        setShown(open)
        setReady(true)
      })
      .catch(() => {
        if (alive) setReady(true)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const narratingNow = line.phase !== 'idle'
    if (!sawLine.current) {
      sawLine.current = true
      if (!narratingNow) return
    }
    const next = poseForLine({
      phase: line.phase,
      mood: line.mood,
      voice,
      playback,
    })
    if (stateRef.current !== next) {
      stateRef.current = next
      setStateId(next)
    }
    if (published.current === next) return
    published.current = next
    publishPet({ type: 'state', state: next })
  }, [line.phase, line.mood, line.text, voice, playback])

  useEffect(() => {
    const stop = subscribePet((message) => {
      if (message.type === 'state') {
        if (message.state === published.current) return
        published.current = message.state
        stateRef.current = message.state
        setStateId(message.state)
      }
      if (message.type === 'visibility') {
        setShown(message.open)
        if (!message.open) drag.cancel()
        if (!message.open && !inTauri()) window.close()
      }
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hide()
        return
      }
      const index = PET_STATES.findIndex((item) => item.id === stateId)
      if (event.key === 'ArrowRight') {
        choose(PET_STATES[(index + 1) % PET_STATES.length].id)
      } else if (event.key === 'ArrowLeft') {
        choose(PET_STATES[(index - 1 + PET_STATES.length) % PET_STATES.length].id)
      }
    }
    window.addEventListener('keydown', onKey)
    const onUnload = () => {
      if (!inTauri()) publishPet({ type: 'visibility', open: false })
    }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      stop()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [stateId])

  function choose(next: PetStateId) {
    published.current = next
    stateRef.current = next
    setStateId(next)
    publishPet({ type: 'state', state: next })
  }

  function hide() {
    drag.cancel()
    speech.interrupt()
    setShown(false)
    void setPetWindowOpen(false)
  }

  function setVoice(next: boolean) {
    saveQiLingSettings({ ...loadQiLingSettings(), voice: next })
    setVoiceOn(next)
  }

  function collapseBubble() {
    setBubbleOpen(closeSpeechBubble().bubble)
  }

  return (
    <div className={`pet-stage${preview ? ' is-preview' : ''}`}>
      <div className="pet-figure">
        {preview && bubbleOpen && (
          <PetSpeechBubble
            text={bubbleText}
            voiceOn={voice}
            speaking={speech.speaking}
            onToggleVoice={() => {
              if (speech.speaking && voice) {
                speech.interrupt()
                return
              }
              setVoice(!voice)
            }}
            onCollapse={collapseBubble}
          />
        )}
        <div
          className={`pet-sprite${drag.holding ? ' is-holding' : ''}`}
          onPointerDown={drag.onPointerDown}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerCancel}
          onLostPointerCapture={drag.onLostPointerCapture}
          onContextMenu={(event) => {
            if (!inTauri()) return
            event.preventDefault()
            void invoke('pet_menu')
          }}
        >
          {pickup !== 'idle' && pickupTrack && segments ? (
            <PickupSprite
              track={pickupTrack}
              segments={segments}
              phase={pickup}
              holding={drag.holding}
              fallbackSrc={poseSrc}
              onAdvance={setPickup}
            />
          ) : (
            <img
              key={state.id}
              src={poseSrc}
              alt={forcedTrack?.displayName ?? `诗琚，${state.label}`}
              draggable={false}
              className="pet-arrive"
            />
          )}
        </div>
      </div>
    </div>
  )
}
