import {
  DEFAULT_MUSIC_TUNING,
  normalizeMusicTuning,
  type MusicTuning,
} from '../pet/music'

const STORAGE_KEY = 'qiling.settings'

export type VoiceEnginePreference = 'auto' | 'edge' | 'cosyvoice' | 'system'

export interface PetSettings {
  voice: boolean
  bubble: boolean
  voiceAssistant: boolean
  wakeWord: string
  voiceEngine: VoiceEnginePreference
  edgeVoice: string
  /** 听系统正在播放的音乐并自动切换灵泡的状态。默认开启。 */
  music: boolean
  /** 识别音乐用的可调阈值；旧设置没有这一项时回落到原型标定值。 */
  musicTuning: MusicTuning
}

export const defaultPetSettings: PetSettings = {
  voice: true,
  bubble: true,
  voiceAssistant: false,
  wakeWord: '器灵',
  voiceEngine: 'auto',
  edgeVoice: 'zh-CN-XiaoxiaoNeural',
  music: true,
  musicTuning: { ...DEFAULT_MUSIC_TUNING },
}

export function isValidWakeWord(wakeWord: string): boolean {
  return /^[\u4e00-\u9fff]{2,8}$/.test(wakeWord)
}

export function isVoiceEnginePreference(value: unknown): value is VoiceEnginePreference {
  return value === 'auto' || value === 'edge' || value === 'cosyvoice' || value === 'system'
}

export function isValidEdgeVoice(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function storage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function loadQiLingSettings(): PetSettings {
  const store = storage()
  if (!store) return { ...defaultPetSettings }
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultPetSettings }
    const parsed = JSON.parse(raw) as Partial<PetSettings>
    return {
      voice: parsed.voice !== false,
      bubble: parsed.bubble !== false,
      voiceAssistant: parsed.voiceAssistant === true,
      wakeWord: typeof parsed.wakeWord === 'string' && isValidWakeWord(parsed.wakeWord)
        ? parsed.wakeWord
        : defaultPetSettings.wakeWord,
      voiceEngine: isVoiceEnginePreference(parsed.voiceEngine)
        ? parsed.voiceEngine
        : defaultPetSettings.voiceEngine,
      edgeVoice: isValidEdgeVoice(parsed.edgeVoice)
        ? parsed.edgeVoice
        : defaultPetSettings.edgeVoice,
      music: parsed.music !== false,
      musicTuning: normalizeMusicTuning(parsed.musicTuning),
    }
  } catch {
    return { ...defaultPetSettings }
  }
}

export function saveQiLingSettings(settings: PetSettings): void {
  const store = storage()
  if (!store) return
  const safe: PetSettings = {
    voice: settings.voice !== false,
    bubble: settings.bubble !== false,
    voiceAssistant: settings.voiceAssistant === true,
    wakeWord: isValidWakeWord(settings.wakeWord)
      ? settings.wakeWord
      : defaultPetSettings.wakeWord,
    voiceEngine: isVoiceEnginePreference(settings.voiceEngine)
      ? settings.voiceEngine
      : defaultPetSettings.voiceEngine,
    edgeVoice: isValidEdgeVoice(settings.edgeVoice)
      ? settings.edgeVoice
      : defaultPetSettings.edgeVoice,
    music: settings.music !== false,
    musicTuning: normalizeMusicTuning(settings.musicTuning),
  }
  store.setItem(STORAGE_KEY, JSON.stringify(safe))
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('qiling-settings'))
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit('qiling-settings', loadQiLingSettings()))
    .catch(() => {})
}

export function watchQiLingSettings(onChange: (settings: PetSettings) => void): () => void {
  const pull = () => onChange(loadQiLingSettings())
  window.addEventListener('qiling-settings', pull)
  let stop: (() => void) | undefined
  let cancelled = false
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('qiling-settings', pull))
    .then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    .catch(() => {})
  return () => {
    cancelled = true
    window.removeEventListener('qiling-settings', pull)
    stop?.()
  }
}

export function closeSpeechBubble(): PetSettings {
  const next = { ...loadQiLingSettings(), bubble: false }
  saveQiLingSettings(next)
  return loadQiLingSettings()
}
