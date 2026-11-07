/**
 * 灵泡的 SVG 骨架参数。
 *
 * 造型来自 `design/characters/lingpao/`：梨形纯色身体、两只竖椭圆眼睛，
 * 状态由「眼 / 嘴 / 身体 / 道具」四个离散参数加 tilt 组合而成。
 * 这里只输出参数；`SvgSprite.tsx` 负责画，`lingpao.css` 负责待机动画。
 */
import type { MusicMood } from './music'
import type { PetStateId } from './states'

export type LingpaoEye =
  | 'open'
  | 'happy'
  | 'closed'
  | 'lookup'
  | 'angry'
  | 'worry'
  | 'wide'
  | 'star'

export type LingpaoMouth =
  | 'none'
  | 'talk'
  | 'grin'
  | 'smirk'
  | 'wavy'
  | 'pout'
  | 'o'
  | 'smile'
  | 'smile-wide'

/**
 * `music` 表示耳机与飘动的音符；它们由角色本体一起呼吸，所以不放进 `fx`。
 * 其余道具与 `state-preview.html` 一致。
 */
export type LingpaoProp =
  | 'none'
  | 'music'
  | 'bulb'
  | 'dots'
  | 'sweat'
  | 'steam'
  | 'zzz'
  | 'bang'
  | 'ear'

export type LingpaoFx = 'none' | 'sparkles' | 'ripple'

export interface LingpaoPose {
  eye: LingpaoEye
  mouth: LingpaoMouth
  prop: LingpaoProp
  fx: LingpaoFx
  /** 身体倾斜角度，正数向右。 */
  tilt: number
  /** 眼睛缩放；音乐里的睁眼微笑略收一点。 */
  eyeScale?: number
}

const POSES: Record<PetStateId, LingpaoPose> = {
  idle: { eye: 'open', mouth: 'none', prop: 'none', fx: 'none', tilt: 0 },
  explain: { eye: 'open', mouth: 'talk', prop: 'bulb', fx: 'none', tilt: 3 },
  think: { eye: 'lookup', mouth: 'none', prop: 'dots', fx: 'none', tilt: 5 },
  advantage: { eye: 'star', mouth: 'smirk', prop: 'none', fx: 'sparkles', tilt: 0 },
  disadvantage: { eye: 'worry', mouth: 'wavy', prop: 'sweat', fx: 'none', tilt: -4 },
}

export const HOLDING_POSE: LingpaoPose = {
  eye: 'wide',
  mouth: 'o',
  prop: 'none',
  fx: 'none',
  tilt: 0,
}

const MUSIC_POSES: Record<MusicMood, LingpaoPose> = {
  calm: { eye: 'happy', mouth: 'smile', prop: 'music', fx: 'none', tilt: -3 },
  groove: {
    eye: 'open',
    mouth: 'smile-wide',
    prop: 'music',
    fx: 'none',
    tilt: 0,
    eyeScale: 0.94,
  },
  intense: {
    eye: 'open',
    mouth: 'smile-wide',
    prop: 'music',
    fx: 'none',
    tilt: 0,
    eyeScale: 0.94,
  },
}

export interface LingpaoRuntimeInput {
  stateId: PetStateId
  speaking: boolean
  holding: boolean
  /** 正在跟随的音乐档位；null 表示没有音乐。 */
  music: MusicMood | null
}

/**
 * 运行态 → 姿态。
 * 优先级：被拎起 > 五态（非 idle）> 听音乐 > 待机。
 * 音乐只在待机时接管：讲解、思考、拎起都优先，避免抢正在发生的交互。
 */
export function poseForRuntime(input: LingpaoRuntimeInput): LingpaoPose {
  if (input.holding) return HOLDING_POSE
  if (input.stateId === 'idle' && input.music) return MUSIC_POSES[input.music]
  const pose = POSES[input.stateId]
  if (input.stateId === 'explain' && !input.speaking) {
    return { ...pose, mouth: 'none' }
  }
  return pose
}

const MOOD_LABELS: Record<MusicMood, string> = {
  calm: '听音乐·舒缓',
  groove: '听音乐·轻快',
  intense: '听音乐·激烈',
}

const STATE_LABELS: Record<PetStateId, string> = {
  idle: '待机',
  explain: '讲解',
  think: '思考',
  advantage: '优势',
  disadvantage: '劣势',
}

export function lingpaoAriaLabel(input: LingpaoRuntimeInput): string {
  if (input.holding) return '器灵，被拎起'
  if (input.stateId === 'idle' && input.music) return `器灵，${MOOD_LABELS[input.music]}`
  return `器灵，${STATE_LABELS[input.stateId]}`
}