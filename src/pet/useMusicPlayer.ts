/**
 * 曲库窗口与设定页共用的播放状态桥。
 *
 * 事件由常驻桌宠窗口里的 `LocalMusicPlayer` 发出；这里只负责订阅、把
 * 进度合并进状态，并把用户操作转成 `qiling-music-command`。
 */
import { useCallback, useEffect, useState } from 'react'
import { emit } from '@tauri-apps/api/event'
import { inTauri } from './sync'
import {
  MUSIC_COMMAND_EVENT,
  MUSIC_DOWNLOAD_EVENT,
  MUSIC_PROGRESS_EVENT,
  MUSIC_STATE_EVENT,
  defaultLocalMusicState,
  loadPlayerState,
  parseLocalMusicState,
  type LocalMusicCommand,
  type LocalMusicState,
} from './localMusic'

export interface MusicDownload {
  trackId: string
  received: number
  total: number
  done: boolean
}

export interface MusicPlayerBridge {
  state: LocalMusicState
  download: MusicDownload | null
  /** 是否已经收到过桌宠窗口的响应。 */
  connected: boolean
  requestState: () => void
  send: (command: LocalMusicCommand) => void
}

function parseDownload(value: unknown): MusicDownload | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.trackId !== 'string' || !record.trackId) return null
  const number = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : 0
  return {
    trackId: record.trackId,
    received: number(record.received),
    total: number(record.total),
    done: record.done === true,
  }
}

export function useMusicPlayer(options: {
  enabled: boolean
  /** 设定页只需要状态，不需要 20Hz 进度更新。 */
  progress?: boolean
}): MusicPlayerBridge {
  const native = options.enabled && inTauri()
  const [state, setState] = useState<LocalMusicState>(() =>
    defaultLocalMusicState(loadPlayerState().volume),
  )
  const [download, setDownload] = useState<MusicDownload | null>(null)
  const [connected, setConnected] = useState(false)

  const send = useCallback(
    (command: LocalMusicCommand) => {
      if (!native) return
      void emit(MUSIC_COMMAND_EVENT, command).catch(() => {})
    },
    [native],
  )
  const requestState = useCallback(() => {
    send({ type: 'requestState' })
  }, [send])

  useEffect(() => {
    if (!native) return
    let alive = true
    let stops: Array<() => void> = []
    let retry = 0
    const mark = () => {
      if (alive) setConnected(true)
    }

    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const offState = await listen<unknown>(MUSIC_STATE_EVENT, ({ payload }) => {
        if (!alive) return
        const next = parseLocalMusicState(payload)
        if (next) {
          setState(next)
          if (next.status === 'error' || next.status === 'idle') setDownload(null)
          mark()
        }
      })
      const offProgress = await listen<unknown>(MUSIC_PROGRESS_EVENT, ({ payload }) => {
        if (!alive || options.progress === false) return
        const record = payload as { positionSec?: unknown } | null
        const position = record?.positionSec
        if (typeof position === 'number' && Number.isFinite(position)) {
          setState((current) => ({ ...current, positionSec: Math.max(0, position) }))
          mark()
        }
      })
      const offDownload = await listen<unknown>(MUSIC_DOWNLOAD_EVENT, ({ payload }) => {
        if (!alive) return
        const next = parseDownload(payload)
        if (next) {
          setDownload(next.done ? null : next)
          mark()
        }
      })
      stops = [offState, offProgress, offDownload]
      if (!alive) {
        stops.forEach((stop) => stop())
        return
      }
      requestState()
      retry = window.setTimeout(() => {
        if (alive) requestState()
      }, 1_500)
    })().catch(() => {})

    const onFocus = () => requestState()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.clearTimeout(retry)
      window.removeEventListener('focus', onFocus)
      stops.forEach((stop) => stop())
    }
  }, [native, options.progress, requestState])

  return { state, download, connected, requestState, send }
}