import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MUSIC_TUNING } from '../pet/music'
import {
  defaultPetSettings,
  isValidWakeWord,
  isValidEdgeVoice,
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

  it('persists the selected Edge voice and defaults older settings', () => {
    saveQiLingSettings({ ...defaultPetSettings, edgeVoice: 'zh-CN-YunxiNeural' })
    expect(loadQiLingSettings().edgeVoice).toBe('zh-CN-YunxiNeural')

    localStorage.setItem('qiling.settings', JSON.stringify({ voice: true }))
    expect(loadQiLingSettings().edgeVoice).toBe(defaultPetSettings.edgeVoice)
  })

  it('listens to music by default and remembers turning it off', () => {
    expect(defaultPetSettings.music).toBe(true)
    localStorage.setItem('qiling.settings', JSON.stringify({ voice: true }))
    expect(loadQiLingSettings().music).toBe(true)

    saveQiLingSettings({ ...defaultPetSettings, music: false })
    expect(loadQiLingSettings().music).toBe(false)
  })

  it('keeps music on for settings written before the switch existed', () => {
    localStorage.setItem(
      'qiling.settings',
      JSON.stringify({ voice: true, bubble: false, edgeVoice: 'zh-CN-XiaoyiNeural' }),
    )
    expect(loadQiLingSettings().music).toBe(true)
  })

  it('defaults music thresholds for older settings', () => {
    localStorage.setItem('qiling.settings', JSON.stringify({ music: true }))
    expect(loadQiLingSettings().musicTuning).toEqual(DEFAULT_MUSIC_TUNING)
  })

  it('persists the music thresholds the user adjusted', () => {
    saveQiLingSettings({
      ...defaultPetSettings,
      musicTuning: {
        ...DEFAULT_MUSIC_TUNING,
        enterScore: 0.45,
        exitScore: 0.25,
        enterGroove: 0.7,
        exitGroove: 0.35,
        enterIntense: 0.92,
        exitIntense: 0.8,
      },
    })
    expect(loadQiLingSettings().musicTuning).toEqual({
      ...DEFAULT_MUSIC_TUNING,
      enterScore: 0.45,
      exitScore: 0.25,
      enterGroove: 0.7,
      exitGroove: 0.35,
      enterIntense: 0.92,
      exitIntense: 0.8,
    })
  })

  it('repairs a stored hysteresis band that would never switch', () => {
    localStorage.setItem(
      'qiling.settings',
      JSON.stringify({ musicTuning: { enterScore: 0.2, exitScore: 0.9 } }),
    )
    const tuning = loadQiLingSettings().musicTuning
    expect(tuning.exitScore).toBeLessThan(tuning.enterScore)
  })

  it('rejects invalid Edge voice identifiers', () => {
    expect(isValidEdgeVoice('zh-CN-XiaoxiaoNeural')).toBe(true)
    expect(isValidEdgeVoice('../voice')).toBe(false)
    expect(isValidEdgeVoice('')).toBe(false)
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
