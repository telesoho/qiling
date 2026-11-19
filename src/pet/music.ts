/**
 * 听音乐的律动契约。
 *
 * 阈值、节拍与运动参数的默认值都对齐设计原型
 * `design/characters/lingpao/sheets/lingpao-groove.html`：
 *   - 三档阈值来自原型滑块的默认值（0.60 / 0.30），不是设计提案 §5.5 的初值；
 *   - `chooseMusicMood` 逐分支照抄原型的 `chooseMood`；
 *   - `beatAt` / `motionFor` 照抄原型的节拍时钟与三档运动分层。
 *
 * 识别阈值可以在设定页由用户调整（`MusicTuning`）。默认值仍是原型标定值，
 * 所以「不调」时行为和以前完全一致；改默认值之前先对照原型。
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

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100
}

const defaultEnterIntense = clamp(
  Math.max(MUSIC_TUNING.intenseFloor, MUSIC_TUNING.swayThreshold + MUSIC_TUNING.intenseGap),
  0,
  0.95,
)

/**
 * 识别音乐时可调的控制参数。
 *
 * `enterScore` / `exitScore` 由后端使用：最近 1 秒的节奏与音色证据得分高于
 * `enterScore` 持续 1 秒进入音乐，低于 `exitScore` 持续 1 秒退出。
 * 其余四个阈值由前端使用：把 0–1 的平滑能量映射到舒缓 / 轻快 / 激烈。
 */
export interface MusicTuning {
  /** 音乐判定进入分数（0–1）。越低越容易把声音当成音乐。 */
  enterScore: number
  /** 音乐判定退出分数，必须低于 `enterScore`。 */
  exitScore: number
  /** 舒缓 → 轻快的能量阈值。 */
  enterGroove: number
  /** 轻快 → 舒缓的能量阈值，必须低于 `enterGroove`。 */
  exitGroove: number
  /** 轻快 → 激烈的能量阈值，必须高于 `enterGroove`。 */
  enterIntense: number
  /** 激烈 → 轻快的能量阈值。 */
  exitIntense: number
}

/** 原型标定值；「恢复默认」和旧设置都回落到这里。 */
export const DEFAULT_MUSIC_TUNING: MusicTuning = {
  enterScore: 0.32,
  exitScore: 0.2,
  enterGroove: MUSIC_TUNING.swayThreshold,
  exitGroove: MUSIC_TUNING.calmThreshold,
  enterIntense: defaultEnterIntense,
  exitIntense: clamp(
    Math.max(MUSIC_TUNING.calmThreshold, defaultEnterIntense - MUSIC_TUNING.intenseHysteresis),
    0,
    defaultEnterIntense,
  ),
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 把任意来源（旧设置、手改的 localStorage、后端回显）收敛成合法阈值。
 *
 * 进入阈值必须高于退出阈值，激烈档必须高于轻快档；越界的值直接夹住，
 * 而不是让 UI 拒绝保存。这样旧版本设置、拖动滑块和手改 JSON 都不会产生
 * 永远进不去 / 退不出的滞回区间。
 */
export function normalizeMusicTuning(input: unknown): MusicTuning {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<
    Record<keyof MusicTuning, unknown>
  >
  const enterScore = roundHundredths(
    clamp(finiteOr(raw.enterScore, DEFAULT_MUSIC_TUNING.enterScore), 0.05, 0.95),
  )
  const exitScore = roundHundredths(
    clamp(
      finiteOr(raw.exitScore, DEFAULT_MUSIC_TUNING.exitScore),
      0.01,
      Math.max(0.01, enterScore - 0.01),
    ),
  )
  const enterGroove = roundHundredths(
    clamp(finiteOr(raw.enterGroove, DEFAULT_MUSIC_TUNING.enterGroove), 0.05, 0.95),
  )
  const exitGroove = roundHundredths(
    clamp(
      finiteOr(raw.exitGroove, DEFAULT_MUSIC_TUNING.exitGroove),
      0.01,
      Math.max(0.01, enterGroove - 0.01),
    ),
  )
  const enterIntense = roundHundredths(
    clamp(
      finiteOr(raw.enterIntense, DEFAULT_MUSIC_TUNING.enterIntense),
      Math.max(0, enterGroove + 0.01),
      0.99,
    ),
  )
  const exitIntense = roundHundredths(
    clamp(
      finiteOr(raw.exitIntense, DEFAULT_MUSIC_TUNING.exitIntense),
      Math.min(exitGroove, enterIntense - 0.01),
      Math.max(exitGroove, enterIntense - 0.01),
    ),
  )
  return { enterScore, exitScore, enterGroove, exitGroove, enterIntense, exitIntense }
}

export interface MusicThresholds {
  enterGroove: number
  exitGroove: number
  enterIntense: number
  exitIntense: number
}

/** 把用户阈值整理成三档滞回判定需要的四个边界。 */
export function musicThresholds(
  tuning: MusicTuning = DEFAULT_MUSIC_TUNING,
): MusicThresholds {
  const safe = normalizeMusicTuning(tuning)
  return {
    enterGroove: safe.enterGroove,
    exitGroove: safe.exitGroove,
    enterIntense: safe.enterIntense,
    exitIntense: safe.exitIntense,
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
  tuning: MusicTuning = DEFAULT_MUSIC_TUNING,
): MusicMood | null {
  if (!active) return null
  const { enterGroove, exitGroove, enterIntense, exitIntense } = musicThresholds(tuning)
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

/**
 * 换档防抖：新档位连续成立这么久才真的切。
 *
 * 滞回区间只挡住阈值上的抖动；副歌/主歌这种能量整体抬落仍会让档位在几秒内
 * 连续换两次。每次换档都伴随动作与表情过渡，太密会显得抽搐，所以再等半拍确认。
 */
export const MOOD_DWELL_MS = 420
/** 两次真正换档之间的最小间隔，避免在阈值边缘来回拉锯。 */
export const MOOD_MIN_HOLD_MS = 700

export interface MoodGate {
  /** 已经确认、正在生效的档位。 */
  mood: MusicMood | null
  /** 正在等待确认的候选档位。 */
  candidate: MusicMood | null
  /** 候选从何时开始连续成立（`performance.now()` 毫秒）。 */
  candidateSince: number
  /** 上一次真正换档的时间。 */
  changedAt: number
}

export function beginMoodGate(now = 0): MoodGate {
  return { mood: null, candidate: null, candidateSince: 0, changedAt: now }
}

/**
 * 给 `chooseMusicMood` 的结果加一层确认。
 *
 * 音乐开始/结束（`raw === null` 或当前没有音乐）是明确事件，立即生效；
 * 只有舒缓/轻快/激烈之间的来回复跳才要求候选档位站住 `dwellMs`，
 * 且距离上次换档满 `minHoldMs`。
 */
export function gateMusicMood(
  gate: MoodGate,
  raw: MusicMood | null,
  now: number,
  dwellMs: number = MOOD_DWELL_MS,
  minHoldMs: number = MOOD_MIN_HOLD_MS,
): MoodGate {
  if (raw === gate.mood) {
    if (gate.candidate === null && gate.candidateSince === 0) return gate
    return { ...gate, candidate: null, candidateSince: 0 }
  }
  if (raw === null || gate.mood === null) {
    return { mood: raw, candidate: null, candidateSince: 0, changedAt: now }
  }
  if (raw !== gate.candidate) {
    return { ...gate, candidate: raw, candidateSince: now }
  }
  if (now - gate.candidateSince < dwellMs) return gate
  if (now - gate.changedAt < minHoldMs) return gate
  return { mood: raw, candidate: null, candidateSince: 0, changedAt: now }
}

/**
 * 原型 `readMusicFeatures()` 的能量口径。
 *
 * 系统声音由 `music.rs` 按同一套权重计算；曲库播放直接读 AnalyserNode，
 * 也必须用这套权重，否则设定页的三档阈值会只在系统声音上成立。
 */
export const MUSIC_ENERGY = {
  bassWeight: 1.32,
  midWeight: 0.28,
  rmsWeight: 0.4,
  attack: 5,
  release: 1.4,
} as const

/** 把低频 / 中频 / RMS 合成为 0–1 能量。 */
export function mixMusicEnergy(bass: number, mid: number, rms: number): number {
  const value =
    bass * MUSIC_ENERGY.bassWeight +
    mid * MUSIC_ENERGY.midWeight +
    rms * MUSIC_ENERGY.rmsWeight
  return clamp(value)
}

/** 原型 `energySmooth += (target - energy) * (1 - exp(-dt * rate))` 的移植。 */
export function smoothMusicEnergy(current: number, target: number, dtSec: number): number {
  const dt = Math.max(0.001, Math.min(0.05, dtSec))
  const rate = target > current ? MUSIC_ENERGY.attack : MUSIC_ENERGY.release
  return current + (target - current) * (1 - Math.exp(-dt * rate))
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

/**
 * 建立节拍时钟。
 *
 * `nextBeatMs` 是"从现在到下一拍"的毫秒数，用来给曲库播放种子相位：
 * 本地估速会同时给出第一拍位置，若从按下播放的瞬间起算，动作会和音乐错半拍。
 * 传 0（默认）表示"现在就是拍点"，与旧行为一致。
 */
export function createBeatClock(nowMs: number, bpm = 0, nextBeatMs = 0): BeatClock {
  return { bpm: bpm > 0 ? bpm : 0, startMs: nowMs + nextBeatMs }
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
 * 档位切换的交叉淡入时长。
 *
 * 三档的动作公式不同（舒缓是慢正弦，轻快/激烈是拍点摇摆），直接换档会在同一帧跳变；
 * 切档时从「上一帧真正画出来的值」用 smoothstep 过渡到新档，首尾速度为 0，
 * 所以接得上、也停得稳。数值取一拍左右（96 BPM ≈ 625ms），读起来像顺着刚才的动作换气。
 */
export const MOOD_BLEND_MS = 620

/** 音乐出现/消失时，从静止淡入或收拢回静止的时长。 */
export const MOOD_SETTLE_MS = 360

/** `t` 夹到 0…1 后的 smoothstep：两端速度为 0，避免过渡起止各顿一下。 */
export function smoothstep(t: number): number {
  const x = clamp(t)
  return x * x * (3 - 2 * x)
}

/** 两套动作之间做插值；音乐开头/收尾都走这里，保证帧间连续。 */
export function blendMotion(from: Motion, to: Motion, t: number): Motion {
  const k = smoothstep(t)
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    rotation: from.rotation + (to.rotation - from.rotation) * k,
    sx: from.sx + (to.sx - from.sx) * k,
    sy: from.sy + (to.sy - from.sy) * k,
  }
}

export interface GroundShadow {
  opacity: number
  scale: number
}

/** 待机时 CSS 画的地面影子（`lingpao-idle.svg` / `.lp-ground`），收尾时要交还这份数值。 */
export const IDLE_GROUND: GroundShadow = { opacity: 0.14, scale: 1 }

export function blendGround(
  from: GroundShadow,
  to: GroundShadow,
  t: number,
): GroundShadow {
  const k = smoothstep(t)
  return {
    opacity: from.opacity + (to.opacity - from.opacity) * k,
    scale: from.scale + (to.scale - from.scale) * k,
  }
}

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
export function groundFor(motion: Motion): GroundShadow {
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

/**
 * 设定页「监听状态」行的文案。
 *
 * `music` 与 `bpm` 是两条独立信号：`music` 只表示“这段声音像音乐”（节奏/音色证据 + 滞回），
 * 不要求估出速度。靠音色认出、或者节拍证据不够的音乐会把 BPM 留成 0，前端按
 * `fallbackBpm` 的备用拍摇摆。所以这里必须把“没估出 BPM”写成看得见的状态，
 * 否则界面会出现“正在跟随音乐”却不显示 BPM 的矛盾感。
 */
export function musicFollowLabel(status: {
  music?: boolean
  active?: boolean
  bpm?: number
}): string {
  if (status.music === true) {
    const bpm = status.bpm ?? 0
    return bpm > 0
      ? `正在跟随音乐 · ${Math.round(bpm)} BPM`
      : `正在跟随音乐 · 未识别到节拍（按 ${MUSIC_TUNING.fallbackBpm} BPM 摆动）`
  }
  return status.active === true
    ? '听到声音，但不是音乐（人声/噪声不跟拍）'
    : '正在监听，等待音乐'
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