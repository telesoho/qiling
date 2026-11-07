/**
 * 曲库播放的节拍工具：整理检测到的拍点、取稳定的动画 BPM、按播放位置找下一拍。
 *
 * 拍点来自 libsonare 的 `detectBeats`（与设计原型 `lingpao-groove.html` 一致）。
 * 这些函数保持纯函数，便于用合成拍点做单测。
 */
import { beatDurationMs } from './music'

/** 丢掉越界、非有限和过近的拍点；返回升序秒数。 */
export function cleanBeatTimes(
  values: ArrayLike<number> | null | undefined,
  durationSec: number,
): number[] {
  if (!values) return []
  const sorted: number[] = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!Number.isFinite(value)) continue
    if (value < -0.05 || value > durationSec + 0.05) continue
    sorted.push(Math.max(0, value))
  }
  sorted.sort((left, right) => left - right)
  const result: number[] = []
  for (const value of sorted) {
    const previous = result[result.length - 1]
    if (previous !== undefined && value - previous < 0.08) continue
    result.push(value)
  }
  return result
}

/** 相邻拍点间隔的中位数；拍点太少或都不可用时返回 0。 */
export function medianBeatInterval(beats: readonly number[]): number {
  if (beats.length < 3) return 0
  const intervals: number[] = []
  for (let index = 1; index < beats.length; index += 1) {
    const interval = beats[index] - beats[index - 1]
    if (interval >= 0.15 && interval <= 1.5) intervals.push(interval)
  }
  if (intervals.length === 0) return 0
  intervals.sort((left, right) => left - right)
  const middle = Math.floor(intervals.length / 2)
  return intervals.length % 2 === 0
    ? (intervals[middle - 1] + intervals[middle]) / 2
    : intervals[middle]
}

/**
 * 动画 BPM：用检测拍点的整段平均间隔（首尾跨度 / 间隔数），比中位数更贴近
 * 实际拍速——检测抖动在正负两个方向会互相抵消。若平均落在动画区间之外
 * （例如 detectBeats 给的是八分音符），先做半拍/双拍归一化，再退回分析器 BPM。
 */
export function beatBpm(beats: readonly number[], fallbackBpm: number): number {
  if (beats.length >= 3) {
    const span = beats[beats.length - 1] - beats[0]
    const average = span / (beats.length - 1)
    let fromBeats = average > 0 ? 60 / average : 0
    if (fromBeats > 200) {
      const half = fromBeats / 2
      if (half >= 60 && half <= 120) fromBeats = half
    } else if (fromBeats > 0 && fromBeats < 40) {
      const doubled = fromBeats * 2
      if (doubled >= 70 && doubled <= 200) fromBeats = doubled
    }
    if (fromBeats >= 40 && fromBeats <= 200) {
      return Math.round(fromBeats * 10) / 10
    }
  }
  if (fallbackBpm >= 40 && fallbackBpm <= 200) {
    return Math.round(fallbackBpm * 10) / 10
  }
  return 0
}

/** 第一个严格晚于 `position` 的拍点下标；没有时返回 beats.length。 */
export function nextBeatIndex(beats: readonly number[], position: number): number {
  let low = 0
  let high = beats.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (beats[middle] <= position) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * 曲库播放的节拍游标。
 *
 * 有检测拍点时逐拍使用检测到的真实时间；检测窗口（前 3 分钟）用完后按中位
 * 拍长继续，因此长歌不会停拍。没有拍点时退回均匀网格（BPM 或 96 备用拍）。
 */
export class BeatTracker {
  private beats: number[] = []
  private index = 0
  private periodSec = beatDurationMs(0) / 1000
  private nextSec = 0
  private lastSec = 0

  /** 以 BPM 与拍点重置；`beats` 可为空。 */
  setRhythm(bpm: number, beats: readonly number[]): void {
    this.beats = [...beats]
    this.periodSec = bpm > 0 ? 60 / bpm : beatDurationMs(0) / 1000
    this.reset(0)
  }

  /** 跳到某个播放位置（起播、暂停恢复、拖动进度）。 */
  reset(position: number): void {
    const clamped = Math.max(0, position)
    this.lastSec = clamped
    if (this.beats.length > 0) {
      const index = nextBeatIndex(this.beats, clamped)
      this.index = index
      if (index < this.beats.length) {
        this.nextSec = this.beats[index]
      } else {
        const last = this.beats[this.beats.length - 1]
        let next = last + this.periodSec
        while (next <= clamped) next += this.periodSec
        this.nextSec = next
      }
    } else {
      this.index = 0
      this.nextSec = clamped
    }
  }

  /** 推进到 `position`；返回这一步是否跨过了新的拍点。 */
  update(position: number): boolean {
    const clamped = Math.max(0, position)
    let fired = false
    if (this.beats.length > 0 && this.index < this.beats.length) {
      while (
        this.index < this.beats.length &&
        this.beats[this.index] <= clamped + 0.005
      ) {
        // 只把刚越过的拍算作触发，切歌/seek 后不补放一串旧拍。
        if (this.beats[this.index] >= clamped - 0.25) fired = true
        this.index += 1
      }
      if (this.index < this.beats.length) {
        this.nextSec = this.beats[this.index]
      } else {
        const last = this.beats[this.beats.length - 1]
        let next = last + this.periodSec
        while (next <= clamped) next += this.periodSec
        this.nextSec = next
      }
    }
    if (this.index >= this.beats.length) {
      let guard = 0
      while (this.nextSec <= clamped + 0.005 && guard < 32) {
        fired = true
        this.nextSec += this.periodSec
        guard += 1
      }
    }
    this.lastSec = clamped
    return fired
  }

  /** 距下一拍的毫秒数（供 `SvgSprite` 种子相位）。 */
  get nextBeatMs(): number {
    return Math.max(0, (this.nextSec - this.lastSec) * 1000)
  }
}