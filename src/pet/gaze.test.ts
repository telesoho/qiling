import { describe, expect, it } from 'vitest'
import { nextBlinkDelayMs, clampGaze, gazeTowards, smoothGaze } from './gaze'

describe('眼神跟随', () => {
  it('stays centred without a direction', () => {
    expect(clampGaze(0, 0, 200)).toEqual({ x: 0, y: 0 })
    expect(clampGaze(10, 10, 0)).toEqual({ x: 0, y: 0 })
  })

  it('clamps a far pointer to the gaze radius', () => {
    expect(gazeTowards({ x: 5000, y: 0 }, { x: 0, y: 0 }, 100)).toEqual({ x: 7, y: 0 })
    expect(gazeTowards({ x: 0, y: -5000 }, { x: 0, y: 0 }, 100)).toEqual({ x: 0, y: -5 })
  })

  it('keeps diagonal glances inside the ellipse', () => {
    const gaze = gazeTowards({ x: 1000, y: 1000 }, { x: 0, y: 0 }, 100)
    expect(gaze.x).toBeCloseTo(7 / Math.SQRT2, 1)
    expect(gaze.y).toBeCloseTo(5 / Math.SQRT2, 1)
  })

  it('smooths toward the target without snapping', () => {
    const target = { x: 7, y: 5 }
    const first = smoothGaze({ x: 0, y: 0 }, target, 0.18)
    expect(first.x).toBeGreaterThan(0)
    expect(first.x).toBeLessThan(7)
    expect(smoothGaze(target, target, 0.18)).toEqual(target)
  })

  it('blinks on an irregular 3.2–6.8s schedule', () => {
    expect(nextBlinkDelayMs(() => 0)).toBe(3200)
    expect(nextBlinkDelayMs(() => 1)).toBe(6800)
    expect(nextBlinkDelayMs(() => 0.5)).toBe(5000)
  })
})