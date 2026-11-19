import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { publishLine } from '../lib/line'
import { loadQiLingSettings, saveQiLingSettings } from '../lib/settings'
import type { AnimTrack } from './anim'
import PetApp from './PetApp'
import { loadActiveCharacter, rendererOf } from './packs'
import { PickupSprite } from './PickupSprite'

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
    expect(pet).toContain('data-pose-eye="lookup"')
    expect(pet).toContain('让我想想')
    expect(pet).not.toContain('这步不错')
  })

  it('shows the spoken line when voice is off', () => {
    saveQiLingSettings({ ...loadQiLingSettings(), voice: false })
    publishLine({ phase: 'say', text: '先看这一步。', mood: 'neutral' })
    const pet = renderToStaticMarkup(<PetApp />)
    expect(pet).toContain('data-pose-eye="open"')
    expect(pet).toContain('先看这一步。')
  })

  it('hides the bubble without hiding the sprite', () => {
    saveQiLingSettings({ ...loadQiLingSettings(), voice: true, bubble: false })
    publishLine({ phase: 'say', text: '这步不错。', mood: 'up' })
    const pet = renderToStaticMarkup(<PetApp />)
    expect(pet).toContain('data-part="root"')
    expect(pet).not.toContain('pet-bubble')
  })

  it('draws pickup phases on the contract canvas', () => {
    const track: AnimTrack = {
      id: 'shiju-pickup-hover',
      fps: 24,
      frameSize: { width: 180, height: 260 },
      tags: ['pickup'],
      baseUrl: 'http://test/pet/anim/shiju-pickup-hover/track_struct.json',
      phases: {
        lift: {
          playback: 'once',
          asset: { type: 'frameSequence', dir: 'frames', pattern: 'frame{NNN}.webp', zeroPad: 3, from: 30, to: 72 },
        },
      },
    }
    const html = renderToStaticMarkup(
      <PickupSprite
        track={track}
        segments={{
          lift: { from: 30, to: 72, loop: false },
          hover: { from: 73, to: 100, loop: true },
          drop: { from: 101, to: 193, loop: false },
        }}
        phase="lift"
        holding
        fallbackSrc="/pet/idle.webp"
        onAdvance={() => {}}
      />,
    )
    expect(html).toContain('class="pet-pickup"')
    expect(html).toContain('width="180"')
    expect(html).toContain('height="260"')
  })

  it('uses the bitmap character when the preview URL asks for shiju', async () => {
    const scope = globalThis as unknown as { window?: unknown }
    scope.window = { location: { search: '?character=shiju' } }
    try {
      const character = await loadActiveCharacter()
      expect(character.id).toBe('shiju')
      expect(rendererOf(character)).toBe('webp')
    } finally {
      delete scope.window
    }
  })

  it('defaults the preview to the svg character', async () => {
    const character = await loadActiveCharacter()
    expect(character.id).toBe('lingpao')
    expect(rendererOf(character)).toBe('svg')
  })
})