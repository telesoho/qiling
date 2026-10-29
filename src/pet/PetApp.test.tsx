import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishLine } from '../lib/line'
import { saveQiLingSettings, loadQiLingSettings } from '../lib/settings'
import PetApp from './PetApp'

const memory = () => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size },
  }
}

describe('器灵桌宠', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memory(), configurable: true })
  })

  it('waits in the thinking pose until a voiced line is audible', () => {
    publishLine({ phase: 'say', text: '这步不错。', mood: 'up' })
    const pet = renderToStaticMarkup(<PetApp />)
    expect(pet).toContain('/pet/think.webp')
    expect(pet).toContain('让我想想')
    expect(pet).not.toContain('这步不错')
  })

  it('shows the spoken line when voice is off', () => {
    saveQiLingSettings({ ...loadQiLingSettings(), voice: false })
    publishLine({ phase: 'say', text: '先看这一步。', mood: 'neutral' })
    const pet = renderToStaticMarkup(<PetApp />)
    expect(pet).toContain('/pet/explain.webp')
    expect(pet).toContain('先看这一步。')
  })

  it('hides the bubble without hiding the sprite', () => {
    saveQiLingSettings({ voice: true, bubble: false })
    publishLine({ phase: 'say', text: '这步不错。', mood: 'up' })
    const pet = renderToStaticMarkup(<PetApp />)
    expect(pet).toContain('/pet/think.webp')
    expect(pet).not.toContain('pet-bubble')
  })
})
