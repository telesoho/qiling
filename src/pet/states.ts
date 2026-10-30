export const PET_STATES = [
  { id: 'idle', label: '待机', bubble: '待命', line: '在旁边看着', file: 'idle.webp', track: 'idle' },
  { id: 'explain', label: '讲解', bubble: '讲解中', line: '这一步这样看', file: 'explain.webp', track: 'explain' },
  { id: 'think', label: '思考', bubble: '思考中', line: '让我想想', file: 'think.webp', track: 'think' },
  { id: 'advantage', label: '优势', bubble: '占优', line: '这步不错', file: 'advantage.webp', track: 'advantage' },
  { id: 'disadvantage', label: '劣势', bubble: '当心', line: '这里要小心', file: 'disadvantage.webp', track: 'disadvantage' },
] as const

export type PetStateId = (typeof PET_STATES)[number]['id']
export type Mood = 'neutral' | 'up' | 'down'
export type LinePhase = 'idle' | 'thinking' | 'say'

export function petState(id: PetStateId) {
  return PET_STATES.find((state) => state.id === id) ?? PET_STATES[0]
}

/** Commenting poses show the line. Everything else shows the pose's short line. */
export function bubbleLine(stateId: PetStateId, text: string, idleLine?: string): string {
  const poseLine = (idleLine ?? petState(stateId).line).trim() || petState(stateId).line
  const commenting = stateId === 'explain' || stateId === 'advantage' || stateId === 'disadvantage'
  return commenting ? text.trim() || poseLine : poseLine
}

export function isPetStateId(value: string): value is PetStateId {
  return PET_STATES.some((state) => state.id === value)
}

/** Idle extras. `ms` is a fallback loop length; runtime prefers the track's baked `durationMs`. */
export const IDLE_BEATS = {
  breath: { file: 'idle.webp', line: '在旁边看着', ms: 3000, track: 'idle' },
  butterfly: { file: 'butterfly.webp', line: '有只蝴蝶', ms: 6125, track: 'butterfly' },
  angry: { file: 'angry.webp', line: '哼', ms: 6125, track: 'angry' },
} as const

export type IdleBeat = keyof typeof IDLE_BEATS

/** One roll in 0–1. Angry is 1%, butterfly the next 20%, else keep breathing. */
export function pickIdleBeat(roll: number): IdleBeat {
  if (roll < 0.01) return 'angry'
  if (roll < 0.21) return 'butterfly'
  return 'breath'
}

export type SpeechPlayback = 'waiting' | 'playing' | 'done'

/** Voice only counts once a say-line is actually playing. Thinking stays think either way. */
export function playbackFor(input: {
  voice: boolean
  phase: LinePhase
  text: string
  audible: boolean
  audibleLine: string
  heardLine: string
}): SpeechPlayback {
  const line = input.text.trim()
  if (!input.voice || input.phase !== 'say' || !line) return 'done'
  if (input.audible && input.audibleLine === line) return 'playing'
  if (input.heardLine === line) return 'done'
  return 'waiting'
}

function moodPose(mood: Mood): PetStateId {
  if (mood === 'up') return 'advantage'
  if (mood === 'down') return 'disadvantage'
  return 'explain'
}

/** Pose follows playback. A muted say-line keeps the mood pose. */
export function poseForLine(input: {
  phase: LinePhase
  mood: Mood
  voice: boolean
  playback: SpeechPlayback
}): PetStateId {
  if (input.phase === 'idle') return 'idle'
  if (input.phase === 'thinking') return 'think'
  if (input.voice && input.playback === 'waiting') return 'think'
  if (input.voice && input.playback === 'done') return 'idle'
  return moodPose(input.mood)
}
