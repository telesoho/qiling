/**
 * 运行时多轨目录。
 *
 * 安装包里没有 design/，运行时读的是 scripts/bake_pet_anim.mjs 生成的
 * public/pet/anim/manifest.json 与 <track-id>/track_struct.json。
 * 每个轨的资产路径在加载时解析成绝对 URL，再交给 <img> 或 Canvas 播放。
 */

export interface AnimFrameSequence {
  type: 'frameSequence'
  dir: string
  pattern?: string
  zeroPad?: number
  from: number
  to: number
}

export interface AnimAnimatedWebp {
  type: 'animatedWebp'
  src: string
  fps?: number
  /** 烘焙时读取的整段时长（毫秒），用于 idle 节拍。 */
  durationMs?: number
}

export type AnimAsset = AnimFrameSequence | AnimAnimatedWebp

export interface AnimPhase {
  label?: string
  playback?: 'loop' | 'once'
  asset: AnimAsset
  onHoldComplete?: string
  fallback?: string
}

export interface AnimManifestTrack {
  id: string
  displayName?: string
  path: string
  tags?: string[]
}

export interface AnimManifest {
  version: string
  defaultTrack?: string
  tracks: AnimManifestTrack[]
}

export interface AnimTrack {
  id: string
  displayName?: string
  version?: string
  fps: number
  frameSize: { width: number; height: number }
  phases: Record<string, AnimPhase>
  interrupt?: Record<string, string>
  tags: string[]
  /** track_struct.json 的绝对 URL，相对资产路径以它为基准。 */
  baseUrl: string
}

export interface AnimLibrary {
  manifest: AnimManifest
  tracks: AnimTrack[]
  byId: Map<string, AnimTrack>
  byTag: (tag: string) => AnimTrack | undefined
}

interface RawFrameSequence extends Omit<AnimFrameSequence, 'dir'> {
  dir?: string
}

interface RawPhase extends Omit<AnimPhase, 'asset'> {
  asset?: AnimAnimatedWebp | RawFrameSequence
}

const MANIFEST_URL = '/pet/anim/manifest.json'
const DEFAULT_SIZE = { width: 180, height: 240 }

export function createLibrary(manifest: AnimManifest, tracks: AnimTrack[]): AnimLibrary {
  const byId = new Map(tracks.map((track) => [track.id, track]))
  return {
    manifest,
    tracks,
    byId,
    byTag: (tag) => tracks.find((track) => track.tags.includes(tag)),
  }
}

export function normalizeTrack(
  entry: AnimManifestTrack,
  raw: {
    id?: string
    displayName?: string
    version?: string
    fps?: number
    frameSize?: { width: number; height: number }
    phases?: Record<string, RawPhase>
    interrupt?: Record<string, string>
  },
  trackUrl: URL | string,
): AnimTrack {
  const base = typeof trackUrl === 'string' ? new URL(trackUrl) : trackUrl
  const phases: Record<string, AnimPhase> = {}
  for (const [name, phase] of Object.entries(raw.phases ?? {})) {
    const asset = phase.asset
    if (!asset) continue
    if (asset.type === 'animatedWebp') {
      phases[name] = { ...phase, asset: { ...asset, src: new URL(asset.src, base).href } }
    } else {
      phases[name] = {
        ...phase,
        asset: {
          ...asset,
          dir: (asset.dir ?? 'frames').replace(/\/$/, ''),
          pattern: asset.pattern ?? 'frame{NNN}.webp',
          zeroPad: asset.zeroPad ?? 3,
        },
      }
    }
  }
  return {
    id: raw.id ?? entry.id,
    displayName: raw.displayName ?? entry.displayName,
    version: raw.version,
    fps: raw.fps ?? 24,
    frameSize: raw.frameSize ?? DEFAULT_SIZE,
    phases,
    interrupt: raw.interrupt,
    tags: entry.tags ?? [],
    baseUrl: base.href,
  }
}

let cached: Promise<AnimLibrary> | null = null

/** 读运行时 manifest 与全部 track_struct；目录缺失时整体 reject。 */
export function loadAnimLibrary(): Promise<AnimLibrary> {
  if (cached) return cached
  cached = (async () => {
    const manifestUrl = new URL(MANIFEST_URL, window.location.href)
    const response = await fetch(manifestUrl, { cache: 'no-cache' })
    if (!response.ok) throw new Error(`读取动画目录失败：${response.status}`)
    const manifest = (await response.json()) as AnimManifest
    const results = await Promise.allSettled(
      (manifest.tracks ?? []).map(async (entry) => {
        const trackUrl = new URL(entry.path, manifestUrl)
        const trackResponse = await fetch(trackUrl, { cache: 'no-cache' })
        if (!trackResponse.ok) throw new Error(`读取轨道失败：${entry.path}`)
        return normalizeTrack(entry, await trackResponse.json(), trackUrl)
      }),
    )
    const tracks: AnimTrack[] = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        tracks.push(result.value)
      } else {
        console.warn('轨道读取失败', manifest.tracks[index]?.id, result.reason)
      }
    })
    return createLibrary(manifest, tracks)
  })()
  return cached
}

/** track 的 idle 相位若是 animatedWebP，直接给出图片 URL。 */
export function phaseImageUrl(track: AnimTrack | undefined, phaseName = 'idle'): string | undefined {
  const asset = track?.phases[phaseName]?.asset
  return asset?.type === 'animatedWebp' ? asset.src : undefined
}

/** animatedWebP 相位的整段时长（毫秒）；无烘焙数据时为 undefined。 */
export function phaseDurationMs(track: AnimTrack | undefined, phaseName = 'idle'): number | undefined {
  const asset = track?.phases[phaseName]?.asset
  return asset?.type === 'animatedWebp' ? asset.durationMs : undefined
}

/** 逐帧相位的第 frame 帧 URL。 */
export function frameUrl(track: AnimTrack, phaseName: string, frame: number): string | undefined {
  const asset = track.phases[phaseName]?.asset
  if (!asset || asset.type !== 'frameSequence') return undefined
  const name = (asset.pattern ?? 'frame{NNN}.webp').replace(
    '{NNN}',
    String(frame).padStart(asset.zeroPad ?? 3, '0'),
  )
  return new URL(`${asset.dir}/${name}`, track.baseUrl).href
}

/** 一个轨会用到全部图片 URL（逐帧展开），供预载。 */
export function trackImageUrls(track: AnimTrack): string[] {
  const urls: string[] = []
  for (const [name, phase] of Object.entries(track.phases)) {
    if (phase.asset.type === 'animatedWebp') {
      urls.push(phase.asset.src)
      continue
    }
    for (let frame = phase.asset.from; frame <= phase.asset.to; frame += 1) {
      const url = frameUrl(track, name, frame)
      if (url) urls.push(url)
    }
  }
  return urls
}

const images = new Map<string, HTMLImageElement>()
const loading = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(url: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null)
  const loaded = images.get(url)
  if (loaded) return Promise.resolve(loaded)
  const pending = loading.get(url)
  if (pending) return pending
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      images.set(url, image)
      loading.delete(url)
      resolve(image)
    }
    image.onerror = () => {
      loading.delete(url)
      resolve(null)
    }
    image.src = url
  })
  loading.set(url, promise)
  return promise
}

export function imageFor(url: string): HTMLImageElement | undefined {
  return images.get(url)
}

const preloading = new Map<string, Promise<void>>()

/** 预载一个轨的全部图片；逐帧轨最多 8 路并发。 */
export function preloadTrack(track: AnimTrack): Promise<void> {
  const existing = preloading.get(track.id)
  if (existing) return existing
  const promise = (async () => {
    const urls = trackImageUrls(track)
    let next = 0
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next]
        next += 1
        await loadImage(url)
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
  })()
  preloading.set(track.id, promise)
  return promise
}
