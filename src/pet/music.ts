/**
 * 听音乐的律动契约。
 *
 * 所有阈值、节拍与运动参数都对齐设计原型
 * `design/characters/lingpao/sheets/lingpao-groove.html`：
 *   - 阈值来自原型滑块的默认值（0.60 / 0.30），不是设计提案 §5.5 的初值；
 *   - `chooseMusicMood` 逐分支照抄原型的 `chooseMood`；
 *   - `beatAt` / `motionFor` 照抄原型的节拍时钟与三档运动分层。
 * 改这里之前先对照原型，避免「听起来对、动起来不对」。
 */

export type MusicMood = 'calm' | 'groove' | 'intense'

export const MUSIC_TUNING = {
  /**
   * 原型滑块默认值（已用 `_workshop/test-120bpm.wav` 调好）。
   * 设计提案 §5.5 的 0.24 / 0.16 是初值，运行时不要用。
   */
  swayThreshold: 0.6,
  calmThreshold: 0.3,
  /** 原型 `FALLBACK_BPM`：估不出速度时仍让灵泡持续摇摆。 */
  fallbackBpm: 96,
  /** 原型 `motionScale`（动作幅度 100%）。 */
  motionScale: 0.5,
  /** 情绪进入/退出激烈的下限，与原型 `thresholdValues` 一致。 */
  intenseFloor: 0.52,
  intenseGap: 0.28,
  intenseHysteresis: 0.1,
} as const

export interface MusicThresholds {
  enterGroove: number
  exitGroove: number
  enterIntense: number
  exitIntense: number
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

/** 原型 `thresholdValues()` 的移植。 */
export function musicThresholds(
  sway: number = MUSIC_TUNING.swayThreshold,
  calm: number = MUSIC_TUNING.calmThreshold,
): MusicThresholds {
  const enterIntense = clamp(
    Math.max(MUSIC_TUNING.intenseFloor, sway + MUSIC_TUNING.intenseGap),
    0,
    0.95,
  )
  const exitIntense = clamp(
    Math.max(calm, enterIntense - MUSIC_TUNING.intenseHysteresis),
    0,
    enterIntense,
  )
  return {
    enterGroove: clamp(sway),
    exitGroove: clamp(calm),
    enterIntense,
    exitIntense,
  }
}

/**
 * 原型 `chooseMood()` 的移植。
 *
 * `current === null` 表示灵泡还没开始听音乐；首次激活时按同一套入口规则判定，
 * 不预设档位（原型的「起播即轻快」是点击播放手势，被动收听没有这个手势）。
 */
export function chooseMusicMood(
  current: MusicMood | null,
  energy: number,
  active: boolean,
): MusicMood | null {
  if (!active) return null
  const { enterGroove, exitGroove, enterIntense, exitIntense } = musicThresholds()
  if (current === null || current === 'calm') {
    if (energy < enterGroove) return 'calm'
    return energy >= enterIntense ? 'intense' : 'groove'
  }
  if (current === 'groove') {
    if (energy >= enterIntense) return 'intense'
    if (energy < exitGroove) return 'calm'
    return 'groove'
  }
  return energy < exitIntense ? 'groove' : 'intense'
}

export interface BeatClock {
  /** 0 表示还没有估到速度，节拍按 `fallbackBpm` 走。 */
  bpm: number
  startMs: number
}

export function beatDurationMs(bpm: number): number {
  const safe = bpm > 0 ? bpm : MUSIC_TUNING.fallbackBpm
  return 60_000 / safe
}

export function createBeatClock(nowMs: number, bpm = 0): BeatClock {
  return { bpm: bpm > 0 ? bpm : 0, startMs: nowMs }
}

/** 速度变化时保留当前相位，避免摇摆跳一下。 */
export function retuneBeatClock(clock: BeatClock, nowMs: number, bpm: number): BeatClock {
  const next = bpm > 0 ? bpm : 0
  if (next === clock.bpm) return clock
  const position = (nowMs - clock.startMs) / beatDurationMs(clock.bpm)
  return { bpm: next, startMs: nowMs - position * beatDurationMs(next) }
}

export interface BeatPosition {
  index: number
  phase: number
  /** 原型里的 `wave`：每拍从一侧连续摆到另一侧，范围 −1…1。 */
  wave: number
}

export function beatAt(clock: BeatClock, nowMs: number): BeatPosition {
  const position = (nowMs - clock.startMs) / beatDurationMs(clock.bpm)
  const index = Math.floor(position)
  const phase = position - index
  const wave = (index % 2 === 0 ? 1 : -1) * Math.cos(phase * Math.PI)
  return { index, phase, wave }
}

/**
 * 收到的鼓点落点接近预测拍点时，小幅拨动时钟贴住真实节拍。
 * 每次最多 40ms，避免被动收听时画面突然跳拍。
 */
export function lockBeatPhase(clock: BeatClock, nowMs: number, bpm = clock.bpm): BeatClock {
  const duration = beatDurationMs(bpm)
  const position = (nowMs - clock.startMs) / duration
  const phase = position - Math.floor(position)
  if (Math.min(phase, 1 - phase) > 0.35) return clock
  const error = (phase <= 0.5 ? phase : phase - 1) * duration
  const correction = Math.max(-40, Math.min(40, error * 0.25))
  return { ...clock, startMs: clock.startMs + correction }
}

export interface Motion {
  x: number
  y: number
  rotation: number
  sx: number
  sy: number
}

export const REST_MOTION: Motion = { x: 0, y: 0, rotation: 0, sx: 1, sy: 1 }

/**
 * 原型 `frame()` 里的三档运动分层：
 * 舒缓只呼吸漂浮、轻快只左右摇摆（y 恒为 0）、激烈在摇摆上按拍点轻弹。
 */
export function motionFor(
  mood: MusicMood | null,
  wave: number,
  pulse: number,
  timeSec: number,
  scale: number = MUSIC_TUNING.motionScale,
): Motion {
  if (mood === null) return REST_MOTION
  const breath = Math.sin(timeSec * 0.68)
  if (mood === 'calm') {
    return {
      x: Math.sin(timeSec * 0.27) * 0.8 * scale,
      y: Math.sin(timeSec * 0.38) * 3.2 * scale,
      rotation: Math.sin(timeSec * 0.24) * 0.25 * scale,
      sx: 1 + breath * 0.008 * scale,
      sy: 1 - breath * 0.006 * scale,
    }
  }
  const motion: Motion = {
    x: wave * 10 * scale,
    y: 0,
    rotation: wave * 5.5 * scale,
    sx: 1,
    sy: 1,
  }
  if (mood === 'intense') {
    motion.y = pulse === 0 ? 0 : -pulse * 5.5 * scale
    motion.sx = 1 + pulse * 0.025 * scale
    motion.sy = 1 - pulse * 0.032 * scale
  }
  return motion
}

/** 原型 `ground.style.opacity / transform`：抬得越高，影子越淡越小。 */
export function groundFor(motion: Motion): { opacity: number; scale: number } {
  const lift = Math.max(0, -motion.y)
  return {
    opacity: 0.19 * (1 - lift / 260),
    scale: 1 - lift / 900,
  }
}

/** 浏览器预览用 `?music=calm|groove|intense` 强制档位，不采集音频。 */
export function forcedMusicMood(search?: string): MusicMood | null {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '')
  const value = new URLSearchParams(query).get('music')
  return value === 'calm' || value === 'groove' || value === 'intense' ? value : null
}

/**
 * 当前是否显示听音乐状态。
 *
 * 器灵自己的播报会经系统回环被采集；即使后端误判，说话期间也不进入音乐档。
 */
export function visibleMusicMood(
  enabled: boolean,
  speaking: boolean,
  mood: MusicMood | null,
): MusicMood | null {
  return enabled && !speaking ? mood : null
}

export interface MusicSenseEvent {
  active: boolean
  /** 后端判定的“是音乐”；语音和噪声为 false。旧版本没有这个字段。 */
  music?: boolean
  energy: number
  bass: number
  bpm: number
  bpmConfidence?: number
}

export interface MusicSenseStatus {
  running: boolean
  supported: boolean
  lastError: string | null
  /** 最近一次分析快照；旧后端没有这些字段。 */
  active?: boolean
  music?: boolean
  bpm?: number
  bpmConfidence?: number
}

export const MUSIC_ERRORS: Record<string, string> = {
  music_unsupported: '当前系统不支持读取正在播放的声音。',
  music_unavailable: '找不到可用的播放设备。',
  music_start_failed: '无法开始读取系统声音。',
  music_format_unsupported: '当前播放设备的音频格式暂不支持。',
  music_capture_failed: '系统声音读取中断，重新开启监听或切换播放设备后可重试。',
}

export function musicErrorMessage(reason: unknown): string {
  const code = String(reason)
  return MUSIC_ERRORS[code] ?? `听音乐功能不可用：${code}`
}