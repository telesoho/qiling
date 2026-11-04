import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { QiLingPhase } from '../lib/phase'
import { idleLine, initialPetLine, publishLine, subscribeLine, type PetLine } from '../lib/line'
import { closeSpeechBubble, loadQiLingSettings, saveQiLingSettings, watchQiLingSettings } from '../lib/settings'
import { duckQiLing, usePetSpeech } from '../lib/speech'
import {
  WAKE_ACKNOWLEDGMENT,
  isListeningPaused,
  shouldResumeListening,
  voiceAssistantAction,
  voiceAssistantStateLabel,
  type VoiceAssistantEvent,
} from '../lib/voice-assistant'
import { phaseDurationMs, phaseImageUrl, preloadTrack, resetAnimCaches, type AnimLibrary } from './anim'
import { publishBubble } from './bubbleSync'
import {
  BUILTIN_CHARACTER,
  CHARACTER_EVENT,
  loadActiveCharacter,
  loadCharacterAssets,
  type ActiveCharacter,
} from './packs'
import { PetSpeechBubble } from './PetControls'
import { PickupSprite } from './PickupSprite'
import { pickupPhaseAfterPress, pickupPhaseAfterRelease, pickupSegments, type PickupPhase } from './pickup'
import {
  IDLE_BEATS,
  PET_STATES,
  bubbleLine,
  builtinBeatOptions,
  petState,
  pickIdleBeat,
  pickPackBeat,
  playbackFor,
  poseForLine,
  type IdleBeatOption,
  type LinePhase,
  type PetStateId,
} from './states'
import { inTauri, petWindowIsOpen, publishPet, readPetState, setPetWindowOpen, subscribePet } from './sync'
import { usePetDrag } from './usePetDrag'

function speakPhase(phase: LinePhase): QiLingPhase {
  if (phase === 'thinking') return 'analyzing'
  if (phase === 'say') return 'ready'
  return 'idle'
}

export default function PetApp(): JSX.Element {
  const [line, setLine] = useState<PetLine>(() => initialPetLine(inTauri()))
  const [voice, setVoiceOn] = useState(() => loadQiLingSettings().voice)
  const [stateId, setStateId] = useState<PetStateId>(() => {
    if (line.phase !== 'idle') {
      return poseForLine({ ...line, voice: loadQiLingSettings().voice, playback: 'waiting' })
    }
    return readPetState()
  })
  const [character, setCharacter] = useState<ActiveCharacter>(() => ({ ...BUILTIN_CHARACTER }))
  const [beats, setBeats] = useState<IdleBeatOption[]>(() => builtinBeatOptions())
  const [beat, setBeat] = useState('breath')
  const [pickup, setPickup] = useState<PickupPhase>('idle')
  const [library, setLibrary] = useState<AnimLibrary | null>(null)
  const [shown, setShown] = useState(() => !inTauri())
  const [bubbleOpen, setBubbleOpen] = useState(() => loadQiLingSettings().bubble)
  const [voiceAssistantState, setVoiceAssistantState] = useState(
    () => loadQiLingSettings().voiceAssistant ? 'starting' : 'stopped',
  )
  const lineRef = useRef<PetLine>(line)
  lineRef.current = line
  const [ready, setReady] = useState(() => !inTauri())
  const published = useRef<PetStateId | null>(null)
  const sawLine = useRef(false)
  const listeningResumeRequested = useRef(false)
  const pausedEntryLine = useRef<{ phase: string; text: string } | null>(null)
  const pausedLineChanged = useRef(false)
  const startingAssistant = useRef(false)
  const speakingLine = useRef('')
  const stateRef = useRef(stateId)
  stateRef.current = stateId
  const state = petState(stateId)
  const idle =
    stateId === 'idle'
      ? beats.find((option) => option.key === beat) ??
        beats.find((option) => option.key === 'breath') ??
        null
      : null
  const preview = !inTauri()
  const forcedId =
    preview && typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('track')
      : null
  const forcedTrack = forcedId ? library?.byId.get(forcedId) : undefined
  const pickupTrack = forcedTrack ?? library?.byTag('pickup')
  const segments = useMemo(() => pickupSegments(pickupTrack), [pickupTrack])
  const activeTrack = forcedTrack ?? (idle ? library?.byTag(idle.track) : library?.byTag(state.track))
  const idleSrc = phaseImageUrl(library?.byTag('idle'), 'idle')
  const builtinBeatFile =
    idle && character.builtin && idle.key in IDLE_BEATS
      ? IDLE_BEATS[idle.key as keyof typeof IDLE_BEATS].file
      : state.file
  const fallbackSrc = idleSrc ?? (character.builtin ? `/pet/${builtinBeatFile}` : '')
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
    let revision = 0
    let stop: (() => void) | undefined

    const load = async (next: ActiveCharacter) => {
      const request = ++revision
      try {
        const assets = await loadCharacterAssets(next)
        if (!alive || request !== revision) return
        setCharacter(assets.character)
        setLibrary(assets.library)
        setBeats(assets.beats)
        setBeat('breath')
        setPickup('idle')
      } catch (error) {
        if (!alive || request !== revision) return
        console.warn('角色动画不可用，回到内置诗琚', error)
        try {
          const assets = await loadCharacterAssets(BUILTIN_CHARACTER)
          if (!alive || request !== revision) return
          setCharacter(assets.character)
          setLibrary(assets.library)
          setBeats(assets.beats)
          setBeat('breath')
          setPickup('idle')
        } catch (fallbackError) {
          console.warn('内置动画目录也不可用', fallbackError)
        }
      }
    }

    void (async () => {
      const active = await loadActiveCharacter().catch(() => ({ ...BUILTIN_CHARACTER }))
      if (alive) await load(active)
    })()

    if (inTauri()) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) =>
          listen<ActiveCharacter>(CHARACTER_EVENT, ({ payload }) => {
            resetAnimCaches()
            void load(payload?.id ? payload : BUILTIN_CHARACTER)
          }),
        )
        .then((unlisten) => {
          if (alive) stop = unlisten
          else unlisten()
        })
        .catch((error: unknown) => {
          console.warn('无法订阅角色切换事件', String(error))
        })
    }

    return () => {
      alive = false
      stop?.()
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

  useEffect(() => {
    if (inTauri()) publishLine(idleLine)
    return subscribeLine(setLine)
  }, [])

  useEffect(() => {
    if (!isListeningPaused(voiceAssistantState)) {
      pausedEntryLine.current = null
      pausedLineChanged.current = false
      listeningResumeRequested.current = false
      return
    }
    if (!pausedEntryLine.current) {
      pausedEntryLine.current = { phase: line.phase, text: line.text }
    } else if (
      pausedEntryLine.current.phase !== line.phase ||
      pausedEntryLine.current.text !== line.text
    ) {
      pausedLineChanged.current = true
    }
    const lineText = line.text.trim()
    if (
      voice &&
      line.phase === 'say' &&
      lineText !== '' &&
      speech.audibleLine === lineText
    ) {
      pausedLineChanged.current = true
    }
    if (
      !shouldResumeListening({
        state: voiceAssistantState,
        voice,
        phase: line.phase,
        text: line.text,
        speaking: speech.speaking,
        heardLine: speech.heardLine,
        lineChanged: pausedLineChanged.current,
      })
    ) return
    if (listeningResumeRequested.current) return

    listeningResumeRequested.current = true
    // `listen` both starts the question recognizer after the wake acknowledgment
    // and re-arms wake listening after a spoken reply.
    void invoke('qiling_voice_assistant_listen').catch((error: unknown) => {
      setVoiceAssistantState('error')
      console.warn('唤醒回应后无法开始语音识别', String(error))
    })
  }, [
    line.phase,
    line.text,
    speech.heardLine,
    speech.speaking,
    voice,
    voiceAssistantState,
  ])

  useEffect(() => watchQiLingSettings((next) => {
    setVoiceOn(next.voice)
    setBubbleOpen(next.bubble)
  }), [])

  useEffect(() => {
    if (!inTauri()) return
    let active = true
    let unlisten: (() => void) | undefined
    let stateEventRevision = 0
    const handledTranscripts = new Set<number>()
    // The runtime sends `stop_playback` just before the transcript it belongs to.
    // The new question must not reach the model before the old turn is retired,
    // or the cancellation would land on the answer that replaced it.
    let pendingBargeIn: Promise<unknown> = Promise.resolve()
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const applyState = (nextState: string) => {
          setVoiceAssistantState(nextState)
          if (nextState === 'wake_acknowledgment') {
            publishLine({
              phase: 'say',
              text: WAKE_ACKNOWLEDGMENT,
              mood: 'neutral',
            })
          }
        }
        const stop = await listen<VoiceAssistantEvent>(
          'voice-assistant-event',
          ({ payload }) => {
            if (payload.type === 'state' && payload.state) {
              stateEventRevision += 1
              applyState(payload.state)
              return
            }
            if (payload.type === 'error') {
              stateEventRevision += 1
              setVoiceAssistantState('error')
              return
            }
            const action = voiceAssistantAction(payload)
            if (action === 'duck') {
              // The user only started to talk: lower the voice and keep listening.
              duckQiLing()
              return
            }
            if (action === 'barge_in') {
              // The runtime committed the interruption from a partial transcript.
              // Cancel model, synthesis and queued audio as one step so nothing
              // can revive the line the user just cut off.
              interruptRef.current()
              if (payload.reason === 'narration' || lineRef.current.phase === 'thinking') {
                // The line that was cut off is void: a narration from another
                // client, or the thinking pose of an answer that was cancelled.
                // Never leave the pet holding it; the next question publishes
                // its own line.
                publishLine(idleLine)
              }
              pendingBargeIn = invoke('qiling_voice_barge_in').catch((error: unknown) => {
                console.warn('无法取消被打断的回答', String(error))
              })
              return
            }
            if (action !== 'transcript' || payload.id === undefined || payload.text === undefined) return
            if (handledTranscripts.has(payload.id)) return
            handledTranscripts.add(payload.id)
            if (handledTranscripts.size > 64) {
              const oldest = handledTranscripts.values().next().value
              if (typeof oldest === 'number') handledTranscripts.delete(oldest)
            }
            // A transcript while the pet is still talking is a barge-in: stop the
            // current line first so the reply cannot start over the old audio.
            interruptRef.current()
            const retired = pendingBargeIn
            pendingBargeIn = Promise.resolve()
            const text = payload.text
            void retired
              .then(() => invoke('qiling_voice_assistant_respond', { text }))
              .catch((error: unknown) => {
                console.warn('本机语音对话失败', String(error))
              })
          },
        )
        if (active) unlisten = stop
        else stop()
        if (active && loadQiLingSettings().voiceAssistant) {
          setVoiceAssistantState('starting')
          await invoke('qiling_voice_assistant_start', {
            wakeWord: loadQiLingSettings().wakeWord,
          })
          const revision = stateEventRevision
          const currentState = await invoke<string>('qiling_voice_assistant_status')
          if (active && stateEventRevision === revision) applyState(currentState)
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setVoiceAssistantState('error')
          console.warn('本机语音服务不可用', String(error))
        }
      })
    // A missed event must not leave the pet showing a state the runtime left long
    // ago. The status command reports the process, not the last event.
    const poll = window.setInterval(() => {
      const revision = stateEventRevision
      void invoke<string>('qiling_voice_assistant_status')
        .then((current) => {
          if (active && stateEventRevision === revision) setVoiceAssistantState(current)
        })
        .catch(() => {})
    }, 3_000)
    return () => {
      active = false
      window.clearInterval(poll)
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!inTauri()) return
    publishBubble({
      text: bubbleText,
      voice,
      speaking: speech.speaking,
      open: bubbleOpen && shown && ready,
      name: character.name,
    })
  }, [bubbleText, voice, speech.speaking, bubbleOpen, shown, ready, character.name])

  // Tell the runtime which line the speakers are playing. It keeps recognizing so
  // the user can interrupt, but drops anything that sounds like this line.
  useEffect(() => {
    if (!inTauri()) return
    const text = speech.audibleLine.trim()
    if (speech.audible && text) {
      if (speakingLine.current === text) return
      speakingLine.current = text
      void invoke('qiling_voice_assistant_speaking', { text }).catch(() => {})
      return
    }
    if (!speakingLine.current) return
    speakingLine.current = ''
    void invoke('qiling_voice_assistant_spoken').catch(() => {})
  }, [speech.audible, speech.audibleLine])

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
    if (!beats.some((option) => option.key === beat)) setBeat('breath')
  }, [beats, beat])

  useEffect(() => {
    if (stateId !== 'idle' || forcedTrack) {
      setBeat('breath')
      return
    }
    const breath = beats.find((option) => option.key === 'breath') ?? beats[0]
    if (!breath) return
    const beatMs = (option: IdleBeatOption) =>
      phaseDurationMs(library?.byTag(option.track), 'idle') ?? option.ms ?? 3000
    let timer = 0
    const breathe = () => {
      setBeat('breath')
      timer = window.setTimeout(() => {
        const roll = Math.random()
        const next = character.builtin
          ? beats.find((option) => option.key === pickIdleBeat(roll)) ?? breath
          : pickPackBeat(roll, beats)
        if (next.key === 'breath') {
          breathe()
          return
        }
        setBeat(next.key)
        timer = window.setTimeout(breathe, beatMs(next))
      }, beatMs(breath))
    }
    breathe()
    return () => window.clearTimeout(timer)
  }, [stateId, forcedTrack, library, beats, character.builtin])

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

  // Hiding the pet stops the microphone. Showing it again restores listening when
  // the setting is still on, so the checkbox and the real state cannot drift apart.
  // Only a hide -> show transition starts it; a state change alone cannot loop.
  const lastShown = useRef<boolean | null>(null)
  useEffect(() => {
    if (!inTauri() || !ready) return
    const previous = lastShown.current
    lastShown.current = shown
    if (previous !== false || !shown) return
    if (!loadQiLingSettings().voiceAssistant || startingAssistant.current) return
    startingAssistant.current = true
    setVoiceAssistantState('starting')
    void invoke('qiling_voice_assistant_start', {
      wakeWord: loadQiLingSettings().wakeWord,
    })
      .catch((error: unknown) => {
        setVoiceAssistantState('error')
        console.warn('显示器灵后无法恢复唤醒监听', String(error))
      })
      .finally(() => {
        startingAssistant.current = false
      })
  }, [shown, ready])

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
    // Hiding is not "turn the wake word off": keep the preference so showing the
    // pet again restores listening.
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
            name={character.name}
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
              alt={forcedTrack?.displayName ?? `${character.name}，${state.label}`}
              draggable={false}
              className="pet-arrive"
            />
          )}
        </div>
      </div>
      {inTauri() && voiceAssistantState !== 'stopped' && (
        <div
          className={`voice-assistant-indicator is-${voiceAssistantState}`}
          role="status"
          aria-live="polite"
        >
          {voiceAssistantStateLabel(voiceAssistantState)}
        </div>
      )}
    </div>
  )
}
