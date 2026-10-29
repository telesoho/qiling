import { LinePhase, Mood } from '../pet/states'

export interface PetLine {
  phase: LinePhase
  text: string
  mood: Mood
}

export const idleLine: PetLine = { phase: 'idle', text: '', mood: 'neutral' }

const KEY = 'qiling.line'

function moodOf(value: unknown): Mood {
  return value === 'up' || value === 'down' ? value : 'neutral'
}

function phaseOf(value: unknown): LinePhase {
  return value === 'thinking' || value === 'say' ? value : 'idle'
}

export function sanitizeLine(value: Partial<PetLine> | null | undefined): PetLine {
  return {
    phase: phaseOf(value?.phase),
    text: typeof value?.text === 'string' ? value.text : '',
    mood: moodOf(value?.mood),
  }
}

export function readLine(): PetLine {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    const phase = params.get('phase')
    if (phase === 'thinking' || phase === 'say' || phase === 'idle') {
      return sanitizeLine({ phase, text: params.get('text') ?? '', mood: moodOf(params.get('mood')) })
    }
  }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...idleLine }
    return sanitizeLine(JSON.parse(raw) as Partial<PetLine>)
  } catch {
    return { ...idleLine }
  }
}

export function publishLine(line: PetLine): void {
  const safe = sanitizeLine(line)
  try {
    localStorage.setItem(KEY, JSON.stringify(safe))
  } catch {
    // private mode
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('qiling-line'))
}

export function subscribeLine(onChange: (line: PetLine) => void): () => void {
  const pull = () => onChange(readLine())
  window.addEventListener('qiling-line', pull)
  let stop: (() => void) | undefined
  let cancelled = false
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<PetLine>('qiling-line', (event) => {
      const line = sanitizeLine(event.payload)
      try {
        localStorage.setItem(KEY, JSON.stringify(line))
      } catch {
        // the event itself is enough for this window
      }
      onChange(line)
    }))
    .then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    .catch(() => {})
  return () => {
    cancelled = true
    window.removeEventListener('qiling-line', pull)
    stop?.()
  }
}
