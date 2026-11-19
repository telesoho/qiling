import { describe, expect, it } from 'vitest'
import {
  BeatTracker,
  beatBpm,
  cleanBeatTimes,
  medianBeatInterval,
  nextBeatIndex,
} from './rhythm'

describe('曲库节拍工具', () => {
  it('cleans, sorts and de-duplicates detected beats', () => {
    expect(cleanBeatTimes([0.5, -1, 1.2, 1.2, 1.21, 2.5, Number.NaN], 3)).toEqual([
      0.5, 1.2, 2.5,
    ])
    expect(cleanBeatTimes(null, 10)).toEqual([])
  })

  it('takes the median interval instead of an average', () => {
    // 间隔 0.5, 0.5, 1.0：中位数是 0.5，平均值会被异常拍拉高。
    expect(medianBeatInterval([0, 0.5, 1, 2])).toBeCloseTo(0.5)
    expect(medianBeatInterval([0, 0.5])).toBe(0)
  })

  it('derives the animation BPM from actual beats', () => {
    const beats = Array.from({ length: 20 }, (_, index) => index * 0.5)
    expect(beatBpm(beats, 90)).toBeCloseTo(120)
    // detectBeats 偶尔给八分音符：归一化回半拍再驱动动作。
    const eighthNotes = Array.from({ length: 21 }, (_, index) => index * 0.25)
    expect(beatBpm(eighthNotes, 0)).toBeCloseTo(120)
    // 拍点不可信时回落到分析器 BPM。
    expect(beatBpm([], 128)).toBe(128)
    expect(beatBpm([], 10)).toBe(0)
  })

  it('finds the next beat strictly after a position', () => {
    const beats = [0, 0.5, 1, 1.5]
    expect(nextBeatIndex(beats, -1)).toBe(0)
    expect(nextBeatIndex(beats, 0.5)).toBe(2)
    expect(nextBeatIndex(beats, 1.5)).toBe(4)
  })
})

describe('节拍游标', () => {
  it('walks the detected beats and keeps going after the list ends', () => {
    const tracker = new BeatTracker()
    tracker.setRhythm(120, [0.5, 1.0, 1.5])
    tracker.reset(0)
    expect(tracker.nextBeatMs).toBeCloseTo(500)
    expect(tracker.update(0.4)).toBe(false)
    expect(tracker.update(0.52)).toBe(true)
    expect(tracker.nextBeatMs).toBeCloseTo(480)
    expect(tracker.update(1.05)).toBe(true)
    expect(tracker.update(1.6)).toBe(true)
    // 检测拍点用完：按 120 BPM 的 0.5s 拍长继续。
    expect(tracker.nextBeatMs).toBeCloseTo(400)
    expect(tracker.update(2.05)).toBe(true)
    expect(tracker.nextBeatMs).toBeCloseTo(450)
  })

  it('jumps to the next beat after a seek', () => {
    const tracker = new BeatTracker()
    tracker.setRhythm(120, [0.5, 1.0, 1.5, 2.0])
    tracker.reset(0.95)
    expect(tracker.nextBeatMs).toBeCloseTo(50)
    expect(tracker.update(1.01)).toBe(true)
  })

  it('falls back to a uniform grid without detected beats', () => {
    const tracker = new BeatTracker()
    tracker.setRhythm(0, [])
    tracker.reset(3)
    expect(tracker.nextBeatMs).toBe(0)
    expect(tracker.update(3.01)).toBe(true)
    // 没有速度时用 96 BPM 的 625ms 备用拍。
    expect(tracker.nextBeatMs).toBeCloseTo(615)
  })
})