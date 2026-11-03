import { describe, expect, it } from 'vitest'
import type { AnimPhase, AnimTrack } from './anim'
import {
  pickupPhaseAfterPress,
  pickupPhaseAfterRelease,
  pickupPlayback,
  pickupSegments,
  stepPickup,
  type PickupSegments,
} from './pickup'

function framePhase(from: number, to: number, loop = false): AnimPhase {
  return {
    playback: loop ? 'loop' : 'once',
    asset: { type: 'frameSequence', dir: 'frames', pattern: 'frame{NNN}.webp', zeroPad: 3, from, to },
  }
}

function track(phases: Record<string, AnimPhase>): AnimTrack {
  return {
    id: 'test-pickup',
    fps: 24,
    frameSize: { width: 180, height: 260 },
    tags: ['pickup'],
    baseUrl: 'http://test/pet/anim/test/track_struct.json',
    phases,
  }
}

const pickup = track({
  idle: { playback: 'loop', asset: { type: 'animatedWebp', src: '/pet/idle.webp' } },
  lift: framePhase(30, 72),
  hover: framePhase(73, 100, true),
  drop: framePhase(101, 193),
})
const segments = pickupSegments(pickup) as PickupSegments

describe('吊起轨', () => {
  it('reads lift/hover/drop only when all three are frame sequences', () => {
    expect(segments).toEqual({
      lift: { from: 30, to: 72, loop: false },
      hover: { from: 73, to: 100, loop: true },
      drop: { from: 101, to: 193, loop: false },
    })
    expect(pickupSegments(track({ idle: pickup.phases.idle }))).toBeNull()
    expect(pickupSegments(undefined)).toBeNull()
  })

  it('starts each phase at its first frame', () => {
    expect(pickupPlayback(null, 'lift')).toEqual({ phase: 'idle', frame: 1 })
    expect(pickupPlayback(segments, 'idle')).toEqual({ phase: 'idle', frame: 1 })
    expect(pickupPlayback(segments, 'lift')).toEqual({ phase: 'lift', frame: 30 })
    expect(pickupPlayback(segments, 'hover')).toEqual({ phase: 'hover', frame: 73 })
    expect(pickupPlayback(segments, 'drop')).toEqual({ phase: 'drop', frame: 101 })
  })

  it('does not lift without a full pickup track', () => {
    expect(pickupPhaseAfterPress(null, 'idle')).toBe('idle')
    expect(pickupPhaseAfterRelease(null, 'lift')).toBe('idle')
  })

  it('lifts on press, including from a half-finished drop', () => {
    expect(pickupPhaseAfterPress(segments, 'idle')).toBe('lift')
    expect(pickupPhaseAfterPress(segments, 'drop')).toBe('lift')
    expect(pickupPhaseAfterPress(segments, 'lift')).toBe('lift')
    expect(pickupPhaseAfterPress(segments, 'hover')).toBe('hover')
  })

  it('drops on release from lift or hover', () => {
    expect(pickupPhaseAfterRelease(segments, 'lift')).toBe('drop')
    expect(pickupPhaseAfterRelease(segments, 'hover')).toBe('drop')
    expect(pickupPhaseAfterRelease(segments, 'drop')).toBe('drop')
    expect(pickupPhaseAfterRelease(segments, 'idle')).toBe('idle')
  })

  it('holds hover while the pointer stays down', () => {
    expect(stepPickup(segments, { phase: 'lift', frame: 71 }, true)).toEqual({ phase: 'lift', frame: 72 })
    expect(stepPickup(segments, { phase: 'lift', frame: 72 }, true)).toEqual({ phase: 'hover', frame: 73 })
  })

  it('drops when lift ends after an early release', () => {
    expect(stepPickup(segments, { phase: 'lift', frame: 72 }, false)).toEqual({ phase: 'drop', frame: 101 })
  })

  it('loops hover and ends drop in idle', () => {
    expect(stepPickup(segments, { phase: 'hover', frame: 100 }, true)).toEqual({ phase: 'hover', frame: 73 })
    expect(stepPickup(segments, { phase: 'hover', frame: 90 }, false)).toEqual({ phase: 'hover', frame: 91 })
    expect(stepPickup(segments, { phase: 'drop', frame: 192 }, false)).toEqual({ phase: 'drop', frame: 193 })
    expect(stepPickup(segments, { phase: 'drop', frame: 193 }, false)).toEqual({ phase: 'idle', frame: 1 })
  })
})
