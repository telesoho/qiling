/**
 * 系统声音 → 音乐档位。
 *
 * 后端（`src-tauri/src/music.rs`）每 50ms 发一次 `qiling-music-sense`，
 * 每到一个估计拍点发一次 `qiling-music-beat`。这里只做两件事：
 *   1. 用原型的三档滞回把能量变成 `calm / groove / intense`，且只跟随判成音乐的声音；
 *   2. 把高频数据留在 ref 里，交给 rAF 读，避免 20Hz 触发 React 重渲染。
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  chooseMusicMood,
  forcedMusicMood,
  musicErrorMessage,
  type MusicMood,
  type MusicSenseEvent,
  type MusicSenseStatus,
} from './music'
import { inTauri } from './sync'

export interface MusicSense {
  mood: MusicMood | null
  /** 0…1 平滑能量。 */
  energy: MutableRefObject<number>
  /** 0…1 低频能量。 */
  bass: MutableRefObject<number>
  /** 后端估计的动画 BPM（>140 时可能已按原型取向折成半拍）；0 表示没估出来。 */
  bpm: MutableRefObject<number>
  /** 最近一次鼓点的 `performance.now()`。 */
  beatAt: MutableRefObject<number>
  /** 不能听音乐时的中文说明；空字符串表示没有错误。 */
  error: string
}

const STALE_MS = 2500

export function useMusicSense(options: { enabled: boolean }): MusicSense {
  const [mood, setMood] = useState<MusicMood | null>(null)
  const [error, setError] = useState('')
  const energy = useRef(0)
  const bass = useRef(0)
  const bpm = useRef(0)
  const beatAt = useRef(0)
  const moodRef = useRef<MusicMood | null>(null)
  const lastEventAt = useRef(0)
  const forced = useRef<MusicMood | null>(inTauri() ? null : forcedMusicMood()).current

  useEffect(() => {
    if (!inTauri()) return
    if (!options.enabled) {
      moodRef.current = null
      setMood(null)
      energy.current = 0
      bass.current = 0
      bpm.current = 0
      return
    }

    let alive = true
    let stopSense: (() => void) | undefined
    let stopBeat: (() => void) | undefined

    const applyEnergy = (value: number, active: boolean) => {
      energy.current = value
      const next = chooseMusicMood(moodRef.current, value, active)
      if (next === moodRef.current) return
      moodRef.current = next
      setMood(next)
    }

    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const offSense = await listen<MusicSenseEvent | { error: string }>(
          'qiling-music-sense',
          ({ payload }) => {
            if (!alive) return
            lastEventAt.current = performance.now()
            if ('error' in payload) {
              setError(musicErrorMessage(payload.error))
              applyEnergy(0, false)
              return
            }
            bass.current = Number.isFinite(payload.bass) ? payload.bass : 0
            bpm.current = Number.isFinite(payload.bpm) ? payload.bpm : 0
            // 后端会把语音、噪声、零散音效判成 music=false；这时只更新能量，
            // 不让灵泡进入听音乐的状态。旧后端没有 music 字段，退回 active 行为。
            const isMusic =
              payload.music === undefined ? payload.active === true : payload.music === true
            applyEnergy(
              Number.isFinite(payload.energy) ? payload.energy : 0,
              isMusic,
            )
          },
        )
        const offBeat = await listen('qiling-music-beat', () => {
          if (alive) beatAt.current = performance.now()
        })
        if (!alive) {
          offSense()
          offBeat()
          return
        }
        stopSense = offSense
        stopBeat = offBeat
        await invoke('qiling_music_sense_start')
      })
      .catch((reason: unknown) => {
        if (alive) setError(musicErrorMessage(reason))
      })

    // 后端异常退出时不会补发 active=false；超过 2.5s 没消息就当作没音乐。
    const watchdog = window.setInterval(() => {
      if (!alive) return
      if (performance.now() - lastEventAt.current < STALE_MS) return
      applyEnergy(0, false)
    }, STALE_MS)

    return () => {
      alive = false
      window.clearInterval(watchdog)
      stopSense?.()
      stopBeat?.()
      moodRef.current = null
      void invoke('qiling_music_sense_stop').catch(() => {})
    }
  }, [options.enabled])

  return {
    mood: inTauri() ? mood : forced,
    energy,
    bass,
    bpm,
    beatAt,
    error,
  }
}

/** 设定页的状态行：读一次后端状态，也可在开关/聚焦时刷新。 */
export async function loadMusicSenseStatus(): Promise<MusicSenseStatus> {
  if (!inTauri()) return { running: false, supported: false, lastError: null }
  return invoke<MusicSenseStatus>('qiling_music_sense_status')
}