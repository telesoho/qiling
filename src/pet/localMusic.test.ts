import { beforeEach, describe, expect, it } from 'vitest'
import {
  PLAYER_STORAGE_KEY,
  clampVolume,
  defaultLocalMusicState,
  formatClock,
  loadPlayerState,
  parseLocalMusicCommand,
  parseLocalMusicState,
  savePlayerState,
} from './localMusic'

const memory = () => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    },
  }
}

describe('曲库播放契约', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memory(), configurable: true })
  })

  it('parses a state payload and rejects unknown statuses', () => {
    const state = parseLocalMusicState({
      status: 'playing',
      trackId: 'song-1',
      trackName: '歌',
      positionSec: 12,
      durationSec: 180,
      volume: 0.4,
      bpm: 120,
      mood: 'groove',
      error: '',
    })
    expect(state?.status).toBe('playing')
    expect(state?.mood).toBe('groove')
    expect(state?.volume).toBeCloseTo(0.4)
    expect(parseLocalMusicState({ status: 'dancing' })).toBeNull()
    expect(parseLocalMusicState(null)).toBeNull()
  })

  it('parses commands and clamps user values', () => {
    expect(parseLocalMusicCommand({ type: 'play' })).toEqual({ type: 'play' })
    expect(parseLocalMusicCommand({ type: 'playTrack', id: 'a' })).toEqual({
      type: 'playTrack',
      id: 'a',
    })
    expect(parseLocalMusicCommand({ type: 'playTrack' })).toBeNull()
    expect(parseLocalMusicCommand({ type: 'seek', position: -3 })).toEqual({
      type: 'seek',
      position: 0,
    })
    expect(parseLocalMusicCommand({ type: 'volume', volume: 2 })).toEqual({
      type: 'volume',
      volume: 1,
    })
    expect(parseLocalMusicCommand({ type: 'volume', volume: 'loud' })).toBeNull()
    expect(parseLocalMusicCommand({ type: 'dance' })).toBeNull()
    expect(parseLocalMusicCommand(null)).toBeNull()
  })

  it('persists and restores the last track and volume', () => {
    savePlayerState({ version: 1, currentId: 'track-1', volume: 0.3 })
    const loaded = loadPlayerState()
    expect(loaded.currentId).toBe('track-1')
    expect(loaded.volume).toBeCloseTo(0.3)
    expect(localStorage.getItem(PLAYER_STORAGE_KEY)).toContain('track-1')
  })

  it('falls back when the stored player state is broken', () => {
    localStorage.setItem(PLAYER_STORAGE_KEY, '{')
    expect(loadPlayerState()).toEqual({ version: 1, currentId: null, volume: 0.8 })
  })

  it('clamps volume into 0..1', () => {
    expect(clampVolume(-1)).toBe(0)
    expect(clampVolume(2)).toBe(1)
    expect(clampVolume('x')).toBe(0.8)
    expect(clampVolume(0.25)).toBe(0.25)
  })

  it('formats playback time', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(61)).toBe('1:01')
    expect(formatClock(3599)).toBe('59:59')
    expect(formatClock(3661)).toBe('1:01:01')
    expect(formatClock(Number.NaN)).toBe('0:00')
  })

  it('starts idle', () => {
    const state = defaultLocalMusicState()
    expect(state.status).toBe('idle')
    expect(state.trackId).toBeNull()
    expect(state.error).toBe('')
  })
})