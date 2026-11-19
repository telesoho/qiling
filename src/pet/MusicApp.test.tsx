import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MusicApp, { playerStatusText } from './MusicApp'
import { defaultLocalMusicState, type LocalMusicState } from './localMusic'

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

function state(overrides: Partial<LocalMusicState> = {}): LocalMusicState {
  return { ...defaultLocalMusicState(0.6), ...overrides }
}

describe('曲库窗口', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memory(), configurable: true })
  })

  it('renders the empty library and disables playback outside the app', () => {
    const page = renderToStaticMarkup(<MusicApp />)
    expect(page).toContain('器灵 · 曲库')
    expect(page).toContain('曲库仅应用内可用')
    expect(page).toContain('正在播放')
    expect(page).toContain('从曲库选一首开始')
    expect(page).toContain('添加本地音乐…')
    expect(page).toContain('添加网络歌曲…')
    expect(page).toContain('清理网络缓存')
    expect(page).toContain('正在读取曲库…')
  })

  it('labels the player status for each state', () => {
    expect(playerStatusText(state(), null)).toBe('从曲库选一首开始')
    expect(playerStatusText(state({ status: 'loading' }), null)).toBe('正在准备音频与节拍…')
    expect(
      playerStatusText(
        state({ status: 'playing', trackId: 'a', bpm: 120, mood: 'groove' }),
        null,
      ),
    ).toBe('正在播放 · 120 BPM · 轻快')
    expect(
      playerStatusText(state({ status: 'playing', trackId: 'a', bpm: 0, mood: 'calm' }), null),
    ).toBe('正在播放 · 舒缓')
    expect(playerStatusText(state({ status: 'paused', trackId: 'a' }), null)).toBe('已暂停')
    expect(playerStatusText(state({ status: 'error', error: '解码失败' }), null)).toBe('解码失败')
    expect(
      playerStatusText(state(), { trackId: 'a', received: 512, total: 2048, done: false }),
    ).toBe('正在下载 25%')
    expect(
      playerStatusText(state(), { trackId: 'a', received: 512, total: 0, done: false }),
    ).toContain('正在下载')
  })
})