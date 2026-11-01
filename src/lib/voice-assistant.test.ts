import { describe, expect, it } from 'vitest'
import {
  shouldResumeListening,
  WAKE_ACKNOWLEDGMENT,
  voiceAssistantStateLabel,
} from './voice-assistant'

const acknowledgment = {
  state: 'wake_acknowledgment',
  voice: true,
  phase: 'say',
  text: WAKE_ACKNOWLEDGMENT,
  speaking: true,
  heardLine: '',
  lineChanged: true,
}

describe('wake-word acknowledgment', () => {
  it('starts request recognition only after the acknowledgment finishes', () => {
    expect(shouldResumeListening(acknowledgment)).toBe(false)
    expect(
      shouldResumeListening({
        ...acknowledgment,
        speaking: false,
        heardLine: WAKE_ACKNOWLEDGMENT,
      }),
    ).toBe(true)
  })

  it('continues listening without an audible reply when voice output is disabled', () => {
    expect(
      shouldResumeListening({
        ...acknowledgment,
        voice: false,
        speaking: false,
      }),
    ).toBe(true)
  })

  it('does not resume recognition after leaving the acknowledgment state', () => {
    expect(
      shouldResumeListening({
        ...acknowledgment,
        state: 'recognizing',
        voice: false,
        speaking: false,
      }),
    ).toBe(false)
  })
})

describe('voice reply keeps the microphone closed until it is heard', () => {
  const answer = {
    state: 'responding',
    voice: true,
    phase: 'say',
    text: '今天是十一月一日。',
    speaking: true,
    heardLine: '',
    lineChanged: true,
  }

  it('waits while the model is still thinking and while the answer plays', () => {
    expect(
      shouldResumeListening({ ...answer, phase: 'thinking', text: '' }),
    ).toBe(false)
    expect(shouldResumeListening(answer)).toBe(false)
  })

  it('returns to wake listening only after the answer was spoken', () => {
    expect(shouldResumeListening({ ...answer, speaking: false })).toBe(false)
    expect(
      shouldResumeListening({
        ...answer,
        speaking: false,
        heardLine: answer.text,
      }),
    ).toBe(true)
  })

  it('ignores the previous answer that is still on screen when a turn starts', () => {
    const stale = {
      ...answer,
      text: '上一次的回答。',
      speaking: false,
      heardLine: '上一次的回答。',
      lineChanged: false,
    }
    expect(shouldResumeListening(stale)).toBe(false)
  })

  it('reopens the microphone immediately when voice output is disabled', () => {
    expect(shouldResumeListening({ ...answer, voice: false })).toBe(true)
  })

  it('shows a distinct label while the pet is answering', () => {
    expect(voiceAssistantStateLabel('responding')).toContain('暂不收音')
  })
})
