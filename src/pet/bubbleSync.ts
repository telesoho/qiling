const KEY = 'qiling.bubble'
const EVENT = 'qiling-bubble'

export interface BubbleSnap {
  text: string
  voice: boolean
  speaking: boolean
  open: boolean
}

export const defaultBubbleSnap: BubbleSnap = {
  text: '',
  voice: true,
  speaking: false,
  open: false,
}

export function sanitizeBubble(value: Partial<BubbleSnap> | null | undefined): BubbleSnap {
  return {
    text: typeof value?.text === 'string' ? value.text : '',
    voice: value?.voice !== false,
    speaking: value?.speaking === true,
    open: value?.open === true,
  }
}

export function readBubble(): BubbleSnap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...defaultBubbleSnap }
    return sanitizeBubble(JSON.parse(raw) as Partial<BubbleSnap>)
  } catch {
    return { ...defaultBubbleSnap }
  }
}

export function publishBubble(state: BubbleSnap): void {
  const safe = sanitizeBubble(state)
  try {
    localStorage.setItem(KEY, JSON.stringify(safe))
  } catch {
    // private mode or a non-browser test
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT))
  void import('@tauri-apps/api/event')
    .then(({ emit }) => emit(EVENT, safe))
    .catch(() => {})
}

export function subscribeBubble(onChange: (state: BubbleSnap) => void): () => void {
  const pull = () => onChange(readBubble())
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) pull()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(EVENT, pull)
  let stop: (() => void) | undefined
  let cancelled = false
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<BubbleSnap>(EVENT, (event) => onChange(sanitizeBubble(event.payload))))
    .then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    .catch(() => {})
  return () => {
    cancelled = true
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(EVENT, pull)
    stop?.()
  }
}
