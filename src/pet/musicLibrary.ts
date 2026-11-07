/**
 * 曲库的运行时契约。
 *
 * 曲库本体由 Rust 持久化在应用配置目录（`music-library.json`），网络歌曲缓存
 * 在应用数据目录（`music-cache/`）。前端只负责展示、校验与调用命令；这里
 * 同时提供纯函数（URL 校验、名称建议、大小/格式文案），方便单测。
 */
import { invoke } from '@tauri-apps/api/core'

export type MusicTrackKind = 'local' | 'remote'

export interface MusicTrackView {
  id: string
  kind: MusicTrackKind
  name: string
  /** 本地绝对路径，或网络 http(s) 直链。 */
  location: string
  addedAt: number
  mime: string | null
  /** 本地文件还在，或网络歌曲已有缓存。 */
  available: boolean
  /** 网络歌曲是否已缓存到本机。 */
  cached: boolean
  cacheBytes: number
}

export interface MusicCacheStats {
  files: number
  bytes: number
}

export interface MusicLibraryView {
  tracks: MusicTrackView[]
  cache: MusicCacheStats
  storageDir: string
}

export interface RejectedMusicTrack {
  name: string
  reason: string
}

export interface AddLocalResult {
  library: MusicLibraryView
  addedIds: string[]
  rejected: RejectedMusicTrack[]
}

export const MUSIC_ERRORS: Record<string, string> = {
  music_library_unavailable: '曲库暂时无法读写，请稍后重试。',
  music_library_invalid: '曲库文件格式不正确。',
  music_library_full: '曲库已满（最多 1000 首）。',
  music_library_empty: '曲库还是空的，先添加音乐吧。',
  music_track_missing: '这首曲子已不在曲库里。',
  music_remote_url_invalid: '请填写 http(s) 开头的音频直链。',
  music_remote_not_audio: '这个链接返回的不是可播放的音频文件。',
  music_download_failed: '网络歌曲下载失败，请检查链接或网络。',
  music_download_too_large: '音频文件超过 64 MB，暂不支持。',
  music_download_timeout: '下载超时，请稍后重试。',
  music_file_missing: '本地文件不存在或已被移动。',
  music_file_too_large: '音频文件超过 64 MB，暂不支持。',
  music_format_unsupported: '不支持这个音频格式。',
  music_decode_failed: '无法解码这个音频文件。',
  music_too_long: '音频超过 10 分钟，暂不支持。',
  music_audio_blocked: '系统阻止了音频播放，请重试。',
  music_audio_unsupported: '当前环境不支持播放音频。',
}

/** 把后端错误码转成中文；未知错误保留原因，便于排查。 */
export function musicErrorMessage(reason: unknown): string {
  const code = String(reason)
  const direct = MUSIC_ERRORS[code]
  if (direct) return direct
  const known = Object.keys(MUSIC_ERRORS).find((key) => code.includes(key))
  return known ? MUSIC_ERRORS[known] : `音乐功能暂时不可用：${code}`
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

export function extensionOf(value: string): string {
  const clean = value.split('?')[0]?.split('#')[0] ?? ''
  const dot = clean.lastIndexOf('.')
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (dot <= slash) return ''
  return clean.slice(dot + 1).toLowerCase()
}

/** 取曲目的 MIME；本地文件按扩展名兜底，网络歌曲下载后由后端回填。 */
export function mimeForTrack(track: { name: string; location: string; mime: string | null }): string {
  if (track.mime) return track.mime
  const extension = extensionOf(track.location) || extensionOf(track.name)
  return extension ? MIME_BY_EXTENSION[extension] ?? '' : ''
}

export function isSupportedAudioExtension(extension: string): boolean {
  return extension in MIME_BY_EXTENSION
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/** 网络歌曲的默认名称：URL 末段去扩展名，取不到就用域名。 */
export function suggestTrackName(url: string): string {
  try {
    const parsed = new URL(url.trim())
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1] ?? ''
    const stem = last.includes('.') ? last.slice(0, last.lastIndexOf('.')) : last
    if (stem) return decodeURIComponent(stem)
    return parsed.hostname
  } catch {
    return ''
  }
}

export function trackKindLabel(kind: MusicTrackKind): string {
  return kind === 'remote' ? '网络' : '本地'
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseTrack(value: unknown): MusicTrackView | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const kind = record.kind === 'local' || record.kind === 'remote' ? record.kind : null
  if (!kind) return null
  if (typeof record.id !== 'string' || !record.id) return null
  if (typeof record.name !== 'string' || typeof record.location !== 'string') return null
  return {
    id: record.id,
    kind,
    name: record.name,
    location: record.location,
    addedAt: numberOr(record.addedAt, 0),
    mime: typeof record.mime === 'string' && record.mime ? record.mime : null,
    available: record.available === true,
    cached: record.cached === true,
    cacheBytes: Math.max(0, numberOr(record.cacheBytes, 0)),
  }
}

export function parseMusicLibraryView(value: unknown): MusicLibraryView | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.tracks)) return null
  const tracks: MusicTrackView[] = []
  for (const item of record.tracks) {
    const track = parseTrack(item)
    if (track) tracks.push(track)
  }
  const cache =
    typeof record.cache === 'object' && record.cache !== null
      ? (record.cache as Record<string, unknown>)
      : {}
  return {
    tracks,
    cache: {
      files: Math.max(0, numberOr(cache.files, 0)),
      bytes: Math.max(0, numberOr(cache.bytes, 0)),
    },
    storageDir: typeof record.storageDir === 'string' ? record.storageDir : '',
  }
}

export async function loadMusicLibrary(): Promise<MusicLibraryView> {
  const view = parseMusicLibraryView(await invoke<unknown>('qiling_music_library_get'))
  if (!view) throw new Error('music_library_invalid')
  return view
}

export async function pickMusicFiles(): Promise<string[]> {
  const paths = await invoke<unknown>('qiling_music_pick_files')
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []
}

export async function addLocalMusic(paths: string[]): Promise<AddLocalResult> {
  const raw = (await invoke<unknown>('qiling_music_library_add_local', { paths })) as Record<
    string,
    unknown
  > | null
  const library = parseMusicLibraryView(raw?.library)
  if (!raw || !library) throw new Error('music_library_invalid')
  const addedIds = Array.isArray(raw.addedIds)
    ? raw.addedIds.filter((id): id is string => typeof id === 'string')
    : []
  const rejected = Array.isArray(raw.rejected)
    ? raw.rejected
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          name: typeof item.name === 'string' ? item.name : '未知文件',
          reason: typeof item.reason === 'string' ? item.reason : 'music_library_invalid',
        }))
    : []
  return { library, addedIds, rejected }
}

export async function addRemoteMusic(name: string, url: string): Promise<MusicLibraryView> {
  const view = parseMusicLibraryView(
    await invoke<unknown>('qiling_music_library_add_remote', { name, url }),
  )
  if (!view) throw new Error('music_library_invalid')
  return view
}

export async function removeMusicTrack(id: string): Promise<MusicLibraryView> {
  const view = parseMusicLibraryView(await invoke<unknown>('qiling_music_library_remove', { id }))
  if (!view) throw new Error('music_library_invalid')
  return view
}

export async function clearMusicLibrary(): Promise<MusicLibraryView> {
  const view = parseMusicLibraryView(await invoke<unknown>('qiling_music_library_clear'))
  if (!view) throw new Error('music_library_invalid')
  return view
}

export async function clearMusicCache(): Promise<MusicCacheStats> {
  const raw = (await invoke<unknown>('qiling_music_cache_clear')) as Record<string, unknown> | null
  return {
    files: Math.max(0, numberOr(raw?.files, 0)),
    bytes: Math.max(0, numberOr(raw?.bytes, 0)),
  }
}