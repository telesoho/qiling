import { describe, expect, it } from 'vitest'
import { captionAt, fallbackToSystem, pickChineseVoice, planUtterance, schedulePcmChunk, streamSpeakResult, voiceEngineFor, voiceEngineLabel } from './speech'

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

  it('uses CosyVoice only when the local service is ready', () => {
    expect(voiceEngineFor(null)).toBe('system')
    expect(voiceEngineFor({ ready: true })).toBe('cosyvoice')
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
})
