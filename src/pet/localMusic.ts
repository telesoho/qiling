/**
 * 曲库播放的运行时契约（曲库窗口 ↔ 桌宠窗口）。
 *
 * 播放引擎常驻桌宠窗口，曲库窗口只发命令、收状态；两边都用这里的事件名与
 * 解析函数，避免把未经校验的 IPC payload 直接塞进音频引擎。
 */
import type { MutableRefObject } from 'react'
import type { MusicMood } from './music'
import { musicErrorMessage } from './musicLibrary'

export type LocalMusicStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface LocalMusicState {
  status: LocalMusicStatus
  trackId: string | null
  trackName: string
  positionSec: number
  durationSec: number
  volume: number
  bpm: number
  mood: MusicMood | null
  error: string
}

/** 交给 `SvgSprite` 的本地音乐快照：状态用 React state，20Hz 数据留在 ref。 */
export interface LocalMusicSense {
  active: boolean
  mood: MusicMood | null
  energy: MutableRefObject<number>
  bass: MutableRefObject<number>
  bpm: MutableRefObject<number>
  beatAt: MutableRefObject<number>
  nextBeatMs: MutableRefObject<number>
}

export type LocalMusicCommand =
  | { type: 'play' }
  | { type: 'playTrack'; id: string }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'stop' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'seek'; position: number }
  | { type: 'volume'; volume: number }
  | { type: 'requestState' }

export const MUSIC_COMMAND_EVENT = 'qiling-music-command'
export const MUSIC_STATE_EVENT = 'qiling-music-state'
export const MUSIC_PROGRESS_EVENT = 'qiling-music-progress'
export const MUSIC_DOWNLOAD_EVENT = 'qiling-music-download'

export const PLAYER_STORAGE_KEY = 'qiling.music.player'

export interface StoredPlayerState {
  version: 1
  currentId: string | null
  volume: number
}

export const DEFAULT_MUSIC_VOLUME = 0.8

export function clampVolume(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MUSIC_VOLUME
  return Math.max(0, Math.min(1, numeric))
}

export function defaultLocalMusicState(volume = DEFAULT_MUSIC_VOLUME): LocalMusicState {
  return {
    status: 'idle',
    trackId: null,
    trackName: '',
    positionSec: 0,
    durationSec: 0,
    volume,
    bpm: 0,
    mood: null,
    error: '',
  }
}

const STATUSES: LocalMusicStatus[] = ['idle', 'loading', 'playing', 'paused', 'error']

export function parseLocalMusicState(value: unknown): LocalMusicState | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const status = STATUSES.find((item) => item === record.status)
  if (!status) return null
  const mood =
    record.mood === 'calm' || record.mood === 'groove' || record.mood === 'intense'
      ? record.mood
      : null
  const number = (input: unknown, fallback = 0): number =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallback
  return {
    status,
    trackId: typeof record.trackId === 'string' && record.trackId ? record.trackId : null,
    trackName: typeof record.trackName === 'string' ? record.trackName : '',
    positionSec: Math.max(0, number(record.positionSec)),
    durationSec: Math.max(0, number(record.durationSec)),
    volume: clampVolume(record.volume),
    bpm: Math.max(0, number(record.bpm)),
    mood,
    error: typeof record.error === 'string' ? record.error : '',
  }
}

export function parseLocalMusicCommand(value: unknown): LocalMusicCommand | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  switch (record.type) {
    case 'play':
    case 'pause':
    case 'toggle':
    case 'stop':
    case 'next':
    case 'previous':
    case 'requestState':
      return { type: record.type }
    case 'playTrack':
      return typeof record.id === 'string' && record.id
        ? { type: 'playTrack', id: record.id }
        : null
    case 'seek': {
      const position = record.position
      return typeof position === 'number' && Number.isFinite(position)
        ? { type: 'seek', position: Math.max(0, position) }
        : null
    }
    case 'volume': {
      const volume = record.volume
      return typeof volume === 'number' && Number.isFinite(volume)
        ? { type: 'volume', volume: clampVolume(volume) }
        : null
    }
    default:
      return null
  }
}

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function loadPlayerState(): StoredPlayerState {
  const store = storage()
  const fallback: StoredPlayerState = {
    version: 1,
    currentId: null,
    volume: DEFAULT_MUSIC_VOLUME,
  }
  if (!store) return fallback
  try {
    const raw = store.getItem(PLAYER_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<StoredPlayerState>
    return {
      version: 1,
      currentId: typeof parsed.currentId === 'string' && parsed.currentId ? parsed.currentId : null,
      volume: clampVolume(parsed.volume),
    }
  } catch {
    return fallback
  }
}

export function savePlayerState(state: StoredPlayerState): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(
      PLAYER_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        currentId: typeof state.currentId === 'string' && state.currentId ? state.currentId : null,
        volume: clampVolume(state.volume),
      }),
    )
  } catch {
    // 隐私模式/配额不足时保留内存里的状态即可。
  }
}

export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const rest = safe % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

export function localMusicErrorMessage(reason: unknown): string {
  return musicErrorMessage(reason)
}