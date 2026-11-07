/**
 * 验证曲库播放使用的 libsonare analysis-only WASM 能正确识别仓库自带的
 * 120 BPM 标定音频。运行时通过动态 import + `wasmBinary` 加载同一个模块。
 */
import { describe, expect, it } from 'vitest'
// @ts-ignore -- node:fs 只有测试用；项目 tsconfig 不引入 Node 类型
import { readFileSync } from 'node:fs'
import { detectBeats, init, analyzeBpm } from '@libraz/libsonare/analysis'

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

function decimate(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate
  const length = Math.floor(samples.length / ratio)
  const result = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let cursor = start; cursor < end && cursor < samples.length; cursor += 1) {
      sum += samples[cursor]
    }
    result[index] = sum / (end - start)
  }
  return result
}

describe('libsonare 曲库节拍分析', () => {
  it('finds 120 BPM and beat times on the bundled calibration track', async () => {
    const wasm = readFileSync(
      new URL(
        '../../node_modules/@libraz/libsonare/dist/sonare-analysis.wasm',
        import.meta.url,
      ),
    )
    await init({ wasmBinary: wasm as unknown as Uint8Array })
    const wav = readWav(
      new URL('../../design/characters/lingpao/_workshop/test-120bpm.wav', import.meta.url),
    )
    const samples16k = decimate(wav.samples, wav.sampleRate, 16_000)

    const result = analyzeBpm(samples16k, 16_000, {
      bpmMin: 30,
      bpmMax: 300,
      maxCandidates: 7,
    })
    const beats = detectBeats(samples16k, 16_000)

    expect(result.bpm).toBeGreaterThanOrEqual(117)
    expect(result.bpm).toBeLessThanOrEqual(123)
    expect(result.confidence).toBeGreaterThan(0.3)
    expect(beats.length).toBeGreaterThan(10)
    expect(beats[0]).toBeGreaterThanOrEqual(0)
  })
})