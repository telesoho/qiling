/**
 * 曲库播放引擎。
 *
 * 常驻桌宠窗口（窗口隐藏也不会被销毁），因此关闭曲库窗口后音乐继续播放。
 * 播放走 `<audio>` + MediaElementSource，能量用 AnalyserNode 实时读取，
 * 节拍用临时 16kHz 上下文离线估速后生成网格。
 *
 * 这里不碰 React：状态通过 `deps.emit` / `deps.onSense` 交给 hook 与曲库窗口。
 */
import {
  beginMoodGate,
  chooseMusicMood,
  gateMusicMood,
  mixMusicEnergy,
  smoothMusicEnergy,
  type MoodGate,
  type MusicMood,
  type MusicTuning,
} from './music'
import { analyseLocalTempo, TEMPO_ANALYSIS_SECONDS } from './localBeat'
import { beatBpm, BeatTracker, cleanBeatTimes } from './rhythm'
import {
  clampVolume,
  DEFAULT_MUSIC_VOLUME,
  loadPlayerState,
  MUSIC_PROGRESS_EVENT,
  MUSIC_STATE_EVENT,
  savePlayerState,
  type LocalMusicCommand,
  type LocalMusicState,
  type LocalMusicStatus,
} from './localMusic'
import {
  mimeForTrack,
  musicErrorMessage,
  type MusicLibraryView,
  type MusicTrackView,
} from './musicLibrary'

export interface LocalMusicPlayerDeps {
  readTrackAudio: (id: string) => Promise<ArrayBuffer>
  loadLibrary: () => Promise<MusicLibraryView>
  emit: (event: string, payload?: unknown) => void
  onSense: (sense: {
    active: boolean
    mood: MusicMood | null
    energy: number
    bass: number
    bpm: number
    beatAt: number
    nextBeatMs: number
  }) => void
  getTuning: () => MusicTuning
  now: () => number
}

/** 解码后超过 10 分钟就不播：整段 AudioBuffer 会占掉数百 MB。 */
const MAX_TRACK_SECONDS = 10 * 60
const TICK_MS = 25
const PROGRESS_MS = 400

export class LocalMusicPlayer {
  private readonly deps: LocalMusicPlayerDeps
  private audio: HTMLAudioElement | null = null
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private frequency: Uint8Array<ArrayBuffer> | null = null
  private waveform: Float32Array<ArrayBuffer> | null = null
  private objectUrl = ''
  private current: { id: string; name: string; mime: string } | null = null
  private status: LocalMusicStatus = 'idle'
  private error = ''
  private volume = DEFAULT_MUSIC_VOLUME
  private durationSec = 0
  private bpm = 0
  /** 逐拍游标：优先使用 libsonare 检测到的拍点，用完后按中位拍长继续。 */
  private readonly tracker = new BeatTracker()
  private lastPosition = 0
  private lastTickAt = 0
  private mood: MusicMood | null = null
  private energy = 0
  private bass = 0
  private gate: MoodGate = beginMoodGate(0)
  private beatAt = 0
  private nextBeatMs = 0
  private generation = 0
  private mediaGeneration = 0
  private ticker = 0
  private progressAt = 0
  private tuning: MusicTuning
  private disposed = false

  constructor(deps: LocalMusicPlayerDeps) {
    this.deps = deps
    this.tuning = deps.getTuning()
    this.volume = clampVolume(loadPlayerState().volume)
    this.gate = beginMoodGate(deps.now())
  }

  setTuning(tuning: MusicTuning): void {
    this.tuning = tuning
  }

  handleCommand(command: LocalMusicCommand): void {
    switch (command.type) {
      case 'play':
        void this.playFromLibrary()
        break
      case 'playTrack':
        void this.playTrack(command.id)
        break
      case 'pause':
        this.pause()
        break
      case 'toggle':
        this.toggle()
        break
      case 'stop':
        this.stop()
        break
      case 'next':
        void this.skip(1)
        break
      case 'previous':
        void this.skip(-1)
        break
      case 'seek':
        this.seek(command.position)
        break
      case 'volume':
        this.setVolume(command.volume)
        break
      case 'requestState':
        this.publishState()
        this.emitProgress()
        break
    }
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.stopTicker()
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = ''
    }
    if (this.context && this.context.state !== 'closed') {
      void this.context.close().catch(() => {})
    }
    this.audio = null
    this.context = null
    this.analyser = null
    this.gain = null
    this.frequency = null
    this.waveform = null
    this.status = 'idle'
    this.mood = null
    this.energy = 0
    this.bass = 0
  }

  private async playFromLibrary(): Promise<void> {
    const generation = ++this.generation
    try {
      const library = await this.deps.loadLibrary()
      if (generation !== this.generation || this.disposed) return
      const track = this.chooseDefaultTrack(library)
      if (!track) {
        this.failIfCurrent(generation, 'music_library_empty')
        return
      }
      await this.loadTrack(track, 0)
    } catch (error) {
      this.failIfCurrent(generation, error)
    }
  }

  private async playTrack(id: string): Promise<void> {
    const generation = ++this.generation
    try {
      const library = await this.deps.loadLibrary()
      if (generation !== this.generation || this.disposed) return
      const track = library.tracks.find((item) => item.id === id)
      if (!track) {
        this.failIfCurrent(generation, 'music_track_missing')
        return
      }
      await this.loadTrack(track, 0)
    } catch (error) {
      this.failIfCurrent(generation, error)
    }
  }

  private chooseDefaultTrack(library: MusicLibraryView): MusicTrackView | null {
    const stored = loadPlayerState().currentId
    return (
      library.tracks.find((item) => item.id === stored) ??
      library.tracks[0] ??
      null
    )
  }

  private async skip(direction: 1 | -1): Promise<void> {
    const generation = ++this.generation
    try {
      const library = await this.deps.loadLibrary()
      if (generation !== this.generation || this.disposed) return
      if (library.tracks.length === 0) {
        this.failIfCurrent(generation, 'music_library_empty')
        return
      }
      const index = library.tracks.findIndex((item) => item.id === this.current?.id)
      const base = index < 0 ? -1 : index
      const next = base + direction
      if (next < 0) {
        await this.loadTrack(library.tracks[0], 0)
        return
      }
      if (next >= library.tracks.length) {
        this.stop()
        return
      }
      await this.loadTrack(library.tracks[next], 0)
    } catch (error) {
      this.failIfCurrent(generation, error)
    }
  }

  private async loadTrack(track: MusicTrackView, startAt: number): Promise<void> {
    const generation = ++this.generation
    this.mediaGeneration = generation
    this.status = 'loading'
    this.error = ''
    this.durationSec = 0
    this.bpm = 0
    this.tracker.setRhythm(0, [])
    this.energy = 0
    this.bass = 0
    this.mood = null
    this.lastPosition = 0
    this.lastTickAt = 0
    this.gate = beginMoodGate(this.deps.now())
    this.current = { id: track.id, name: track.name, mime: mimeForTrack(track) }
    this.stopTicker()
    this.emitSense()
    this.publishState()

    try {
      const bytes = await this.deps.readTrackAudio(track.id)
      if (generation !== this.generation || this.disposed) return

      let mime = this.current?.mime ?? ''
      if (!mime) {
        // 网络歌曲第一次下载后由后端回填 MIME，重新取一次曲库再建 Blob。
        const library = await this.deps.loadLibrary().catch(() => null)
        if (generation !== this.generation || this.disposed) return
        const fresh = library?.tracks.find((item) => item.id === track.id)
        mime = fresh ? mimeForTrack(fresh) : ''
      }
      const blob = mime ? new Blob([bytes], { type: mime }) : new Blob([bytes])
      this.replaceObjectUrl(URL.createObjectURL(blob))

      const audio = this.ensureAudioElement()
      audio.pause()
      const duration = await loadAudioMetadata(audio, this.objectUrl)
      if (generation !== this.generation || this.disposed) return
      if (!Number.isFinite(duration) || duration <= 0) {
        throw 'music_decode_failed'
      }
      if (duration > MAX_TRACK_SECONDS) {
        throw 'music_too_long'
      }
      this.durationSec = duration
      this.current = { id: track.id, name: track.name, mime }
      // 先分析节拍再起播：分析约几百毫秒，放在 playing 之前，避免跟着音乐播放
      // 在动画中途卡一下；失败也不阻塞播放（按 96 备用拍）。
      this.publishState()
      await this.analyseRhythm(bytes, duration, generation)
      if (generation !== this.generation || this.disposed) return
      savePlayerState({ version: 1, currentId: track.id, volume: this.volume })

      await this.startPlayback(generation, Math.min(startAt, Math.max(0, duration - 0.01)))
      if (generation !== this.generation || this.disposed) return
      this.status = 'playing'
      this.error = ''
      this.startTicker()
      this.publishState()
      this.emitProgress()
    } catch (error) {
      if (generation !== this.generation || this.disposed) return
      this.fail(error)
    }
  }

  private async startPlayback(generation: number, offset: number): Promise<void> {
    const audio = this.ensureAudioElement()
    const context = this.ensureAudioGraph()
    if (context.state === 'suspended') {
      try {
        await context.resume()
      } catch {
        throw 'music_audio_blocked'
      }
    }
    if (generation !== this.generation || this.disposed) return
    try {
      audio.currentTime = Math.max(0, offset)
    } catch {
      // 元数据尚未就绪时交给 play() 报错。
    }
    if (this.gain) this.gain.gain.value = this.volume
    this.resetBeats(Math.max(0, offset))
    this.lastPosition = Math.max(0, offset)
    this.lastTickAt = 0
    try {
      await audio.play()
    } catch (error) {
      throw playError(error)
    }
  }

  private pause(): void {
    if (this.status === 'loading') {
      this.stop()
      return
    }
    if (this.status !== 'playing') return
    this.audio?.pause()
    this.status = 'paused'
    this.mood = null
    this.energy = 0
    this.bass = 0
    this.gate = beginMoodGate(this.deps.now())
    this.stopTicker()
    this.emitSense()
    this.publishState()
    this.emitProgress()
  }

  private resume(): void {
    if (this.status === 'idle' || this.status === 'error') {
      void this.playFromLibrary()
      return
    }
    if (this.status !== 'paused' || !this.audio) return
    const generation = this.generation
    this.gate = beginMoodGate(this.deps.now())
    this.lastTickAt = 0
    this.resetBeats(this.audio.currentTime)
    const context = this.context
    if (context && context.state === 'suspended') {
      void context.resume().catch(() => {})
    }
    this.audio
      .play()
      .then(() => {
        if (generation !== this.generation || this.disposed) return
        this.status = 'playing'
        this.error = ''
        this.startTicker()
        this.publishState()
      })
      .catch((error) => {
        if (generation !== this.generation || this.disposed) return
        this.fail(playError(error))
      })
  }

  private toggle(): void {
    if (this.status === 'playing') {
      this.pause()
    } else if (this.status === 'paused') {
      this.resume()
    } else if (this.status === 'idle' || this.status === 'error') {
      void this.playFromLibrary()
    }
  }

  private stop(): void {
    this.generation += 1
    this.mediaGeneration = this.generation
    this.stopTicker()
    if (this.audio) {
      this.audio.pause()
      try {
        this.audio.currentTime = 0
      } catch {
        // 忽略：下一次加载会重新设置 src。
      }
    }
    this.status = 'idle'
    this.error = ''
    this.mood = null
    this.energy = 0
    this.bass = 0
    this.gate = beginMoodGate(this.deps.now())
    this.emitSense()
    this.publishState()
    this.emitProgress()
  }

  private seek(position: number): void {
    if (!this.audio || this.status === 'loading' || this.status === 'idle') return
    const target = Math.max(0, Math.min(position, this.durationSec || position))
    try {
      this.audio.currentTime = target
    } catch {
      return
    }
    this.energy = 0
    this.bass = 0
    this.lastPosition = target
    this.resetBeats(target)
    this.emitProgress()
    this.publishState()
  }

  private setVolume(volume: number): void {
    this.volume = clampVolume(volume)
    if (this.gain) this.gain.gain.value = this.volume
    savePlayerState({
      version: 1,
      currentId: this.current?.id ?? null,
      volume: this.volume,
    })
    this.publishState()
  }

  private handleEnded(): void {
    if (this.disposed) return
    if (this.status !== 'playing') return
    if (this.mediaGeneration !== this.generation) return
    void this.skip(1)
  }

  private startTicker(): void {
    this.stopTicker()
    this.progressAt = this.deps.now()
    this.ticker = window.setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicker(): void {
    if (this.ticker) {
      window.clearInterval(this.ticker)
      this.ticker = 0
    }
  }

  private tick(): void {
    if (this.disposed || this.status !== 'playing') return
    const position = this.position()
    if (position < this.lastPosition - 0.5) this.resetBeats(position)
    this.lastPosition = position
    this.updateEnergy()
    this.updateBeats(position)
    this.emitSense()
    const now = this.deps.now()
    if (now - this.progressAt >= PROGRESS_MS) {
      this.progressAt = now
      this.emitProgress()
    }
  }

  private updateEnergy(): void {
    const analyser = this.analyser
    const frequency = this.frequency
    const waveform = this.waveform
    const context = this.context
    if (!analyser || !frequency || !waveform || !context) return
    analyser.getByteFrequencyData(frequency)
    analyser.getFloatTimeDomainData(waveform)
    const hzPerBin = context.sampleRate / analyser.fftSize
    const bass = bandEnergy(frequency, 35, 160, hzPerBin)
    const mid = bandEnergy(frequency, 160, 1800, hzPerBin)
    let squareSum = 0
    for (let index = 0; index < waveform.length; index += 1) {
      squareSum += waveform[index] * waveform[index]
    }
    const rms = Math.sqrt(squareSum / waveform.length)
    this.bass = bass
    const target = mixMusicEnergy(bass, mid, rms)
    const now = this.deps.now()
    const dt =
      this.lastTickAt > 0
        ? Math.min(0.05, Math.max(0.001, (now - this.lastTickAt) / 1000))
        : TICK_MS / 1000
    this.lastTickAt = now
    this.energy = smoothMusicEnergy(this.energy, target, dt)
    const raw = chooseMusicMood(this.gate.mood, this.energy, true, this.tuning)
    this.gate = gateMusicMood(this.gate, raw, now)
    if (this.gate.mood !== this.mood) {
      this.mood = this.gate.mood
      this.publishState()
    }
  }

  private updateBeats(position: number): void {
    if (this.tracker.update(position)) this.beatAt = this.deps.now()
    this.nextBeatMs = this.tracker.nextBeatMs
  }

  private resetBeats(position: number): void {
    this.tracker.reset(position)
    this.nextBeatMs = this.tracker.nextBeatMs
  }

  /**
   * 节拍分析：与设计原型同一套 libsonare `analyzeBpm` + `detectBeats`。
   * 分析在起播前完成；失败时退回轻量估速，仍失败就按 96 备用拍播放。
   */
  private async analyseRhythm(
    bytes: ArrayBuffer,
    durationSec: number,
    generation: number,
  ): Promise<void> {
    let mono: Float32Array | null = null
    try {
      mono = await decodeMonoAt16k(bytes)
    } catch {
      mono = null
    }
    if (!mono || generation !== this.generation || this.disposed) return
    let bpm = 0
    let beats: number[] = []
    try {
      const { analyseLocalRhythm } = await import('./sonareAnalysis')
      if (generation !== this.generation || this.disposed) return
      const rhythm = await analyseLocalRhythm(mono, 16000)
      bpm = rhythm.bpm
      beats = cleanBeatTimes(rhythm.beats, durationSec)
    } catch {
      const fallback = analyseLocalTempo(mono, 16000)
      bpm = fallback.bpm
      if (fallback.bpm > 0) {
        const period = 60 / fallback.bpm
        for (let time = fallback.firstBeatSec; time <= durationSec; time += period) {
          beats.push(time)
        }
        beats = cleanBeatTimes(beats, durationSec)
      }
    }
    if (generation !== this.generation || this.disposed) return
    this.applyRhythm(bpm, beats)
  }

  private applyRhythm(bpm: number, beats: number[]): void {
    this.bpm = beatBpm(beats, bpm)
    this.tracker.setRhythm(this.bpm, beats)
    this.resetBeats(this.position())
    this.publishState()
  }

  private position(): number {
    const value = this.audio?.currentTime ?? 0
    return Number.isFinite(value) ? Math.max(0, value) : 0
  }

  private emitSense(): void {
    this.deps.onSense({
      active: this.status === 'playing',
      mood: this.mood,
      energy: this.energy,
      bass: this.bass,
      bpm: this.bpm,
      beatAt: this.beatAt,
      nextBeatMs: this.nextBeatMs,
    })
  }

  private publishState(): void {
    const state: LocalMusicState = {
      status: this.status,
      trackId: this.current?.id ?? null,
      trackName: this.current?.name ?? '',
      positionSec: this.position(),
      durationSec: this.durationSec,
      volume: this.volume,
      bpm: this.bpm,
      mood: this.mood,
      error: this.error,
    }
    this.deps.emit(MUSIC_STATE_EVENT, state)
  }

  private emitProgress(): void {
    this.deps.emit(MUSIC_PROGRESS_EVENT, { positionSec: this.position() })
  }

  private fail(reason: unknown): void {
    this.generation += 1
    this.mediaGeneration = this.generation
    this.stopTicker()
    this.audio?.pause()
    this.status = 'error'
    this.error = musicErrorMessage(reason)
    this.mood = null
    this.energy = 0
    this.bass = 0
    this.gate = beginMoodGate(this.deps.now())
    this.emitSense()
    this.publishState()
  }

  private failIfCurrent(generation: number, reason: unknown): void {
    if (generation !== this.generation || this.disposed) return
    this.fail(reason)
  }

  private replaceObjectUrl(next: string): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = next
  }

  private ensureAudioElement(): HTMLAudioElement {
    if (this.audio) return this.audio
    const audio = new Audio()
    audio.preload = 'auto'
    audio.volume = 1
    audio.addEventListener('ended', () => this.handleEnded())
    this.audio = audio
    return audio
  }

  private ensureAudioGraph(): AudioContext {
    if (this.context && this.context.state !== 'closed') return this.context
    if (typeof AudioContext === 'undefined') throw 'music_audio_unsupported'
    const audio = this.ensureAudioElement()
    const context = new AudioContext({ latencyHint: 'playback' })
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.68
    analyser.minDecibels = -90
    analyser.maxDecibels = -18
    const gain = context.createGain()
    gain.gain.value = this.volume
    const source = context.createMediaElementSource(audio)
    source.connect(analyser)
    analyser.connect(gain)
    gain.connect(context.destination)
    this.context = context
    this.analyser = analyser
    this.gain = gain
    this.frequency = new Uint8Array(analyser.frequencyBinCount)
    this.waveform = new Float32Array(analyser.fftSize)
    return context
  }
}

function bandEnergy(data: Uint8Array, lowHz: number, highHz: number, hzPerBin: number): number {
  if (!(hzPerBin > 0)) return 0
  const start = Math.max(1, Math.floor(lowHz / hzPerBin))
  const end = Math.min(data.length - 1, Math.ceil(highHz / hzPerBin))
  let sum = 0
  let count = 0
  for (let index = start; index <= end; index += 1) {
    sum += data[index] / 255
    count += 1
  }
  return count > 0 ? sum / count : 0
}

function playError(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name)
      : ''
  return name === 'NotSupportedError' ? 'music_audio_unsupported' : 'music_audio_blocked'
}

function loadAudioMetadata(audio: HTMLAudioElement, url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let timer = 0
    const cleanup = () => {
      window.clearTimeout(timer)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('error', onError)
    }
    const onLoaded = () => {
      cleanup()
      resolve(audio.duration)
    }
    const onError = () => {
      cleanup()
      reject('music_decode_failed')
    }
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('error', onError)
    audio.src = url
    audio.load()
    if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) {
      cleanup()
      resolve(audio.duration)
      return
    }
    timer = window.setTimeout(() => {
      cleanup()
      reject('music_decode_failed')
    }, 15_000)
  })
}

async function decodeMonoAt16k(bytes: ArrayBuffer): Promise<Float32Array | null> {
  if (typeof window === 'undefined') return null
  const AudioCtor = window.AudioContext
  if (!AudioCtor) return null
  let context: AudioContext | null = null
  try {
    context = new AudioCtor({ sampleRate: 16000 })
    const buffer = await context.decodeAudioData(bytes)
    const rate = buffer.sampleRate
    const length = Math.min(
      buffer.length,
      Math.max(1, Math.round(TEMPO_ANALYSIS_SECONDS * rate)),
    )
    const mono = new Float32Array(length)
    const channels = Math.max(1, buffer.numberOfChannels)
    for (let channel = 0; channel < channels; channel += 1) {
      const data = buffer.getChannelData(channel)
      for (let index = 0; index < length; index += 1) {
        mono[index] += data[index] / channels
      }
    }
    return mono
  } catch {
    return null
  } finally {
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {})
    }
  }
}