import { describe, expect, it } from 'vitest'
import {
  shouldResumeAfterWakeAcknowledgment,
  WAKE_ACKNOWLEDGMENT,
} from './voice-assistant'

describe('wake-word acknowledgment', () => {
  it('starts request recognition only after the acknowledgment finishes', () => {
    const state = {
      state: 'wake_acknowledgment',
      voice: true,
      acknowledgmentWasAudible: true,
      speaking: true,
      heardLine: '',
    }

    expect(shouldResumeAfterWakeAcknowledgment(state)).toBe(false)
    expect(
      shouldResumeAfterWakeAcknowledgment({
        ...state,
        speaking: false,
        heardLine: WAKE_ACKNOWLEDGMENT,
      }),
    ).toBe(true)
  })

  it('continues listening without an audible reply when voice output is disabled', () => {
    expect(
      shouldResumeAfterWakeAcknowledgment({
        state: 'wake_acknowledgment',
        voice: false,
        acknowledgmentWasAudible: false,
        speaking: false,
        heardLine: '',
      }),
    ).toBe(true)
  })

  it('does not resume recognition after leaving the acknowledgment state', () => {
    expect(
      shouldResumeAfterWakeAcknowledgment({
        state: 'recognizing',
        voice: false,
        acknowledgmentWasAudible: false,
        speaking: false,
        heardLine: '',
      }),
    ).toBe(false)
  })
})
