/**
 * 曲库本地播放的兜底估速。
 *
 * 主路径与设计原型 `lingpao-groove.html` 一致，使用 libsonare 的
 * `analyzeBpm` + `detectBeats`（见 `sonareAnalysis.ts`）。这里保留一套轻量
 * 自相关实现：当 WASM 不可用/初始化失败时至少还能给出速度，再不行返回
 * bpm 0，由前端按 `MUSIC_TUNING.fallbackBpm`（96）继续摇摆。
 *
 * 10ms RMS 包络 → 起音 → 40–200 BPM 自相关；真实音乐上不如 libsonare 稳，
 * 所以只作兜底。
 */

/** 起音包络的帧长：10ms，和原型 / `music.rs` 的时间尺度一致。 */
const FRAME_SECONDS = 0.01
const MIN_BPM = 40
const MAX_BPM = 200
/** 低于这个自相关峰就不信任速度，交给 96 备用拍。 */
const MIN_CONFIDENCE = 0.18
/** 速度先验中心，避免把八分音符反拍认成两倍速。 */
const TEMPO_PRIOR_CENTER = 118
const TEMPO_PRIOR_WIDTH = 0.55
/**
 * 快歌的取向与原型 / `music.rs` 一致：≥140 BPM 时，如果半拍候选
 * （65–105）也足够规整，就按半拍驱动动画，避免灵泡跳得像在抖。
 */
const HALF_MIN_BPM = 65
const HALF_MAX_BPM = 105
const HALF_SCORE_RATIO = 0.9
/** 慢歌只有另一拍也明显存在时才加倍，避免把真正的 60 BPM 翻倍。 */
const DOUBLE_SCORE_RATIO = 0.92
/** 只分析前 3 分钟：速度对一首歌足够稳定，也避免长音频把主线程占住。 */
export const TEMPO_ANALYSIS_SECONDS = 180

export interface LocalTempo {
  /** 0 表示没估出来；调用方按 96 备用拍处理。 */
  bpm: number
  confidence: number
  /** 第一拍相对音频开头的秒数，0 ≤ firstBeatSec < 拍长。 */
  firstBeatSec: number
}

const EMPTY: LocalTempo = { bpm: 0, confidence: 0, firstBeatSec: 0 }

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / TEMPO_PRIOR_CENTER)
  return Math.exp(-0.5 * (octaves / TEMPO_PRIOR_WIDTH) ** 2)
}

function refineLag(scores: Float32Array, lag: number): number {
  const left = scores[lag - 1] ?? 0
  const center = scores[lag] ?? 0
  const right = scores[lag + 1] ?? 0
  const denominator = left - 2 * center + right
  if (Math.abs(denominator) < 1e-6) return lag
  const delta = (0.5 * (left - right)) / denominator
  return lag + Math.max(-0.5, Math.min(0.5, delta))
}

function autocorrelation(onset: Float32Array, minLag: number, maxLag: number): Float32Array {
  const scores = new Float32Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0
    let energyA = 0
    let energyB = 0
    const limit = onset.length - lag
    for (let index = 0; index < limit; index += 1) {
      const a = onset[index]
      const b = onset[index + lag]
      sum += a * b
      energyA += a * a
      energyB += b * b
    }
    const denominator = Math.sqrt(energyA * energyB)
    scores[lag] = denominator > 0 ? sum / denominator : 0
  }
  return scores
}

/** 取某个帧附近的最大起音，容忍估速的小数误差。 */
function onsetNear(onset: Float32Array, center: number, radius: number): number {
  let peak = 0
  for (let delta = -radius; delta <= radius; delta += 1) {
    const index = center + delta
    if (index >= 0 && index < onset.length && onset[index] > peak) peak = onset[index]
  }
  return peak
}

/**
 * 扫描相位：让拍点尽量落在起音上，返回第一拍所在的帧。
 *
 * 用小数拍长推进（不是取整后的拍长），否则 66.7 帧的 90 BPM 每 3 拍就会
 * 偏 1 帧，正好错过只有 1 帧宽的鼓点。
 */
function firstBeatFrame(onset: Float32Array, periodFrames: number): number {
  const period = Math.max(1, periodFrames)
  let bestOffset = 0
  let bestScore = -1
  const offsetCount = Math.ceil(period)
  for (let offset = 0; offset < offsetCount; offset += 1) {
    let sum = 0
    let count = 0
    for (let beat = 0; ; beat += 1) {
      const index = Math.round(offset + beat * period)
      if (index >= onset.length) break
      sum += onsetNear(onset, index, 1)
      count += 1
    }
    const score = count > 0 ? sum / count : 0
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }
  return bestOffset
}

/**
 * 节拍网格的"每拍都有起音"占比。
 *
 * 白噪声的起音包络也能自相关出某个峰值（稀疏随机点碰巧对齐），只看相关系数
 * 会把噪声当成音乐；真实节拍必须每一拍附近都有明显起音，噪声做不到。
 */
function beatOccupancy(
  onset: Float32Array,
  periodFrames: number,
  offset: number,
  maxOnset: number,
): number {
  const period = Math.max(1, periodFrames)
  const threshold = maxOnset * 0.25
  let beats = 0
  let hits = 0
  for (let beat = 0; ; beat += 1) {
    const center = Math.round(offset + beat * period)
    if (center >= onset.length) break
    beats += 1
    if (onsetNear(onset, center, 2) >= threshold) hits += 1
  }
  return beats > 0 ? hits / beats : 0
}

export function analyseLocalTempo(mono: Float32Array, sampleRate: number): LocalTempo {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return EMPTY
  const frameSamples = Math.max(1, Math.round(sampleRate * FRAME_SECONDS))
  const frameCount = Math.floor(mono.length / frameSamples)
  if (frameCount < 100) return EMPTY

  const rms = new Float32Array(frameCount)
  let maxRms = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    let squareSum = 0
    const start = frame * frameSamples
    for (let index = 0; index < frameSamples; index += 1) {
      const sample = mono[start + index] ?? 0
      squareSum += sample * sample
    }
    const value = Math.sqrt(squareSum / frameSamples)
    rms[frame] = value
    if (value > maxRms) maxRms = value
  }
  if (maxRms < 1e-5) return EMPTY

  // 起音包络：半波整流后再减掉 0.4s 的慢均值（原型的高通思路）。
  const diff = new Float32Array(frameCount)
  for (let frame = 1; frame < frameCount; frame += 1) {
    diff[frame] = Math.max(0, rms[frame] - rms[frame - 1])
  }
  const window = Math.max(1, Math.round(0.4 / FRAME_SECONDS))
  const onset = new Float32Array(frameCount)
  let rolling = 0
  let maxOnset = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    rolling += diff[frame]
    if (frame >= window) rolling -= diff[frame - window]
    const slow = rolling / Math.min(window, frame + 1)
    const value = Math.max(0, diff[frame] - slow)
    onset[frame] = value
    if (value > maxOnset) maxOnset = value
  }
  if (maxOnset < 1e-6) return EMPTY

  const minLag = Math.max(1, Math.round(60 / MAX_BPM / FRAME_SECONDS))
  const maxLag = Math.min(
    frameCount - 1,
    Math.round(60 / MIN_BPM / FRAME_SECONDS),
  )
  if (maxLag <= minLag) return EMPTY

  const scores = autocorrelation(onset, minLag, maxLag)
  let scoreSum = 0
  for (let index = minLag; index <= maxLag; index += 1) scoreSum += scores[index]
  const meanScore = scoreSum / (maxLag - minLag + 1)
  let bestLag = minLag
  let bestWeighted = -1
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const bpm = 60 / (lag * FRAME_SECONDS)
    const weighted = scores[lag] * (0.75 + 0.25 * tempoPrior(bpm))
    if (weighted > bestWeighted) {
      bestWeighted = weighted
      bestLag = lag
    }
  }

  let lag = refineLag(scores, bestLag)
  let bpm = 60 / (lag * FRAME_SECONDS)
  let confidence = scores[bestLag]

  // ≥140 BPM：半拍也规整时按半拍走。
  if (bpm >= 140) {
    const halfLag = Math.round(lag * 2)
    const halfBpm = bpm / 2
    if (
      halfLag <= maxLag &&
      halfBpm >= HALF_MIN_BPM &&
      halfBpm <= HALF_MAX_BPM &&
      scores[halfLag] >= confidence * HALF_SCORE_RATIO
    ) {
      lag = halfLag
      bpm = halfBpm
      confidence = scores[halfLag]
    }
  }
  // 慢歌：另一拍确实每一拍都有起音才加倍。
  if (bpm > 0 && bpm <= 70) {
    const doubleLag = Math.round(lag / 2)
    const doubleBpm = bpm * 2
    if (
      doubleLag >= minLag &&
      doubleBpm >= 70 &&
      doubleBpm <= 140 &&
      scores[doubleLag] >= confidence * DOUBLE_SCORE_RATIO
    ) {
      lag = doubleLag
      bpm = doubleBpm
      confidence = scores[doubleLag]
    }
  }

  confidence = Math.max(0, Math.min(1, confidence))
  if (confidence < MIN_CONFIDENCE || !Number.isFinite(bpm) || bpm <= 0) return EMPTY
  // 自相关峰必须明显高于平均：白噪声也能碰巧相关出 0.3 左右的峰。
  if (confidence < meanScore * 2 + 0.05) return EMPTY

  const offset = firstBeatFrame(onset, lag)
  const occupancy = beatOccupancy(onset, lag, offset, maxOnset)
  if (occupancy < 0.5) return EMPTY
  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence,
    firstBeatSec: offset * FRAME_SECONDS,
  }
}