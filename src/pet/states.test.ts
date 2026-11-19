import { describe, expect, it } from 'vitest'
import {
  IDLE_BEATS,
  PET_STATES,
  breathBeatOption,
  builtinBeatOptions,
  isPetStateId,
  packBeatOptions,
  petState,
  pickIdleBeat,
  pickPackBeat,
  playbackFor,
  poseForLine,
  type Mood,
  type SpeechPlayback,
} from './states'

describe('器灵姿势', () => {
  it('covers the five poses', () => {
    expect(PET_STATES.map((state) => state.id)).toEqual([
      'idle',
      'explain',
      'think',
      'advantage',
      'disadvantage',
    ])
    expect(isPetStateId('cry')).toBe(false)
    expect(petState('explain').label).toBe('讲解')
  })

  it('breaks the breath with a butterfly, and rarely with anger', () => {
    expect(pickIdleBeat(0)).toBe('angry')
    expect(pickIdleBeat(0.01)).toBe('butterfly')
    expect(pickIdleBeat(0.21)).toBe('breath')
  })

  function pose(mood: Mood, playback: SpeechPlayback = 'playing', voice = true) {
    return poseForLine({ phase: 'say', mood, voice, playback })
  }

  it('follows mood while the line is being spoken', () => {
    expect(poseForLine({ phase: 'idle', mood: 'up', voice: true, playback: 'done' })).toBe('idle')
    expect(poseForLine({ phase: 'thinking', mood: 'up', voice: true, playback: 'playing' })).toBe('think')
    expect(pose('up', 'waiting')).toBe('think')
    expect(pose('up', 'done')).toBe('idle')
    expect(pose('up', 'playing', false)).toBe('advantage')
    expect(pose('down')).toBe('disadvantage')
    expect(pose('neutral')).toBe('explain')
  })

  it('stays quiet until this line is actually audible', () => {
    const line = '这步不错'
    expect(playbackFor({ voice: true, phase: 'say', text: line, audible: false, audibleLine: '', heardLine: '' })).toBe('waiting')
    expect(playbackFor({ voice: true, phase: 'say', text: line, audible: true, audibleLine: line, heardLine: '' })).toBe('playing')
    expect(playbackFor({ voice: true, phase: 'say', text: line, audible: false, audibleLine: '', heardLine: line })).toBe('done')
    expect(playbackFor({ voice: true, phase: 'thinking', text: line, audible: true, audibleLine: '', heardLine: '' })).toBe('done')
    expect(playbackFor({ voice: false, phase: 'say', text: line, audible: false, audibleLine: '', heardLine: '' })).toBe('done')
  })

  it('drops built-in beats whose tracks are missing', () => {
    const onlyBreath = builtinBeatOptions((track) => track === 'idle')
    expect(onlyBreath.map((option) => option.key)).toEqual(['breath'])
    expect(onlyBreath[0]).toMatchObject({ track: 'idle', line: IDLE_BEATS.breath.line })
  })

  it('gives the svg character nothing but breathing', () => {
    expect(breathBeatOption()).toMatchObject({
      key: 'breath',
      track: 'idle',
      line: IDLE_BEATS.breath.line,
      ms: IDLE_BEATS.breath.ms,
    })
  })

  it('uses declared pack beats, or butterfly/angry as the fallback', () => {
    const declared = packBeatOptions(
      [{ action: 'splash', line: '扑通' }],
      (track) => track === 'idle' || track === 'splash',
    )
    expect(declared.map((option) => option.key)).toEqual(['breath', 'splash'])
    expect(pickPackBeat(0.05, declared).key).toBe('splash')
    expect(pickPackBeat(0.5, declared).key).toBe('breath')

    const fallback = packBeatOptions([], (track) => track === 'idle' || track === 'butterfly')
    expect(fallback.map((option) => option.key)).toEqual(['breath', 'butterfly'])
    expect(pickPackBeat(0.05, [fallback[0]]).key).toBe('breath')
  })
})
