import { beforeEach, describe, expect, it } from 'vitest'
import {
  defaultPetSettings,
  isValidWakeWord,
  loadQiLingSettings,
  saveQiLingSettings,
} from './settings'

const memory = () => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

describe('wake word settings', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memory(), configurable: true })
  })

  it('uses the default wake word when loading older settings', () => {
    localStorage.setItem('qiling.settings', JSON.stringify({ voice: false, bubble: true }))

    expect(loadQiLingSettings().wakeWord).toBe(defaultPetSettings.wakeWord)
    expect(loadQiLingSettings().voiceEngine).toBe('auto')
  })

  it('persists a valid custom wake word', () => {
    saveQiLingSettings({ ...defaultPetSettings, wakeWord: '小助手' })

    expect(loadQiLingSettings().wakeWord).toBe('小助手')
  })

  it('persists a selected speech engine', () => {
    saveQiLingSettings({ ...defaultPetSettings, voiceEngine: 'system' })

    expect(loadQiLingSettings().voiceEngine).toBe('system')
  })

  it.each(['', '器', '小 助手', '小助手123', '小助手小助手小助手'])(
    'rejects invalid wake word %j',
    (wakeWord) => {
      expect(isValidWakeWord(wakeWord)).toBe(false)
    },
  )

  it('accepts a short Chinese wake phrase', () => {
    expect(isValidWakeWord('小助手')).toBe(true)
  })
})
