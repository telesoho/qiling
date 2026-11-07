import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MUSIC_TUNING,
  IDLE_GROUND,
  MOOD_DWELL_MS,
  MOOD_MIN_HOLD_MS,
  MUSIC_ENERGY,
  MUSIC_TUNING,
  beatAt,
  beatDurationMs,
  beginMoodGate,
  blendGround,
  blendMotion,
  chooseMusicMood,
  createBeatClock,
  forcedMusicMood,
  gateMusicMood,
  groundFor,
  lockBeatPhase,
  mixMusicEnergy,
  motionFor,
  musicErrorMessage,
  musicFollowLabel,
  musicThresholds,
  normalizeMusicTuning,
  retuneBeatClock,
  smoothMusicEnergy,
  smoothstep,
  visibleMusicMood,
} from './music'

describe('听音乐阈值', () => {
  it('keeps the tuned prototype slider defaults', () => {
    expect(MUSIC_TUNING.swayThreshold).toBe(0.6)
    expect(MUSIC_TUNING.calmThreshold).toBe(0.3)
    expect(musicThresholds()).toEqual({
      enterGroove: 0.6,
      exitGroove: 0.3,
      enterIntense: 0.88,
      exitIntense: 0.78,
    })
  })

  it('does not flicker at either hysteresis boundary', () => {
    // 舒缓 ↔ 轻快：进 0.60 / 回 0.30
    expect(chooseMusicMood('calm', 0.59, true)).toBe('calm')
    expect(chooseMusicMood('calm', 0.61, true)).toBe('groove')
    expect(chooseMusicMood('groove', 0.59, true)).toBe('groove')
    expect(chooseMusicMood('groove', 0.29, true)).toBe('calm')
    // 轻快 ↔ 激烈：进 0.88 / 回 0.78
    expect(chooseMusicMood('groove', 0.87, true)).toBe('groove')
    expect(chooseMusicMood('groove', 0.89, true)).toBe('intense')
    expect(chooseMusicMood('intense', 0.79, true)).toBe('intense')
    expect(chooseMusicMood('intense', 0.77, true)).toBe('groove')
  })

  it('uses the same entry rule on the first activation', () => {
    expect(chooseMusicMood(null, 0.2, true)).toBe('calm')
    expect(chooseMusicMood(null, 0.7, true)).toBe('groove')
    expect(chooseMusicMood(null, 0.9, true)).toBe('intense')
  })

  it('follows the thresholds the user adjusted', () => {
    const tuning = normalizeMusicTuning({
      ...DEFAULT_MUSIC_TUNING,
      enterGroove: 0.2,
      exitGroove: 0.1,
      enterIntense: 0.4,
      exitIntense: 0.3,
    })
    expect(chooseMusicMood(null, 0.15, true, tuning)).toBe('calm')
    expect(chooseMusicMood(null, 0.25, true, tuning)).toBe('groove')
    expect(chooseMusicMood(null, 0.45, true, tuning)).toBe('intense')
    expect(chooseMusicMood('groove', 0.35, true, tuning)).toBe('groove')
    expect(chooseMusicMood('groove', 0.41, true, tuning)).toBe('intense')
    expect(chooseMusicMood('intense', 0.31, true, tuning)).toBe('intense')
    expect(chooseMusicMood('intense', 0.29, true, tuning)).toBe('groove')
  })

  it('repairs out-of-order thresholds instead of rejecting them', () => {
    const tuning = normalizeMusicTuning({
      enterScore: 0.1,
      exitScore: 0.9,
      enterGroove: 0.8,
      exitGroove: 0.2,
      enterIntense: 0.1,
      exitIntense: 0.95,
    })
    expect(tuning.enterScore).toBe(0.1)
    expect(tuning.exitScore).toBeLessThan(tuning.enterScore)
    expect(tuning.exitGroove).toBeLessThan(tuning.enterGroove)
    expect(tuning.enterIntense).toBeGreaterThan(tuning.enterGroove)
    expect(tuning.exitIntense).toBeLessThan(tuning.enterIntense)

    // 手改 localStorage / 旧版本设置里的非法值回落到默认值。
    expect(normalizeMusicTuning(null)).toEqual(DEFAULT_MUSIC_TUNING)
    expect(normalizeMusicTuning({ enterScore: Number.NaN, exitScore: 'loud' })).toEqual(
      DEFAULT_MUSIC_TUNING,
    )
  })

  it('reports no music once playback stops', () => {
    expect(chooseMusicMood('intense', 0.95, false)).toBeNull()
    expect(chooseMusicMood(null, 0.95, false)).toBeNull()
  })
})

describe('节拍时钟', () => {
  it('falls back to 96 BPM when no estimate exists', () => {
    expect(beatDurationMs(0)).toBeCloseTo(60_000 / 96)
    expect(beatDurationMs(120)).toBeCloseTo(500)
  })

  it('swings from one side to the other every beat', () => {
    const clock = createBeatClock(0, 120)
    expect(beatAt(clock, 0).wave).toBeCloseTo(1)
    expect(beatAt(clock, 250).wave).toBeCloseTo(0)
    const next = beatAt(clock, 500)
    expect(next.index).toBe(1)
    expect(next.wave).toBeCloseTo(-1)
    expect(beatAt(clock, 1000).wave).toBeCloseTo(1)
  })

  it('retunes to a new BPM without jumping phase', () => {
    const clock = createBeatClock(0, 120)
    const before = beatAt(clock, 250)
    const retuned = retuneBeatClock(clock, 250, 240)
    const after = beatAt(retuned, 250)
    expect(after.phase).toBeCloseTo(before.phase, 5)
    expect(after.wave).toBeCloseTo(before.wave, 5)
  })

  it('nudges toward a drum hit by at most 40ms and ignores far hits', () => {
    const clock = createBeatClock(0, 120)
    expect(lockBeatPhase(clock, 60, 120).startMs).toBeCloseTo(15)
    expect(lockBeatPhase(clock, 170, 120).startMs).toBeCloseTo(40)
    expect(lockBeatPhase(clock, 250, 120).startMs).toBe(0)
  })

  it('seeds the phase so the next beat lands after nextBeatMs', () => {
    const clock = createBeatClock(0, 120, 200)
    const beat = beatAt(clock, 200)
    expect(beat.index).toBe(0)
    expect(beat.wave).toBeCloseTo(1)
    expect(beatAt(clock, 100).index).toBe(-1)
  })
})

describe('曲库能量口径', () => {
  it('uses the same weights as the prototype and music.rs', () => {
    expect(MUSIC_ENERGY.bassWeight).toBe(1.32)
    expect(MUSIC_ENERGY.midWeight).toBe(0.28)
    expect(MUSIC_ENERGY.rmsWeight).toBe(0.4)
    expect(mixMusicEnergy(0.5, 0.2, 0.1)).toBeCloseTo(0.5 * 1.32 + 0.2 * 0.28 + 0.1 * 0.4)
    expect(mixMusicEnergy(1, 1, 1)).toBe(1)
    expect(mixMusicEnergy(-1, -1, -1)).toBe(0)
  })

  it('attacks faster than it releases', () => {
    const rise = smoothMusicEnergy(0, 0.5, 0.016)
    const fall = 0.5 - smoothMusicEnergy(0.5, 0, 0.016)
    expect(rise).toBeGreaterThan(fall)
    expect(smoothMusicEnergy(0.3, 0.3, 0.016)).toBeCloseTo(0.3)
  })
})

describe('三档运动', () => {
  it('lets calm ignore wave and pulse', () => {
    expect(motionFor('calm', 1, 1, 1.2)).toEqual(motionFor('calm', -1, 0, 1.2))
    const calm = motionFor('calm', 1, 1, 1.2)
    expect(Math.abs(calm.y)).toBeLessThanOrEqual(3.2)
  })

  it('never moves groove vertically', () => {
    const scale = MUSIC_TUNING.motionScale
    for (const [wave, pulse] of [
      [1, 0],
      [-1, 1],
      [0.3, 0.8],
    ]) {
      const motion = motionFor('groove', wave, pulse, 1)
      expect(motion.y).toBe(0)
      expect(motion.x).toBeCloseTo(wave * 10 * scale)
      expect(motion.rotation).toBeCloseTo(wave * 5.5 * scale)
    }
  })

  it('only hops on the beat when intense', () => {
    const scale = MUSIC_TUNING.motionScale
    const onBeat = motionFor('intense', 1, 1, 1)
    expect(onBeat.y).toBeCloseTo(-5.5 * scale)
    expect(onBeat.sx).toBeCloseTo(1 + 0.025 * scale)
    expect(onBeat.sy).toBeCloseTo(1 - 0.032 * scale)
    const offBeat = motionFor('intense', 1, 0, 1)
    expect(offBeat.y).toBe(0)
  })

  it('fades the ground shadow as the pet lifts', () => {
    expect(groundFor({ x: 0, y: 0, rotation: 0, sx: 1, sy: 1 })).toEqual({
      opacity: 0.19,
      scale: 1,
    })
    const lifted = groundFor({ x: 0, y: -5.5, rotation: 0, sx: 1, sy: 1 })
    expect(lifted.opacity).toBeLessThan(0.19)
    expect(lifted.scale).toBeLessThan(1)
  })
})

describe('换档过渡', () => {
  it('eases between motions with zero velocity at both ends', () => {
    const from = { x: -5, y: 2, rotation: 3, sx: 1.02, sy: 0.98 }
    const to = { x: 5, y: -2, rotation: -3, sx: 0.98, sy: 1.02 }
    expect(blendMotion(from, to, 0)).toEqual(from)
    const end = blendMotion(from, to, 1)
    expect(end.x).toBeCloseTo(to.x)
    expect(end.y).toBeCloseTo(to.y)
    expect(end.rotation).toBeCloseTo(to.rotation)
    expect(end.sx).toBeCloseTo(to.sx)
    expect(end.sy).toBeCloseTo(to.sy)
    expect(blendMotion(from, to, 0.5).x).toBeCloseTo(0)
    // smoothstep：20% 的时间只走约 10.4% 的路程，起手不抢拍。
    expect(smoothstep(0.2)).toBeCloseTo(0.104)
    expect(smoothstep(-1)).toBe(0)
    expect(smoothstep(2)).toBe(1)
    expect(blendMotion(from, to, 0.2).x).toBeGreaterThan(-5)
  })

  it('hands the ground shadow back to the CSS idle value without a step', () => {
    expect(blendGround(IDLE_GROUND, { opacity: 0.19, scale: 1 }, 0)).toEqual(IDLE_GROUND)
    expect(blendGround(IDLE_GROUND, { opacity: 0.19, scale: 1 }, 1)).toEqual({
      opacity: 0.19,
      scale: 1,
    })
    expect(blendGround(IDLE_GROUND, { opacity: 0.19, scale: 1 }, 0.5).opacity).toBeCloseTo(0.165)
    // 收尾必须回到 CSS 里的 0.14，否则交还 CSS 时影子会亮一下。
    expect(IDLE_GROUND.opacity).toBe(0.14)
  })
})

describe('换档防抖', () => {
  it('enters and leaves music immediately, but dwells between moods', () => {
    let gate = beginMoodGate(0)
    gate = gateMusicMood(gate, 'calm', 1000)
    expect(gate.mood).toBe('calm')

    gate = gateMusicMood(gate, 'groove', 2000)
    expect(gate.mood).toBe('calm')
    expect(gate.candidate).toBe('groove')
    gate = gateMusicMood(gate, 'groove', 2000 + MOOD_DWELL_MS - 1)
    expect(gate.mood).toBe('calm')
    gate = gateMusicMood(gate, 'groove', 2000 + MOOD_DWELL_MS)
    expect(gate.mood).toBe('groove')

    // 音乐消失是明确事件，不需要等防抖。
    expect(gateMusicMood(gate, null, 2100).mood).toBeNull()
  })

  it('does not machine-gun switches when the energy flickers', () => {
    let gate = gateMusicMood(beginMoodGate(0), 'calm', 1000)
    gate = gateMusicMood(gate, 'groove', 1010)
    gate = gateMusicMood(gate, 'calm', 1200)
    expect(gate.mood).toBe('calm')
    expect(gate.candidate).toBeNull()
    gate = gateMusicMood(gate, 'groove', 1300)
    expect(gate.mood).toBe('calm')
  })

  it('waits for the minimum hold after a switch', () => {
    let gate = gateMusicMood(beginMoodGate(0), 'calm', 1000)
    gate = gateMusicMood(gate, 'groove', 2000)
    gate = gateMusicMood(gate, 'groove', 2000 + MOOD_DWELL_MS)
    expect(gate.mood).toBe('groove')
    gate = gateMusicMood(gate, 'intense', 2000 + MOOD_DWELL_MS + 10)
    // 候选站住了，但离上次换档还不到 MOOD_MIN_HOLD_MS。
    gate = gateMusicMood(gate, 'intense', 2000 + MOOD_DWELL_MS + MOOD_MIN_HOLD_MS - 1)
    expect(gate.mood).toBe('groove')
    gate = gateMusicMood(gate, 'intense', 2000 + MOOD_MIN_HOLD_MS + MOOD_DWELL_MS)
    expect(gate.mood).toBe('intense')
  })
})

describe('预览与错误文案', () => {
  it('reads the forced preview mood from the query string', () => {
    expect(forcedMusicMood('?music=calm')).toBe('calm')
    expect(forcedMusicMood('?music=groove')).toBe('groove')
    expect(forcedMusicMood('?music=intense')).toBe('intense')
    expect(forcedMusicMood('?music=loud')).toBeNull()
    expect(forcedMusicMood('')).toBeNull()
  })

  it('turns native error codes into Chinese explanations', () => {
    expect(musicErrorMessage('music_unavailable')).toContain('播放设备')
    expect(musicErrorMessage('music_format_unsupported')).toContain('格式')
    expect(musicErrorMessage('something_new')).toContain('something_new')
  })

  it('says when music is followed without a beat estimate', () => {
    // 判定为音乐但估不出 BPM：必须写明按备用拍摇摆，不能只留一句“正在跟随音乐”。
    expect(musicFollowLabel({ music: true, active: true, bpm: 0 })).toBe(
      '正在跟随音乐 · 未识别到节拍（按 96 BPM 摆动）',
    )
    expect(musicFollowLabel({ music: true, active: true })).toContain('未识别到节拍')
    expect(musicFollowLabel({ music: true, active: true, bpm: 122.4 })).toBe(
      '正在跟随音乐 · 122 BPM',
    )
    expect(musicFollowLabel({ music: false, active: true, bpm: 0 })).toBe(
      '听到声音，但不是音乐（人声/噪声不跟拍）',
    )
    expect(musicFollowLabel({ music: false, active: false })).toBe('正在监听，等待音乐')
  })

  it('hides the music pose while the pet is speaking', () => {
    expect(visibleMusicMood(true, false, 'groove')).toBe('groove')
    expect(visibleMusicMood(true, true, 'groove')).toBeNull()
    expect(visibleMusicMood(false, false, 'groove')).toBeNull()
  })
})
