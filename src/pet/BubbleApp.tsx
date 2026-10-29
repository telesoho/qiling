import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { closeSpeechBubble, loadQiLingSettings, saveQiLingSettings } from '../lib/settings'
import { PetSpeechBubble } from './PetControls'
import { readBubble, subscribeBubble, type BubbleSnap } from './bubbleSync'
import { inTauri, petWindowIsOpen, subscribePet } from './sync'

export default function BubbleApp(): JSX.Element {
  const [snap, setSnap] = useState<BubbleSnap>(readBubble)
  const [petOpen, setPetOpen] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const sent = useRef('')
  const visible = snap.open && petOpen

  useEffect(() => subscribeBubble(setSnap), [])

  useEffect(() => {
    return subscribePet((message) => {
      if (message.type === 'visibility') setPetOpen(message.open)
    })
  }, [])

  useEffect(() => {
    if (!inTauri()) return
    let alive = true
    petWindowIsOpen()
      .then((open) => {
        if (alive) setPetOpen(open)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useLayoutEffect(() => {
    if (!inTauri()) return
    if (!visible) {
      if (sent.current === 'closed') return
      sent.current = 'closed'
      void invoke('bubble_present', { open: false, width: 0, height: 0 })
      return
    }
    const node = frame.current
    if (!node) return
    const width = Math.ceil(node.offsetWidth)
    const height = Math.ceil(node.offsetHeight)
    const key = `${width}x${height}`
    if (sent.current === key || width < 1 || height < 1) return
    sent.current = key
    void invoke('bubble_present', { open: true, width, height })
  }, [visible, snap.text, snap.speaking, snap.voice])

  if (!visible) return <div />

  return (
    <div className="pet-bubble-window" ref={frame}>
      <PetSpeechBubble
        windowed
        text={snap.text}
        voiceOn={snap.voice}
        speaking={snap.speaking}
        onToggleVoice={() => {
          if (snap.speaking && snap.voice) {
            void emit('qiling-interrupt')
            return
          }
          saveQiLingSettings({ ...loadQiLingSettings(), voice: !snap.voice })
        }}
        onCollapse={() => closeSpeechBubble()}
      />
    </div>
  )
}
