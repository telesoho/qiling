import { describe, expect, it } from 'vitest'
import { frameUrl, phaseImageUrl } from './anim'
import {
  DEFAULT_CHARACTER,
  SHIJU_CHARACTER,
  createPackLibrary,
  formatInstalledAt,
  loadCharacterAssets,
  packErrorMessage,
  rendererOf,
  type PackRuntime,
} from './packs'

const runtime: PackRuntime = {
  character: { id: 'dafeiyu', name: '大肥鱼', builtin: false },
  assetBase: 'http://qilingpet.localhost/dafeiyu/',
  idleBeats: [{ action: 'water_splash', line: '扑通' }],
  tracks: [
    {
      id: 'dafeiyu-idle',
      displayName: '大肥鱼·待机',
      tags: ['idle', 'dafeiyu'],
      path: 'tracks/idle/track_struct.json',
      struct: {
        fps: 24,
        frameSize: { width: 180, height: 240 },
        phases: {
          idle: {
            playback: 'loop',
            asset: { type: 'animatedWebp', src: 'idle.webp', durationMs: 3000 },
          },
        },
      },
    },
    {
      id: 'dafeiyu-think',
      tags: ['pose', 'think', 'dafeiyu'],
      path: 'tracks/think/track_struct.json',
      struct: {
        phases: {
          idle: {
            playback: 'loop',
            asset: { type: 'animatedWebp', src: 'think.webp' },
          },
        },
      },
    },
    {
      id: 'dafeiyu-pickup',
      tags: ['pickup', 'dafeiyu'],
      path: 'tracks/pickup/track_struct.json',
      struct: {
        fps: 24,
        frameSize: { width: 180, height: 260 },
        phases: {
          lift: {
            playback: 'once',
            asset: {
              type: 'frameSequence',
              dir: 'frames',
              pattern: 'frame{NNN}.webp',
              zeroPad: 3,
              from: 1,
              to: 2,
            },
          },
        },
      },
    },
    {
      id: 'dafeiyu-water_splash',
      tags: ['water_splash', 'dafeiyu'],
      path: 'tracks/water_splash/track_struct.json',
      struct: {
        phases: {
          idle: {
            playback: 'loop',
            asset: { type: 'animatedWebp', src: 'water_splash.webp' },
          },
        },
      },
    },
  ],
}

describe('角色资源包运行时', () => {
  it('builds a character-scoped library from the compiled tracks', () => {
    const library = createPackLibrary(runtime)
    expect(library.byTag('idle')?.id).toBe('dafeiyu-idle')
    expect(library.byTag('think')?.tags).toEqual(['pose', 'think', 'dafeiyu'])
    expect(library.byId.get('dafeiyu-think')?.id).toBe('dafeiyu-think')
    expect(library.byTag('water_splash')?.id).toBe('dafeiyu-water_splash')
    expect(phaseImageUrl(library.byTag('idle'))).toBe(
      'http://qilingpet.localhost/dafeiyu/tracks/idle/idle.webp',
    )
    expect(phaseImageUrl(library.byTag('water_splash'))).toBe(
      'http://qilingpet.localhost/dafeiyu/tracks/water_splash/water_splash.webp',
    )
  })

  it('resolves frame sequences relative to the pack track', () => {
    const library = createPackLibrary(runtime)
    const pickup = library.byTag('pickup')
    expect(pickup).toBeTruthy()
    expect(frameUrl(pickup!, 'lift', 2)).toBe(
      'http://qilingpet.localhost/dafeiyu/tracks/pickup/frames/frame002.webp',
    )
  })

  it('maps stable error codes to readable Chinese', () => {
    expect(packErrorMessage('pack_id_invalid')).toContain('lingpao')
    expect(packErrorMessage('pack_builtin_protected')).toContain('内置角色')
    expect(packErrorMessage('pack_mvp_tracks_missing:think,explain')).toContain('think,explain')
    expect(packErrorMessage('some_new_code')).toContain('some_new_code')
  })

  it('defaults to the svg character and keeps shiju as a bitmap character', () => {
    expect(DEFAULT_CHARACTER).toMatchObject({ id: 'lingpao', name: '灵泡', builtin: true })
    expect(rendererOf(DEFAULT_CHARACTER)).toBe('svg')
    expect(rendererOf(SHIJU_CHARACTER)).toBe('webp')
    // 旧数据没有 renderer 字段时按位图处理。
    expect(rendererOf({ id: 'demo', name: '演示', builtin: false })).toBe('webp')
  })

  it('loads the svg character without reading the bitmap library', async () => {
    const assets = await loadCharacterAssets(DEFAULT_CHARACTER)
    expect(assets.renderer).toBe('svg')
    expect(assets.library).toBeNull()
    expect(assets.beats.map((beat) => beat.key)).toEqual(['breath'])
  })

  it('formats installed timestamps defensively', () => {
    expect(formatInstalledAt(undefined)).toBe('')
    expect(formatInstalledAt(0)).toBe('')
    expect(formatInstalledAt(1_760_000_000)).not.toBe('')
  })
})
