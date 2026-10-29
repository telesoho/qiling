import { useEffect, useRef, useState } from 'react'
import { QiLingPhase } from './phase'

export interface VoiceChoice {
  lang: string
  name: string
}

export type LocalSpeakResult = 'played' | 'cancelled' | 'failed' | 'unavailable'

/**
 * Prefer a zh-CN system voice when CosyVoice is not available.
 * Huihui / Yaoyao are only preferred when the OS already installed them.
 */
export function pickChineseVoice<T extends VoiceChoice>(voices: readonly T[]): T | null {
  const langOf = (voice: T) => voice.lang.toLowerCase().replace('_', '-')
  const chinese = voices.filter((voice) => langOf(voice).startsWith('zh'))
  const mainland = chinese.filter((voice) => langOf(voice).startsWith('zh-cn'))
  const pool = mainland.length > 0 ? mainland : chinese
  const female = pool.find((voice) => /huihui|yaoyao|hanhan|female|女/i.test(voice.name))
  return female ?? pool[0] ?? null
}

export function planUtterance(input: {
  voice: boolean
  visible: boolean
  phase: QiLingPhase
  text: string
  handled: string
}): { action: 'speak' | 'stop' | 'keep'; line: string } {
  const line = input.text.trim()
  const settled = input.phase === 'ready' || input.phase === 'fallback'
  if (!input.voice || !input.visible || !settled || !line) return { action: 'stop', line: '' }
  if (input.handled === line) return { action: 'keep', line }
  return { action: 'speak', line }
}

/** CosyVoice is primary only when the local service health check says it is ready. */
export function voiceEngineFor(status: { ready?: boolean } | null | undefined): 'cosyvoice' | 'system' {
  return status?.ready ? 'cosyvoice' : 'system'
}

export function voiceEngineLabel(engine: 'cosyvoice' | 'system'): '本地神经音' | '系统音' {
  return engine === 'cosyvoice' ? '本地神经音' : '系统音'
}

/** A cancelled local utterance must not continue on the system voice. */
export function fallbackToSystem(result: LocalSpeakResult): boolean {
  return result === 'failed' || result === 'unavailable'
}

/** Reveal `line` in step with playback. One code point per step, so a Chinese character is one cell. */
export function captionAt(line: string, elapsed: number, duration: number, started: boolean): string {
  const chars = Array.from(line)
  if (!started || chars.length === 0) return ''
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(elapsed)) return chars[0]
  const ratio = Math.min(1, Math.max(0, elapsed / duration))
  const count = Math.min(chars.length, Math.max(1, Math.ceil(ratio * chars.length)))
  return chars.slice(0, count).join('')
}

/** Place the next PCM buffer against the previous one. A late chunk still starts at `now`. */
export function schedulePcmChunk(cursor: number, now: number, duration: number): { start: number; next: number } {
  const start = Math.max(cursor, now)
  return { start, next: start + Math.max(0, duration) }
}

/**
 * System voice only if nothing from CosyVoice was heard.
 * Audio already queued should finish; the same sentence must not be spoken twice.
 */
export function streamSpeakResult(input: {
  chunks: number
  error?: 'cancelled' | 'failed' | 'unavailable' | null
}): LocalSpeakResult {
  if (input.chunks > 0) return 'played'
  if (input.error === 'cancelled') return 'cancelled'
  if (input.error === 'unavailable') return 'unavailable'
  return 'failed'
}

export interface VoiceRoute {
  engine: 'cosyvoice' | 'system'
  detail: string
}

const SYSTEM_DETAIL = '本机 CosyVoice 服务没接上，先用系统语音。'
const FALLBACK_DETAIL = '本地合成这次没成功，先改用系统语音。重启识局会再探测本机服务。'

type BoundaryEvent = { charIndex?: number; charLength?: number }

type UtteranceLike = {
  text: string
  lang: string
  voice: SpeechSynthesisVoice | null
  rate: number
  onstart: (() => void) | null
  onboundary: ((event: BoundaryEvent) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}

interface SpeechEngine {
  getVoices(): VoiceChoice[]
  cancel(): void
  speak(utterance: UtteranceLike): void
  resume?: () => void
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

interface LocalVoiceStatus {
  ready?: boolean
  detail?: string
}

interface PcmChunk {
  sampleRate: number
  pcmBase64: string
}

let token = 0
let speaking = false
let pending = false
let needsGap = false
let player: HTMLAudioElement | null = null
let finishPlay: ((result: 'played' | 'cancelled' | 'failed') => void) | null = null
let streamStop: (() => void) | null = null
let routeMemo: VoiceRoute | null = null
let caption = ''
let captionLine = ''
let activeLine = ''
let captionFrame = 0
let captionTimer = 0
let audible = false
let audibleLine = ''
let heardLine = ''
const listeners = new Set<(value: boolean) => void>()
const captionListeners = new Set<(value: { line: string; text: string }) => void>()
const mouthListeners = new Set<(value: { audible: boolean; audibleLine: string; heardLine: string }) => void>()

// ponytail: fixed rate until a boundary event; per-voice timing if the estimate drifts
const SYSTEM_CHARS_PER_SEC = 5

function setSpeaking(next: boolean): void {
  if (speaking === next) return
  speaking = next
  listeners.forEach((listener) => listener(next))
}

function setCaption(next: string): void {
  if (captionLine === activeLine && caption === next) return
  captionLine = activeLine
  caption = next
  const snapshot = { line: captionLine, text: caption }
  captionListeners.forEach((listener) => listener(snapshot))
}

function emitMouth(): void {
  const snapshot = { audible, audibleLine, heardLine }
  mouthListeners.forEach((listener) => listener(snapshot))
}

function setAudible(next: boolean): void {
  const line = next ? activeLine : ''
  if (audible === next && audibleLine === line) return
  audible = next
  audibleLine = line
  emitMouth()
}

function setHeard(next: string): void {
  if (heardLine === next) return
  heardLine = next
  emitMouth()
}

/** Heard first, then silence, so a finished line does not flash back to thinking. */
function finishLine(line: string): void {
  if (line) setHeard(line)
  setAudible(false)
}

function clearCaptionClock(): void {
  if (captionFrame) {
    cancelAnimationFrame(captionFrame)
    captionFrame = 0
  }
  if (captionTimer) {
    clearTimeout(captionTimer)
    captionTimer = 0
  }
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
}

function engine(): SpeechEngine | null {
  if (typeof window === 'undefined' || !window.speechSynthesis) return null
  return window.speechSynthesis as unknown as SpeechEngine
}

function makeUtterance(line: string, voice: SpeechSynthesisVoice | null): UtteranceLike {
  if (typeof SpeechSynthesisUtterance === 'undefined') {
    return {
      text: line,
      lang: 'zh-CN',
      voice,
      rate: 1,
      onstart: null,
      onboundary: null,
      onend: null,
      onerror: null,
    }
  }
  const utter = new SpeechSynthesisUtterance(line)
  utter.lang = 'zh-CN'
  utter.rate = 1
  if (voice) {
    try {
      utter.voice = voice
    } catch {
      // A voice the engine rejects must not swallow the line. lang still asks for Chinese.
    }
  }
  return utter as unknown as UtteranceLike
}

function classifyLocalError(error: unknown): 'cancelled' | 'unavailable' | 'failed' {
  const text = String(error)
  if (text.includes('cancelled') || text.includes('canceled')) return 'cancelled'
  if (text.includes('unavailable:')) return 'unavailable'
  return 'failed'
}

export function noteVoiceFallback(): void {
  routeMemo = { engine: 'system', detail: FALLBACK_DETAIL }
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('qiling-voice-fallback'))
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit('qiling-voice-route', { engine: 'system' }))
    .catch(() => {})
}

async function cancelCosyVoice(): Promise<void> {
  if (!inTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('qiling_voice_cancel')
  } catch {
    // The local service is optional. Missing it is the system-voice path.
  }
}

export async function loadVoiceRoute(): Promise<VoiceRoute> {
  if (routeMemo) return routeMemo
  if (!inTauri()) {
    routeMemo = { engine: 'system', detail: SYSTEM_DETAIL }
    return routeMemo
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const status = await invoke<LocalVoiceStatus>('qiling_voice_status')
    routeMemo = {
      engine: voiceEngineFor(status),
      detail: status?.detail || SYSTEM_DETAIL,
    }
  } catch {
    routeMemo = { engine: 'system', detail: SYSTEM_DETAIL }
  }
  return routeMemo
}

function stopAudio(): void {
  const stopStream = streamStop
  streamStop = null
  stopStream?.()
  const current = player
  const finish = finishPlay
  player = null
  finishPlay = null
  finish?.('cancelled')
  if (!current) return
  current.onended = null
  current.onerror = null
  current.pause()
  const src = current.src
  current.removeAttribute('src')
  try {
    current.load()
  } catch {
    // ignore
  }
  if (src.startsWith('blob:')) URL.revokeObjectURL(src)
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return buffer
}

function pcm16ToFloat(pcm: ArrayBuffer): Float32Array {
  const view = new DataView(pcm)
  const samples = Math.floor(pcm.byteLength / 2)
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i += 1) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

function startPcmStream(line: string, mine: number): {
  started: boolean
  push: (chunk: PcmChunk) => void
  finish: () => Promise<'played' | 'cancelled' | 'failed'>
  stop: () => void
} {
  const playback = {
    started: false,
    push(_chunk: PcmChunk) {},
    finish: (): Promise<'played' | 'cancelled' | 'failed'> => Promise.resolve('failed'),
    stop() {},
  }
  if (typeof AudioContext === 'undefined') return playback
  let closed = false
  let streamEnded = false
  let cursor = 0
  let origin = 0
  let scheduled = 0
  const sources: AudioBufferSourceNode[] = []
  let ctx: AudioContext | null = null
  let resolveDone: (result: 'played' | 'cancelled' | 'failed') => void = () => {}
  const done = new Promise<'played' | 'cancelled' | 'failed'>((resolve) => {
    resolveDone = resolve
  })
  let settled = false
  const settle = (result: 'played' | 'cancelled' | 'failed') => {
    if (settled) return
    settled = true
    closed = true
    clearCaptionClock()
    if (streamStop) streamStop = null
    if (mine === token && result === 'played') {
      setCaption(line)
      pending = false
      setSpeaking(false)
      finishLine(line)
    }
    resolveDone(result)
  }
  const paint = () => {
    if (!ctx || !playback.started || settled || mine !== token) return
    const elapsed = Math.max(0, ctx.currentTime - origin)
    const duration = Math.max(scheduled, 0.001)
    setCaption(captionAt(line, elapsed, duration, true))
  }
  const loop = () => {
    captionFrame = 0
    paint()
    if (settled || mine !== token || !ctx) return
    if (streamEnded && ctx.currentTime + 0.02 >= origin + scheduled) {
      settle('played')
      return
    }
    captionFrame = requestAnimationFrame(loop)
  }
  playback.push = (chunk) => {
    if (closed || mine !== token) return
    let floats: Float32Array
    try {
      floats = pcm16ToFloat(decodeBase64(chunk.pcmBase64))
    } catch {
      return
    }
    if (floats.length === 0 || !(chunk.sampleRate > 0)) return
    try {
      if (!ctx) {
        ctx = new AudioContext({ sampleRate: chunk.sampleRate })
        cursor = ctx.currentTime
        origin = cursor
      }
      const buffer = ctx.createBuffer(1, floats.length, chunk.sampleRate)
      buffer.getChannelData(0).set(floats)
      const slot = schedulePcmChunk(cursor, ctx.currentTime, buffer.duration)
      cursor = slot.next
      scheduled = cursor - origin
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start(slot.start)
      sources.push(source)
      if (!playback.started) {
        playback.started = true
        needsGap = false
        setSpeaking(true)
        setAudible(true)
        captionFrame = requestAnimationFrame(loop)
      }
    } catch {
      // A chunk the device rejects must not swallow the rest of the sentence.
    }
  }
  playback.finish = () => {
    streamEnded = true
    if (!playback.started) settle('failed')
    else if (ctx && ctx.currentTime + 0.02 >= origin + scheduled) settle('played')
    else if (!captionFrame) captionFrame = requestAnimationFrame(loop)
    return done
  }
  playback.stop = () => {
    for (const source of sources) {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
    sources.length = 0
    const current = ctx
    ctx = null
    if (current) void current.close().catch(() => {})
    settle('cancelled')
  }
  return playback
}

async function tryCosyVoice(line: string, mine: number): Promise<LocalSpeakResult> {
  const route = await loadVoiceRoute()
  if (mine !== token) return 'cancelled'
  if (route.engine !== 'cosyvoice') return 'unavailable'
  await cancelCosyVoice()
  if (mine !== token) return 'cancelled'
  const playback = startPcmStream(line, mine)
  streamStop = () => playback.stop()
  try {
    const { Channel, invoke } = await import('@tauri-apps/api/core')
    const onChunk = new Channel<PcmChunk>()
    onChunk.onmessage = (chunk) => playback.push(chunk)
    await invoke('qiling_voice_synthesize', { text: line, onChunk })
    if (mine !== token) return 'cancelled'
    const outcome = streamSpeakResult({ chunks: playback.started ? 1 : 0, error: null })
    if (!playback.started) {
      streamStop = null
      return outcome
    }
    return await playback.finish()
  } catch (error) {
    if (mine !== token) return 'cancelled'
    const kind = classifyLocalError(error)
    if (playback.started) return playback.finish()
    streamStop = null
    if (kind === 'cancelled') return 'cancelled'
    noteVoiceFallback()
    return streamSpeakResult({ chunks: 0, error: kind })
  }
}

function beginSystemUtterance(line: string, mine: number): void {
  if (mine !== token) return
  const current = engine()
  if (!current) {
    pending = false
    setSpeaking(false)
    setCaption(line)
    finishLine(line)
    return
  }
  needsGap = false
  const voices = current.getVoices() as Array<VoiceChoice & SpeechSynthesisVoice>
  const chosen = pickChineseVoice(voices)
  const utter = makeUtterance(line, (chosen as SpeechSynthesisVoice | undefined) ?? null)
  let sawBoundary = false
  utter.onstart = () => {
    if (mine !== token) return
    setSpeaking(true)
    setAudible(true)
    if (sawBoundary) return
    clearCaptionClock()
    const duration = Math.max(Array.from(line).length, 1) / SYSTEM_CHARS_PER_SEC
    const origin = performance.now()
    const tick = () => {
      if (mine !== token || sawBoundary) return
      setCaption(captionAt(line, (performance.now() - origin) / 1000, duration, true))
      captionTimer = window.setTimeout(tick, 80)
    }
    tick()
  }
  utter.onboundary = (event) => {
    if (mine !== token) return
    sawBoundary = true
    clearCaptionClock()
    const index = event?.charIndex ?? 0
    const length = event?.charLength ?? 0
    const end = Math.min(line.length, Math.max(1, index + length))
    setCaption(line.slice(0, end))
  }
  utter.onend = () => {
    if (mine !== token) return
    clearCaptionClock()
    setCaption(line)
    pending = false
    setSpeaking(false)
    finishLine(line)
  }
  utter.onerror = (event) => {
    if (event?.error === 'interrupted' || event?.error === 'canceled') return
    if (mine !== token) return
    clearCaptionClock()
    setCaption(line)
    pending = false
    setSpeaking(false)
    finishLine(line)
  }
  try {
    current.resume?.()
    current.speak(utter)
    setSpeaking(true)
  } catch {
    clearCaptionClock()
    pending = false
    setSpeaking(false)
    setCaption(line)
    finishLine(line)
  }
}

function speakSystem(line: string, mine: number): void {
  const synth = engine()
  if (!synth || mine !== token) {
    if (mine === token) {
      pending = false
      setSpeaking(false)
      setCaption(line)
      finishLine(line)
    }
    return
  }
  const start = () => beginSystemUtterance(line, mine)
  const kick = () => window.setTimeout(start, needsGap ? 60 : 0)
  if (synth.getVoices().length > 0) {
    kick()
    return
  }
  const onVoices = () => {
    synth.removeEventListener?.('voiceschanged', onVoices)
    kick()
  }
  synth.addEventListener?.('voiceschanged', onVoices)
  try {
    synth.getVoices()
  } catch {
    // ignore
  }
  window.setTimeout(() => {
    synth.removeEventListener?.('voiceschanged', onVoices)
    kick()
  }, 300)
}

async function runSpeak(line: string, mine: number): Promise<void> {
  const local = await tryCosyVoice(line, mine)
  if (mine !== token) return
  if (!fallbackToSystem(local)) return
  speakSystem(line, mine)
}

/** Read one settled line. CosyVoice 3 when the local service is healthy, otherwise the system voice. */
export function speakQiLing(text: string): void {
  const line = text.trim()
  if (!line || (!inTauri() && !engine())) {
    if (line) activeLine = line
    stopQiLing()
    return
  }
  const restarting = pending || speaking || player !== null || streamStop !== null || needsGap
  const mine = ++token
  pending = true
  activeLine = line
  clearCaptionClock()
  setCaption('')
  setHeard('')
  setAudible(false)
  setSpeaking(true)
  if (restarting) {
    needsGap = true
    stopAudio()
    try {
      engine()?.cancel()
    } catch {
      // ignore engines that throw on cancel
    }
    void cancelCosyVoice()
  }
  void runSpeak(line, mine)
}

export function stopQiLing(): void {
  token += 1
  const line = activeLine
  const active = pending || speaking || player !== null || streamStop !== null
  clearCaptionClock()
  pending = false
  setSpeaking(false)
  stopAudio()
  if (line) setCaption(line)
  if (active && line) setHeard(line)
  setAudible(false)
  if (!active) return
  needsGap = true
  try {
    engine()?.cancel()
  } catch {
    // ignore
  }
  void cancelCosyVoice()
}

export function subscribeQiLingSpeaking(onChange: (speaking: boolean) => void): () => void {
  listeners.add(onChange)
  onChange(speaking)
  return () => {
    listeners.delete(onChange)
  }
}

function subscribeQiLingCaption(onChange: (caption: { line: string; text: string }) => void): () => void {
  captionListeners.add(onChange)
  onChange({ line: captionLine, text: caption })
  return () => {
    captionListeners.delete(onChange)
  }
}

function subscribeMouth(
  onChange: (value: { audible: boolean; audibleLine: string; heardLine: string }) => void,
): () => void {
  mouthListeners.add(onChange)
  onChange({ audible, audibleLine, heardLine })
  return () => {
    mouthListeners.delete(onChange)
  }
}

/** Speak a settled line while the pet is visible and voice is on. Repeats are ignored. */
export function usePetSpeech(input: {
  voice: boolean
  visible: boolean
  phase: QiLingPhase
  text: string
}): {
  speaking: boolean
  caption: string
  captionLine: string
  audible: boolean
  audibleLine: string
  heardLine: string
  interrupt: () => void
} {
  const handled = useRef('')
  const textRef = useRef(input.text)
  textRef.current = input.text
  const [speakingNow, setSpeakingNow] = useState(false)
  const [captionNow, setCaptionNow] = useState({ line: '', text: '' })
  const [mouth, setMouth] = useState({ audible: false, audibleLine: '', heardLine: '' })

  useEffect(() => {
    const stopSpeaking = subscribeQiLingSpeaking(setSpeakingNow)
    const stopCaption = subscribeQiLingCaption(setCaptionNow)
    const stopMouth = subscribeMouth(setMouth)
    return () => {
      stopSpeaking()
      stopCaption()
      stopMouth()
    }
  }, [])

  useEffect(() => {
    const plan = planUtterance({
      voice: input.voice,
      visible: input.visible,
      phase: input.phase,
      text: input.text,
      handled: handled.current,
    })
    if (plan.action === 'speak') {
      handled.current = plan.line
      speakQiLing(plan.line)
    } else if (plan.action === 'stop') {
      const line = input.text.trim()
      const settled = input.phase === 'ready' || input.phase === 'fallback'
      if (settled && line) handled.current = line
      else if (!line) handled.current = ''
      stopQiLing()
      if (!line) setHeard('')
    }
    return () => {
      // Dev Strict Mode replays effects. Drop the claim so the replay can speak.
      if (plan.action === 'speak') handled.current = ''
    }
  }, [input.voice, input.visible, input.phase, input.text])

  useEffect(() => () => stopQiLing(), [])

  const interrupt = () => {
    const line = textRef.current.trim()
    if (line) handled.current = line
    stopQiLing()
  }

  return {
    speaking: speakingNow,
    caption: captionNow.text,
    captionLine: captionNow.line,
    audible: mouth.audible,
    audibleLine: mouth.audibleLine,
    heardLine: mouth.heardLine,
    interrupt,
  }
}
