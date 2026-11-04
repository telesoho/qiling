import { describe, expect, it } from 'vitest'
import { defaultBubbleSnap, sanitizeBubble } from './bubbleSync'

describe('气泡同步', () => {
  it('defaults the character name to the built-in one', () => {
    expect(sanitizeBubble(null)).toEqual({ ...defaultBubbleSnap })
    expect(sanitizeBubble({ name: '   ' }).name).toBe('诗琚')
  })

  it('keeps a pack character name and caps its length', () => {
    expect(sanitizeBubble({ name: ' 大肥鱼 ' }).name).toBe('大肥鱼')
    expect(sanitizeBubble({ name: 'x'.repeat(50) }).name).toHaveLength(40)
  })
})
