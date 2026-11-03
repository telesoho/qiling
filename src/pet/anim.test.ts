import { describe, expect, it } from 'vitest'
import {
  createLibrary,
  frameUrl,
  normalizeTrack,
  phaseDurationMs,
  phaseImageUrl,
  trackImageUrls,
  type AnimManifest,
  type AnimTrack,
} from './anim'

const manifestFiles = import.meta.glob('../../public/pet/anim/manifest.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
const manifest = JSON.parse(
  Object.values(manifestFiles)[0] ?? '{"version":"0","tracks":[]}',
) as AnimManifest

const structFiles = import.meta.glob('../../public/pet/anim/*/track_struct.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>
const frameFiles = Object.keys(import.meta.glob('../../public/pet/anim/*/frames/*.webp'))

function structFor(id: string): Record<string, any> | undefined {
  const key = Object.keys(structFiles).find((path) => path.endsWith(`/${id}/track_struct.json`))
  return key ? JSON.parse(structFiles[key]) : undefined
}

describe('运行时动画目录', () => {
  it('bakes every design track into the runtime manifest', () => {
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.defaultTrack).toBe('shiju-pickup-hover')
    expect(manifest.tracks.map((track) => track.id)).toEqual([
      'shiju-pickup-hover',
      'shiju-idle',
      'shiju-butterfly',
      'shiju-angry',
      'shiju-explain',
      'shiju-think',
      'shiju-advantage',
      'shiju-disadvantage',
    ])
    for (const entry of manifest.tracks) {
      expect(entry.path).toBe(`${entry.id}/track_struct.json`)
      const struct = structFor(entry.id)
      expect(struct, entry.id).toBeTruthy()
      expect(struct?.id).toBe(entry.id)
    }
  })

  it('keeps pickup timing and canvas from the contract', () => {
    const pickup = structFor('shiju-pickup-hover')
    expect(pickup.fps).toBe(24)
    expect(pickup.frameSize).toEqual({ width: 180, height: 260 })
    expect(pickup.phases.idle.asset).toMatchObject({ type: 'animatedWebp', src: '/pet/idle.webp' })
    expect(pickup.phases.lift.asset).toMatchObject({ type: 'frameSequence', dir: 'frames', from: 30, to: 72 })
    expect(pickup.phases.hover.asset).toMatchObject({ type: 'frameSequence', from: 73, to: 100 })
    expect(pickup.phases.hover.playback).toBe('loop')
    expect(pickup.phases.drop.asset).toMatchObject({ type: 'frameSequence', from: 101, to: 193 })
    const pickupFrames = frameFiles.filter((path) => path.includes('/shiju-pickup-hover/frames/'))
    expect(pickupFrames).toHaveLength(164)
    for (const frame of [30, 72, 73, 100, 101, 193]) {
      const name = `frame${String(frame).padStart(3, '0')}.webp`
      expect(pickupFrames.some((path) => path.endsWith(`/${name}`)), name).toBe(true)
    }
  })

  it('points every pose track at its baked WebP', () => {
    const poses: Array<[string, string]> = [
      ['shiju-idle', 'idle.webp'],
      ['shiju-butterfly', 'butterfly.webp'],
      ['shiju-angry', 'angry.webp'],
      ['shiju-explain', 'explain.webp'],
      ['shiju-think', 'think.webp'],
      ['shiju-advantage', 'advantage.webp'],
      ['shiju-disadvantage', 'disadvantage.webp'],
    ]
    for (const [id, file] of poses) {
      const track = structFor(id)
      expect(track.frameSize).toEqual({ width: 180, height: 240 })
      expect(track.phases.idle.asset).toMatchObject({ type: 'animatedWebp', src: `/pet/${file}` })
      expect(track.phases.idle.asset.durationMs).toBeGreaterThan(0)
    }
    expect(structFor('shiju-idle').phases.idle.asset.durationMs).toBe(3000)
    expect(structFor('shiju-butterfly').phases.idle.asset.durationMs).toBe(6125)
    expect(structFor('shiju-angry').phases.idle.asset.durationMs).toBe(6125)
  })

  it('builds absolute frame and image URLs from the track location', () => {
    const track: AnimTrack = {
      id: 'demo',
      fps: 24,
      frameSize: { width: 180, height: 260 },
      tags: ['pickup'],
      baseUrl: 'http://test/pet/anim/demo/track_struct.json',
      phases: {
        idle: {
          playback: 'loop',
          asset: { type: 'animatedWebp', src: 'http://test/pet/idle.webp', durationMs: 3000 },
        },
        lift: {
          playback: 'once',
          asset: { type: 'frameSequence', dir: 'frames', pattern: 'frame{NNN}.webp', zeroPad: 3, from: 30, to: 31 },
        },
      },
    }
    expect(phaseImageUrl(track)).toBe('http://test/pet/idle.webp')
    expect(phaseDurationMs(track)).toBe(3000)
    expect(phaseDurationMs(track, 'lift')).toBeUndefined()
    expect(frameUrl(track, 'lift', 30)).toBe('http://test/pet/anim/demo/frames/frame030.webp')
    expect(frameUrl(track, 'idle', 1)).toBeUndefined()
    expect(trackImageUrls(track)).toEqual([
      'http://test/pet/idle.webp',
      'http://test/pet/anim/demo/frames/frame030.webp',
      'http://test/pet/anim/demo/frames/frame031.webp',
    ])
    expect(createLibrary(manifest, [track]).byTag('pickup')).toBe(track)
    expect(createLibrary(manifest, [track]).byId.get('demo')).toBe(track)
  })

  it('normalizes relative assets against track_struct.json', () => {
    const entry = {
      id: 'shiju-think',
      displayName: '诗琚·思考',
      path: 'shiju-think/track_struct.json',
      tags: ['pose', 'think', 'shiju'],
    }
    const track = normalizeTrack(
      entry,
      {
        id: 'shiju-think',
        fps: 24,
        frameSize: { width: 180, height: 240 },
        phases: {
          idle: { playback: 'loop', asset: { type: 'animatedWebp', src: '/pet/think.webp' } },
          lift: { playback: 'once', asset: { type: 'frameSequence', from: 1, to: 3 } },
        },
      },
      'http://test/pet/anim/shiju-think/track_struct.json',
    )
    expect(track.tags).toEqual(['pose', 'think', 'shiju'])
    const idle = track.phases.idle.asset
    expect(idle.type).toBe('animatedWebp')
    if (idle.type === 'animatedWebp') expect(idle.src).toBe('http://test/pet/think.webp')
    const lift = track.phases.lift.asset
    expect(lift.type).toBe('frameSequence')
    if (lift.type === 'frameSequence') {
      expect(lift.dir).toBe('frames')
      expect(lift.pattern).toBe('frame{NNN}.webp')
      expect(lift.zeroPad).toBe(3)
    }
  })
})
