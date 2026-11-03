import { beforeEach, describe, expect, it } from 'vitest'
import { idleLine, initialPetLine, publishLine } from './line'

describe('pet speech line startup', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    })
  })

  it('does not replay the persisted line when the native pet starts', () => {
    publishLine({ phase: 'say', text: '上次的回答', mood: 'neutral' })

    expect(initialPetLine(true)).toEqual(idleLine)
  })

  it('keeps the stored preview line in browser mode', () => {
    publishLine({ phase: 'say', text: '浏览器预览', mood: 'up' })

    expect(initialPetLine(false)).toEqual({
      phase: 'say',
      text: '浏览器预览',
      mood: 'up',
    })
  })
})
