import { describe, expect, it } from 'vitest'
import { BARGE_DUCK_GAIN, captionAt, duckQiLing, fallbackToSystem, pickChineseVoice, planUtterance, restoreQiLing, schedulePcmChunk, startVoiceTest, streamSpeakResult, VOICE_TEST_LINE, voiceEngineFor, voiceEngineLabel } from './speech'

describe('器灵语音', () => {
  it('speaks only a settled line, and stops when hidden or muted', () => {
    const line = '这步不错。'
    expect(planUtterance({ voice: true, visible: true, phase: 'analyzing', text: line, handled: '' }).action).toBe('stop')
    expect(planUtterance({ voice: true, visible: true, phase: 'ready', text: line, handled: '' })).toEqual({
      action: 'speak',
      line,
    })
    expect(planUtterance({ voice: true, visible: true, phase: 'ready', text: line, handled: line }).action).toBe('keep')
    expect(planUtterance({ voice: false, visible: true, phase: 'fallback', text: line, handled: '' }).action).toBe('stop')
  })

  it('prefers a zh-CN system voice', () => {
    expect(pickChineseVoice([
      { lang: 'en-US', name: 'Microsoft Zira' },
      { lang: 'zh-CN', name: 'Microsoft Huihui' },
    ])?.name).toBe('Microsoft Huihui')
  })

  it('uses Edge by default and preserves explicit local and system choices', () => {
    expect(voiceEngineFor(null)).toBe('edge')
    expect(voiceEngineFor({ ready: true })).toBe('edge')
    expect(voiceEngineFor(null, 'edge')).toBe('edge')
    expect(voiceEngineFor(null, 'cosyvoice')).toBe('cosyvoice')
    expect(voiceEngineFor({ ready: true }, 'system')).toBe('system')
    expect(voiceEngineLabel('edge')).toBe('Edge在线语音')
    expect(voiceEngineLabel('cosyvoice')).toBe('本地神经音')
    expect(fallbackToSystem('failed')).toBe(true)
    expect(fallbackToSystem('cancelled')).toBe(false)
  })

  it('reveals caption text in step with playback', () => {
    expect(captionAt('你好', 1, 2, true)).toBe('你')
    expect(captionAt('abcd', 0, 4, false)).toBe('')
  })

  it('abuts streamed chunks and does not repeat a line that already started', () => {
    const first = schedulePcmChunk(0, 1, 0.4)
    const second = schedulePcmChunk(first.next, 1.1, 0.25)
    expect(second.start).toBe(first.start + 0.4)
    expect(fallbackToSystem(streamSpeakResult({ chunks: 1, error: 'failed' }))).toBe(false)
    expect(fallbackToSystem(streamSpeakResult({ chunks: 0, error: 'failed' }))).toBe(true)
  })

  it('plays a preview line and settles when no voice engine is available', async () => {
    const playback = startVoiceTest(VOICE_TEST_LINE)
    await expect(playback.done).resolves.toBe('unavailable')
    expect(VOICE_TEST_LINE).toContain('试听')
  })

  it('stops a running preview without waiting for playback to end', async () => {
    const playback = startVoiceTest(VOICE_TEST_LINE)
    playback.stop()
    await expect(playback.done).resolves.toBe('unavailable')
  })

  it('ducks the voice before interruption and is harmless without a player', () => {
    expect(BARGE_DUCK_GAIN).toBeGreaterThan(0)
    expect(BARGE_DUCK_GAIN).toBeLessThan(1)
    // Nothing has been played yet, so there is no gain to move.
    expect(() => duckQiLing()).not.toThrow()
    expect(() => restoreQiLing()).not.toThrow()
  })
})
