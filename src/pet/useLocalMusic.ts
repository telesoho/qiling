/**
 * 桌宠窗口里的曲库播放引擎接线。
 *
 * 引擎必须常驻在 pet 窗口：曲库窗口关掉后音乐还要继续放。这里只把引擎的
 * 20Hz 数据写进 ref，active/mood 才触发 React 重渲染，避免播放时整只桌宠
 * 每秒重绘几十次。
 */
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { inTauri } from './sync'
import type { MusicMood, MusicTuning } from './music'
import { LocalMusicPlayer } from './localMusicPlayer'
import {
  MUSIC_COMMAND_EVENT,
  parseLocalMusicCommand,
  type LocalMusicSense,
} from './localMusic'
import { loadMusicLibrary } from './musicLibrary'

export interface LocalMusicControls {
  sense: LocalMusicSense
}

export function useLocalMusic(options: {
  enabled: boolean
  tuning: MusicTuning
}): LocalMusicControls {
  const [active, setActive] = useState(false)
  const [mood, setMood] = useState<MusicMood | null>(null)
  const energy = useRef(0)
  const bass = useRef(0)
  const bpm = useRef(0)
  const beatAt = useRef(0)
  const nextBeatMs = useRef(0)
  const activeRef = useRef(false)
  const moodRef = useRef<MusicMood | null>(null)
  const tuningRef = useRef(options.tuning)
  tuningRef.current = options.tuning
  const engineRef = useRef<LocalMusicPlayer | null>(null)

  useEffect(() => {
    if (!options.enabled || !inTauri()) return
    let alive = true
    let stopCommands: (() => void) | undefined

    const engine = new LocalMusicPlayer({
      readTrackAudio: (id) =>
        invoke<ArrayBuffer>('qiling_music_track_audio', { id }),
      loadLibrary: loadMusicLibrary,
      emit: (event, payload) => {
        void emit(event, payload).catch(() => {})
      },
      onSense: (next) => {
        energy.current = next.energy
        bass.current = next.bass
        bpm.current = next.bpm
        beatAt.current = next.beatAt
        nextBeatMs.current = next.nextBeatMs
        if (activeRef.current !== next.active) {
          activeRef.current = next.active
          setActive(next.active)
        }
        if (moodRef.current !== next.mood) {
          moodRef.current = next.mood
          setMood(next.mood)
        }
      },
      getTuning: () => tuningRef.current,
      now: () => performance.now(),
    })
    engineRef.current = engine

    void listen<unknown>(MUSIC_COMMAND_EVENT, ({ payload }) => {
      if (!alive) return
      const command = parseLocalMusicCommand(payload)
      if (command) engine.handleCommand(command)
    })
      .then((stop) => {
        if (alive) stopCommands = stop
        else stop()
      })
      .catch(() => {})

    return () => {
      alive = false
      stopCommands?.()
      engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
      activeRef.current = false
      moodRef.current = null
      energy.current = 0
      bass.current = 0
      bpm.current = 0
      beatAt.current = 0
      nextBeatMs.current = 0
      setActive(false)
      setMood(null)
    }
  }, [options.enabled])

  useEffect(() => {
    engineRef.current?.setTuning(options.tuning)
  }, [options.tuning])

  return {
    sense: {
      active,
      mood,
      energy,
      bass,
      bpm,
      beatAt,
      nextBeatMs,
    },
  }
}