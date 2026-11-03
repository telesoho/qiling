import type { AnimTrack } from './anim'

/**
 * 吊起轨的相位机。
 *
 * 帧段来自运行时 track_struct.json（经 anim.ts 加载），这里只处理
 * idle/lift/hover/drop 之间的切换；没有完整三段时返回 null，拖拽只移窗口。
 */

export type PickupPhase = 'idle' | 'lift' | 'hover' | 'drop'

export interface PickupSegment {
  from: number
  to: number
  loop: boolean
}

export type PickupSegments = Record<Exclude<PickupPhase, 'idle'>, PickupSegment>

export interface PickupPlayback {
  phase: PickupPhase
  frame: number
}

function readSegment(track: AnimTrack, name: 'lift' | 'hover' | 'drop'): PickupSegment | null {
  const phase = track.phases[name]
  const asset = phase?.asset
  if (!asset || asset.type !== 'frameSequence') return null
  return { from: asset.from, to: asset.to, loop: phase.playback === 'loop' }
}

export function pickupSegments(track: AnimTrack | null | undefined): PickupSegments | null {
  if (!track) return null
  const lift = readSegment(track, 'lift')
  const hover = readSegment(track, 'hover')
  const drop = readSegment(track, 'drop')
  return lift && hover && drop ? { lift, hover, drop } : null
}

export function pickupPlayback(segments: PickupSegments | null, phase: PickupPhase): PickupPlayback {
  if (phase === 'idle' || !segments) return { phase: 'idle', frame: 1 }
  return { phase, frame: segments[phase].from }
}

/** 按下开始吊起；落下中途再按可从落下切回吊起。 */
export function pickupPhaseAfterPress(
  segments: PickupSegments | null,
  phase: PickupPhase,
): PickupPhase {
  if (!segments) return 'idle'
  return phase === 'idle' || phase === 'drop' ? 'lift' : phase
}

/** 松手开始落下；吊起或悬空都从落下段重新播。 */
export function pickupPhaseAfterRelease(
  segments: PickupSegments | null,
  phase: PickupPhase,
): PickupPhase {
  if (!segments) return 'idle'
  return phase === 'lift' || phase === 'hover' ? 'drop' : phase
}

/**
 * 推进一帧。
 * - 吊起播完：仍按住 → 悬空；已松手 → 落下
 * - 悬空循环
 * - 落下播完 → 待机
 */
export function stepPickup(
  segments: PickupSegments | null,
  playback: PickupPlayback,
  holding: boolean,
): PickupPlayback {
  if (!segments || playback.phase === 'idle') return pickupPlayback(segments, 'idle')
  const segment = segments[playback.phase]
  if (playback.frame < segment.to) {
    return { phase: playback.phase, frame: playback.frame + 1 }
  }
  if (segment.loop) {
    return { phase: playback.phase, frame: segment.from }
  }
  if (playback.phase === 'lift') {
    return pickupPlayback(segments, holding ? 'hover' : 'drop')
  }
  return pickupPlayback(segments, 'idle')
}
