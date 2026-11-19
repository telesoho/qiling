import { describe, expect, it } from 'vitest'
import {
  HOLDING_POSE,
  lingpaoAriaLabel,
  poseForRuntime,
  type LingpaoRuntimeInput,
} from './lingpao'

const base: LingpaoRuntimeInput = {
  stateId: 'idle',
  speaking: false,
  holding: false,
  music: null,
}

describe('灵泡姿态映射', () => {
  it('maps the five runtime poses', () => {
    expect(poseForRuntime(base)).toMatchObject({ eye: 'open', mouth: 'none', prop: 'none' })
    expect(poseForRuntime({ ...base, stateId: 'think' })).toMatchObject({
      eye: 'lookup',
      prop: 'dots',
      tilt: 5,
    })
    expect(poseForRuntime({ ...base, stateId: 'advantage' })).toMatchObject({
      eye: 'star',
      mouth: 'smirk',
      fx: 'sparkles',
    })
    expect(poseForRuntime({ ...base, stateId: 'disadvantage' })).toMatchObject({
      eye: 'worry',
      mouth: 'wavy',
      prop: 'sweat',
      tilt: -4,
    })
  })

  it('only opens the explain mouth while actually speaking', () => {
    expect(poseForRuntime({ ...base, stateId: 'explain' })).toMatchObject({
      mouth: 'none',
      prop: 'bulb',
    })
    expect(poseForRuntime({ ...base, stateId: 'explain', speaking: true })).toMatchObject({
      mouth: 'talk',
      prop: 'bulb',
    })
  })

  it('lets music take over only while idle', () => {
    expect(poseForRuntime({ ...base, music: 'calm' })).toMatchObject({
      eye: 'happy',
      mouth: 'smile',
      prop: 'music',
    })
    expect(poseForRuntime({ ...base, music: 'groove' })).toMatchObject({
      eye: 'open',
      mouth: 'smile-wide',
      eyeScale: 0.94,
    })
    expect(poseForRuntime({ ...base, music: 'intense' })).toMatchObject({
      mouth: 'smile-wide',
      prop: 'music',
    })
    // 思考、讲解等状态优先，不让音乐抢走姿态。
    expect(poseForRuntime({ ...base, stateId: 'think', music: 'intense' })).toMatchObject({
      eye: 'lookup',
      prop: 'dots',
    })
  })

  it('puts the picked-up pose above everything else', () => {
    expect(
      poseForRuntime({ stateId: 'explain', speaking: true, holding: true, music: 'intense' }),
    ).toBe(HOLDING_POSE)
    expect(HOLDING_POSE).toMatchObject({ eye: 'wide', mouth: 'o' })
  })

  it('labels the current pose for screen readers', () => {
    expect(lingpaoAriaLabel(base)).toBe('器灵，待机')
    expect(lingpaoAriaLabel({ ...base, music: 'groove' })).toBe('器灵，听音乐·轻快')
    expect(lingpaoAriaLabel({ ...base, holding: true })).toBe('器灵，被拎起')
    expect(lingpaoAriaLabel({ ...base, stateId: 'think' })).toBe('器灵，思考')
  })
})