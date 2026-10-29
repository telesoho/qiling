const STORAGE_KEY = 'qiling.settings'

export interface PetSettings {
  voice: boolean
  bubble: boolean
}

export const defaultPetSettings: PetSettings = {
  voice: true,
  bubble: true,
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
