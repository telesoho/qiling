/**
 * 本地文件节拍分析：直接用设计原型 `lingpao-groove.html` 同款的
 * libsonare analysis-only WASM（`analyzeBpm` + `detectBeats`）。
 *
 * 只用 1.09 MB 的 analysis 模块，并按需动态加载：只有真正播放曲库时才拉取
 * JS 与 WASM，不影响桌宠启动。WASM 通过 Vite 的 `?url` 资源在运行时 fetch，
 * 再以 `wasmBinary` 交给 `init()`，避免依赖 Emscripten 的相对路径猜测。
 */
import wasmUrl from '@libraz/libsonare/wasm/analysis?url'

export interface LocalRhythm {
  /** 分析器的主 BPM；拍点不可用时作为兜底。 */
  bpm: number
  confidence: number
  /** 逐拍时间（秒，相对音频开头）。 */
  beats: number[]
}

type AnalysisModule = typeof import('@libraz/libsonare/analysis')

let loading: Promise<AnalysisModule> | null = null

async function load(): Promise<AnalysisModule> {
  if (!loading) {
    loading = (async () => {
      const module = await import('@libraz/libsonare/analysis')
      const response = await fetch(wasmUrl)
      if (!response.ok) {
        throw new Error(`libsonare wasm ${response.status}`)
      }
      const wasmBinary = await response.arrayBuffer()
      await module.init({ wasmBinary })
      return module
    })().catch((error: unknown) => {
      loading = null
      throw error
    })
  }
  return loading
}

/** 在同一份 16 kHz 单声道样本上估速并取逐拍时间。 */
export async function analyseLocalRhythm(
  mono: Float32Array,
  sampleRate: number,
): Promise<LocalRhythm> {
  const sonare = await load()
  const result = sonare.analyzeBpm(mono, sampleRate, {
    bpmMin: 30,
    bpmMax: 300,
    maxCandidates: 7,
  })
  const beatValues = sonare.detectBeats(mono, sampleRate)
  const beats: number[] = []
  for (let index = 0; index < beatValues.length; index += 1) {
    const value = Number(beatValues[index])
    if (Number.isFinite(value) && value >= 0) beats.push(value)
  }
  return {
    bpm: Number.isFinite(result.bpm) ? result.bpm : 0,
    confidence: Number.isFinite(result.confidence) ? result.confidence : 0,
    beats,
  }
}