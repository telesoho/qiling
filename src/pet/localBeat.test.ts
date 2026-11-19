import { describe, expect, it } from 'vitest'
// @ts-ignore -- node:fs 只有测试用；项目 tsconfig 不引入 Node 类型
import { readFileSync } from 'node:fs'
import { analyseLocalTempo } from './localBeat'

const SAMPLE_RATE = 16_000

/** 读仓库里的 16-bit PCM WAV（只用于测试），返回单声道 float。 */
interface WavBuffer {
  length: number
  readUInt16LE(offset: number): number
  readUInt32LE(offset: number): number
  readInt16LE(offset: number): number
  toString(encoding: string, start?: number, end?: number): string
}

function readWav(url: URL): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(url) as unknown as WavBuffer
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const bits = buffer.readUInt16LE(34)
  expect(bits).toBe(16)
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      const frames = Math.floor(size / (2 * channels))
      const samples = new Float32Array(frames)
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0
        for (let channel = 0; channel < channels; channel += 1) {
          sum += buffer.readInt16LE(offset + 8 + (frame * channels + channel) * 2) / 32768
        }
        samples[frame] = sum / channels
      }
      return { samples, sampleRate }
    }
    offset += 8 + size
  }
  throw new Error('wav data chunk not found')
}

/** 合成一段 90Hz 衰减鼓点；只在测试里用，不依赖外部音频。 */
function clickTrack(bpm: number, seconds = 24): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  const period = 60 / bpm
  const clickLength = Math.round(0.04 * SAMPLE_RATE)
  for (let beat = 0; beat * period < seconds; beat += 1) {
    const start = Math.round(beat * period * SAMPLE_RATE)
    for (let offset = 0; offset < clickLength; offset += 1) {
      const index = start + offset
      if (index >= samples.length) break
      const t = offset / SAMPLE_RATE
      samples[index] += Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t * 70)
    }
  }
  return samples
}

function noise(length: number, seed = 1): Float32Array {
  let state = seed
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    samples[index] = random() * 2 - 1
  }
  return samples
}

describe('曲库估速', () => {
  it('finds 120 BPM and a usable first beat', () => {
    const result = analyseLocalTempo(clickTrack(120), SAMPLE_RATE)
    expect(result.bpm).toBeGreaterThanOrEqual(117)
    expect(result.bpm).toBeLessThanOrEqual(123)
    expect(result.confidence).toBeGreaterThan(0.3)
    expect(result.firstBeatSec).toBeGreaterThanOrEqual(0)
    expect(result.firstBeatSec).toBeLessThan(0.5)
  })

  it('finds 90 and 60 BPM', () => {
    expect(analyseLocalTempo(clickTrack(90), SAMPLE_RATE).bpm).toBeGreaterThanOrEqual(87)
    expect(analyseLocalTempo(clickTrack(90), SAMPLE_RATE).bpm).toBeLessThanOrEqual(93)
    expect(analyseLocalTempo(clickTrack(60), SAMPLE_RATE).bpm).toBeGreaterThanOrEqual(57)
    expect(analyseLocalTempo(clickTrack(60), SAMPLE_RATE).bpm).toBeLessThanOrEqual(63)
  })

  it('drives fast songs at half tempo, matching the prototype orientation', () => {
    // 设计取向：≥140 BPM 时，半拍候选（65–105）足够规整就按半拍驱动动画。
    const result = analyseLocalTempo(clickTrack(150), SAMPLE_RATE)
    expect(result.bpm).toBeGreaterThanOrEqual(72)
    expect(result.bpm).toBeLessThanOrEqual(78)
  })

  it('returns no tempo for silence and noise', () => {
    expect(analyseLocalTempo(new Float32Array(SAMPLE_RATE * 4), SAMPLE_RATE).bpm).toBe(0)
    expect(analyseLocalTempo(noise(SAMPLE_RATE * 4), SAMPLE_RATE).bpm).toBe(0)
  })

  it('returns no tempo when there are too few samples', () => {
    expect(analyseLocalTempo(new Float32Array(100), SAMPLE_RATE).bpm).toBe(0)
  })

  it('matches the bundled 120 BPM calibration track', () => {
    const wav = readWav(
      new URL('../../design/characters/lingpao/_workshop/test-120bpm.wav', import.meta.url),
    )
    const result = analyseLocalTempo(wav.samples, wav.sampleRate)
    expect(result.bpm).toBeGreaterThanOrEqual(117)
    expect(result.bpm).toBeLessThanOrEqual(123)
    expect(result.confidence).toBeGreaterThan(0.3)
    expect(result.firstBeatSec).toBeGreaterThanOrEqual(0)
    expect(result.firstBeatSec).toBeLessThan(60 / result.bpm + 0.01)
  })
})