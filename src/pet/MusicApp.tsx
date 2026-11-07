/**
 * 曲库窗口：管理本地/网络歌曲，并控制常驻桌宠窗口里的播放引擎。
 *
 * 播放状态来自 `qiling-music-state` / `-progress`；曲库增删走 Rust 命令。
 * 关闭这个窗口不会停止播放（引擎在桌宠窗口里）。
 */
import { useCallback, useEffect, useState } from 'react'
import { loadQiLingSettings } from '../lib/settings'
import { inTauri } from './sync'
import {
  addLocalMusic,
  addRemoteMusic,
  clearMusicCache,
  clearMusicLibrary,
  formatBytes,
  isHttpUrl,
  loadMusicLibrary,
  musicErrorMessage,
  pickMusicFiles,
  removeMusicTrack,
  trackKindLabel,
  type MusicLibraryView,
  type MusicTrackView,
} from './musicLibrary'
import { formatClock, type LocalMusicState } from './localMusic'
import { useMusicPlayer, type MusicDownload } from './useMusicPlayer'

const MOOD_LABELS: Record<string, string> = {
  calm: '舒缓',
  groove: '轻快',
  intense: '激烈',
}

type MusicBusy = '' | 'local' | 'remote' | 'clear' | 'cache' | 'remove'

/** 播放器状态行（导出供测试与复用）。 */
export function playerStatusText(
  state: LocalMusicState,
  download: MusicDownload | null,
): string {
  if (state.status === 'error') return state.error || '播放失败'
  if (download && (state.trackId === null || download.trackId === state.trackId)) {
    return download.total > 0
      ? `正在下载 ${Math.round((download.received / download.total) * 100)}%`
      : `正在下载 ${formatBytes(download.received)}`
  }
  if (state.status === 'loading') return '正在准备音频与节拍…'
  if (state.status === 'playing') {
    const bpm = state.bpm > 0 ? ` · ${Math.round(state.bpm)} BPM` : ''
    const mood = state.mood ? ` · ${MOOD_LABELS[state.mood] ?? ''}` : ''
    return `正在播放${bpm}${mood}`
  }
  if (state.status === 'paused') return '已暂停'
  return state.trackId ? '已就绪' : '从曲库选一首开始'
}

function newTrackIds(before: MusicLibraryView | null, after: MusicLibraryView): string[] {
  const old = new Set(before?.tracks.map((track) => track.id) ?? [])
  return after.tracks.filter((track) => !old.has(track.id)).map((track) => track.id)
}

export default function MusicApp(): JSX.Element {
  const native = inTauri()
  const player = useMusicPlayer({ enabled: native, progress: true })
  const [library, setLibrary] = useState<MusicLibraryView | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyTag, setBusyTag] = useState('' as MusicBusy)
  const [seeking, setSeeking] = useState<number | null>(null)
  const [remoteName, setRemoteName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const state = player.state
  const status = playerStatusText(state, player.download)
  const musicFollowEnabled = loadQiLingSettings().music
  const tracks = library?.tracks ?? []
  const controlsDisabled = !native || Boolean(busyTag)

  const refresh = useCallback(async () => {
    if (!native) return
    try {
      setLibrary(await loadMusicLibrary())
      setError('')
    } catch (reason) {
      setError(musicErrorMessage(reason))
    }
  }, [native])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!native) return
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [native, refresh])

  useEffect(() => {
    if (!confirmClear) return
    const timer = window.setTimeout(() => setConfirmClear(false), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirmClear])

  const run = async (tag: MusicBusy, task: () => Promise<void>) => {
    setBusyTag(tag)
    setNotice('')
    setError('')
    try {
      await task()
    } catch (reason) {
      setError(musicErrorMessage(reason))
    } finally {
      setBusyTag('')
    }
  }

  const playFirstNew = (before: MusicLibraryView | null, after: MusicLibraryView) => {
    if (state.status === 'playing') return
    const [first] = newTrackIds(before, after)
    if (first) player.send({ type: 'playTrack', id: first })
  }

  const addLocal = () =>
    run('local', async () => {
      const paths = await pickMusicFiles()
      if (paths.length === 0) return
      const result = await addLocalMusic(paths)
      setLibrary(result.library)
      if (result.rejected.length > 0) {
        const details = result.rejected
          .slice(0, 3)
          .map((item) => `${item.name}（${musicErrorMessage(item.reason)}）`)
          .join('；')
        setNotice(`${result.rejected.length} 个文件未添加：${details}`)
      } else if (result.addedIds.length === 0) {
        setNotice('这些歌曲已经在曲库里了')
      } else {
        setNotice(`已添加 ${result.addedIds.length} 首到曲库`)
      }
      if (result.addedIds[0] && state.status !== 'playing') {
        player.send({ type: 'playTrack', id: result.addedIds[0] })
      }
    })

  const addRemote = () => {
    const url = remoteUrl.trim()
    if (!isHttpUrl(url)) {
      setError('请填写 http(s) 开头的音频直链。')
      return
    }
    void run('remote', async () => {
      const before = library
      const view = await addRemoteMusic(remoteName.trim(), url)
      setLibrary(view)
      setRemoteName('')
      setRemoteUrl('')
      if (newTrackIds(before, view).length > 0) {
        setNotice('已添加到曲库')
        playFirstNew(before, view)
      } else {
        setNotice('这首已经在曲库中了')
      }
    })
  }

  const removeTrack = (track: MusicTrackView) => {
    if (state.trackId === track.id) player.send({ type: 'stop' })
    void run('remove', async () => {
      setLibrary(await removeMusicTrack(track.id))
      setNotice(`已移除《${track.name}》`)
    })
  }

  const clearAll = () => {
    if (tracks.length === 0) return
    if (!confirmClear) {
      setConfirmClear(true)
      setNotice('再次点击「确认清空」会删除曲库索引与网络缓存（本地文件不受影响）。')
      return
    }
    setConfirmClear(false)
    player.send({ type: 'stop' })
    void run('clear', async () => {
      setLibrary(await clearMusicLibrary())
      setNotice('曲库已清空')
    })
  }

  const clearCache = () =>
    run('cache', async () => {
      const stats = await clearMusicCache()
      await refresh()
      setNotice(
        stats.files > 0
          ? `已清理 ${stats.files} 个网络缓存（${formatBytes(stats.bytes)}）`
          : '没有可清理的网络缓存',
      )
    })

  const commitSeek = () => {
    if (seeking === null) return
    player.send({ type: 'seek', position: seeking })
    setSeeking(null)
  }

  const duration = state.durationSec
  const shownPosition = Math.min(
    seeking ?? state.positionSec,
    Math.max(duration, 0.1),
  )

  return (
    <main className="pet-settings music-app" aria-label="器灵曲库">
      <header className="settings-header">
        <h1>器灵 · 曲库</h1>
        <p>
          添加本地文件或网络音频直链；器灵会按曲库顺序播放，并在本机分析节拍与能量。
          关闭这个窗口不会停止播放。
        </p>
      </header>

      {!native && (
        <p className="settings-error" role="alert">
          曲库仅应用内可用：请从器灵设定或托盘菜单打开。
        </p>
      )}

      <section className="settings-section music-now" aria-labelledby="music-now-title">
        <h2 id="music-now-title">正在播放</h2>
        <p className="music-current">
          {state.trackName ? `《${state.trackName}》` : '还没有选择曲目'}
        </p>
        <div className="music-progress">
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.1}
            value={shownPosition}
            aria-label="播放进度"
            disabled={!native || !state.trackId || duration <= 0 || state.status === 'loading'}
            onChange={(event) => setSeeking(Number(event.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
            onBlur={commitSeek}
          />
          <span className="music-time">
            {formatClock(shownPosition)} / {formatClock(duration)}
          </span>
        </div>
        <div className="music-controls">
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => player.send({ type: 'previous' })}
          >
            上一首
          </button>
          <button
            type="button"
            className="music-play"
            disabled={controlsDisabled}
            onClick={() => player.send({ type: 'toggle' })}
          >
            {state.status === 'playing' ? '暂停' : '播放'}
          </button>
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => player.send({ type: 'stop' })}
          >
            停止
          </button>
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={() => player.send({ type: 'next' })}
          >
            下一首
          </button>
        </div>
        <label className="music-volume">
          音量
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            aria-label="音量"
            disabled={!native}
            onChange={(event) => player.send({ type: 'volume', volume: Number(event.target.value) })}
          />
        </label>
        <p role="status" aria-live="polite" className="music-status">
          {status}
        </p>
        {!native && <p className="music-note">当前是浏览器预览，播放引擎只在桌面版运行。</p>}
        {native && !musicFollowEnabled && (
          <p className="music-note">
            「听音乐时自动切换状态」已关闭：音乐能播放，但灵泡不会跟着节拍切换表情。
          </p>
        )}
      </section>

      <section className="settings-section music-library" aria-labelledby="music-library-title">
        <h2 id="music-library-title">曲库</h2>
        <p className="music-note">
          {library
            ? `共 ${tracks.length} 首 · 网络缓存 ${library.cache.files} 个 / ${formatBytes(
                library.cache.bytes,
              )}`
            : '正在读取曲库…'}
        </p>
        {library && tracks.length === 0 && (
          <p className="music-empty">曲库还是空的：添加本地文件或网络音频直链后，点播放即可。</p>
        )}
        <ul className="music-track-list">
          {tracks.map((track) => {
            const active = state.trackId === track.id
            return (
              <li key={track.id} className={`music-track${active ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="music-track-main"
                  disabled={controlsDisabled || !track.available}
                  title={track.available ? `播放《${track.name}》` : '文件不可用'}
                  onClick={() => player.send({ type: 'playTrack', id: track.id })}
                >
                  <span className="music-track-name">{track.name}</span>
                  <span className={`music-badge is-${track.kind}`}>{trackKindLabel(track.kind)}</span>
                  {track.kind === 'remote' && (
                    <span className="music-badge">
                      {track.available ? `已缓存 ${formatBytes(track.cacheBytes)}` : '首次播放时下载'}
                    </span>
                  )}
                  {!track.available && <span className="music-badge is-missing">不可用</span>}
                </button>
                <button
                  type="button"
                  className="music-track-remove"
                  aria-label={`移除《${track.name}》`}
                  disabled={controlsDisabled}
                  onClick={() => removeTrack(track)}
                >
                  移除
                </button>
              </li>
            )
          })}
        </ul>

        <div className="music-actions">
          <button type="button" disabled={controlsDisabled || busyTag === 'local'} onClick={addLocal}>
            {busyTag === 'local' ? '正在添加…' : '添加本地音乐…'}
          </button>
          <button
            type="button"
            disabled={controlsDisabled || busyTag === 'clear'}
            className={confirmClear ? 'is-danger' : undefined}
            onClick={clearAll}
          >
            {confirmClear ? '确认清空' : '清空曲库'}
          </button>
          <button
            type="button"
            disabled={controlsDisabled || busyTag === 'cache'}
            onClick={clearCache}
          >
            {busyTag === 'cache' ? '正在清理…' : '清理网络缓存'}
          </button>
        </div>

        <details className="music-remote">
          <summary>添加网络歌曲…</summary>
          <p className="music-note">
            支持能直接下载音频的 http(s) 直链（mp3 / wav / flac / ogg / m4a / aac）。
            首次播放会下载到本机缓存，之后不再重复下载。
          </p>
          <label>
            名称（可选）
            <input
              type="text"
              value={remoteName}
              maxLength={120}
              disabled={!native}
              placeholder="不填就用链接里的文件名"
              onChange={(event) => setRemoteName(event.target.value)}
            />
          </label>
          <label>
            音频直链
            <input
              type="url"
              value={remoteUrl}
              maxLength={2048}
              disabled={!native}
              placeholder="https://example.com/song.mp3"
              onChange={(event) => setRemoteUrl(event.target.value)}
            />
          </label>
          <button type="button" disabled={controlsDisabled || busyTag === 'remote'} onClick={addRemote}>
            {busyTag === 'remote' ? '正在添加…' : '添加到曲库'}
          </button>
        </details>

        {notice && (
          <p className="music-notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        {!player.connected && native && <p className="music-note">正在连接器灵…</p>}
        {library?.storageDir && (
          <p className="music-note">曲库索引保存在：{library.storageDir}（仅本机）</p>
        )}
        <p className="music-note">
          本地文件只保存路径、不复制；曲库播放使用设定页的三档阈值与表情开关。
          网络歌曲只有你填写的链接会发给对应服务器。
        </p>
      </section>
    </main>
  )
}