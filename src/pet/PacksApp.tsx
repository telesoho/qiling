import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  formatInstalledAt,
  loadPacksView,
  packErrorMessage,
  packTrustNote,
  type ActiveCharacter,
  type CharacterSummary,
  type PacksView,
} from './packs'
import { inTauri } from './sync'

type Busy = '' | 'install' | 'activate' | 'uninstall'

export interface PackListProps {
  view: PacksView
  busy: Busy
  onActivate: (character: CharacterSummary) => void
  onUninstall: (character: CharacterSummary) => void
}

function CharacterArt({
  character,
  size,
}: {
  character: CharacterSummary
  size: 'hero' | 'card'
}): JSX.Element {
  const className = size === 'hero' ? 'pack-hero-art' : 'pack-card-art'
  return (
    <div className={className}>
      {character.thumbnailUrl ? (
        <img
          src={character.thumbnailUrl}
          alt={size === 'hero' ? character.name : ''}
          draggable={false}
        />
      ) : (
        <span aria-hidden="true">{character.name.slice(0, 1)}</span>
      )}
    </div>
  )
}

function cardMeta(character: CharacterSummary): string {
  if (character.builtin) return ''
  const parts: string[] = []
  if (character.version) parts.push(`v${character.version}`)
  if (character.author) parts.push(character.author)
  if (character.trackCount) parts.push(`${character.trackCount} 条轨`)
  if (character.pickupMode === 'window-only') parts.push('吊起仅移窗')
  else if (character.pickupMode === 'animated') parts.push('完整吊起')
  if (character.installedAt) parts.push(`${formatInstalledAt(character.installedAt)} 安装`)
  return parts.join(' · ')
}

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  lingpao:
    '纯色小团子 · 待机 / 讲解 / 思考 / 优势 / 劣势 · 听音乐三档律动 · 拖拽拉长',
  shiju: '红唐装圆扇棋灵 · 待机 / 讲解 / 思考 / 优势 / 劣势 · 吊起四相位',
}

/** 当前角色大卡片。 */
export function PackHero({ character }: { character: CharacterSummary }): JSX.Element {
  const description =
    character.description?.trim() ||
    (character.builtin
      ? BUILTIN_DESCRIPTIONS[character.id] ?? '内置角色'
      : '用户安装的角色资源包 · 待机 / 姿势 / 吊起按包内动画轨运行')
  return (
    <section className="pack-hero" aria-label="当前角色">
      <CharacterArt character={character} size="hero" />
      <div className="pack-hero-meta">
        <h2>{character.name}</h2>
        <div className="pack-badges">
          <span className="pack-badge is-on">启用中</span>
          {character.builtin && <span className="pack-badge is-builtin">内置</span>}
          {!character.builtin && character.version && (
            <span className="pack-badge">v{character.version}</span>
          )}
          {!character.builtin && character.trackCount ? (
            <span className="pack-badge">{character.trackCount} 条轨</span>
          ) : null}
        </div>
        <p className="pack-desc">{description}</p>
        <p className="pack-hint">
          {character.builtin
            ? '内置角色始终可用，不可卸载。'
            : '卸载当前角色后会立即回到默认的灵泡。'}
        </p>
      </div>
    </section>
  )
}

/** 已安装列表：内置灵泡、诗琚 + 资源包。 */
export function PackList({ view, busy, onActivate, onUninstall }: PackListProps): JSX.Element {
  return (
    <div className="pack-grid">
      {view.characters.map((character) => {
        const meta = cardMeta(character)
        return (
          <article
            className={`pack-card${character.active ? ' is-active' : ''}`}
            key={character.id}
          >
            <CharacterArt character={character} size="card" />
            <div className="pack-card-body">
              <h3>{character.name}</h3>
              <p className="pack-sub">
                {character.builtin ? '内置' : '用户安装'} ·{' '}
                {character.active ? '启用中' : '未启用'}
              </p>
              {meta && <p className="pack-card-meta">{meta}</p>}
              <div className="pack-card-row">
                {character.active ? (
                  <button type="button" className="pack-chip" disabled>
                    已启用
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pack-chip"
                    disabled={busy !== ''}
                    onClick={() => onActivate(character)}
                  >
                    {busy === 'activate' ? '切换中…' : '启用'}
                  </button>
                )}
                {!character.builtin && (
                  <button
                    type="button"
                    className="pack-chip is-danger"
                    disabled={busy !== ''}
                    onClick={() => onUninstall(character)}
                  >
                    {busy === 'uninstall' ? '卸载中…' : '卸载'}
                  </button>
                )}
              </div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

export default function PacksApp(): JSX.Element {
  const native = inTauri()
  const [view, setView] = useState<PacksView | null>(null)
  const [loading, setLoading] = useState(native)
  const [busy, setBusy] = useState<Busy>('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  async function refresh(): Promise<void> {
    try {
      const next = await loadPacksView()
      setView(next)
      setError('')
    } catch (reason) {
      setError(packErrorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!native) {
      setLoading(false)
      return
    }
    let alive = true
    void loadPacksView()
      .then((next) => {
        if (alive) setView(next)
      })
      .catch((reason) => {
        if (alive) setError(packErrorMessage(reason))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [native])

  async function install(): Promise<void> {
    setBusy('install')
    setStatus('')
    setError('')
    try {
      const path = await invoke<string | null>('pet_pack_pick_archive')
      if (!path) return
      let pack: CharacterSummary
      try {
        pack = await invoke<CharacterSummary>('pet_pack_install', { path, replace: false })
      } catch (reason) {
        if (!String(reason).includes('pack_exists')) throw reason
        if (!window.confirm('已安装同 id 的角色资源包。要用所选文件替换它吗？')) return
        pack = await invoke<CharacterSummary>('pet_pack_install', { path, replace: true })
      }
      setStatus(`已安装并注册「${pack.name}」。可以在列表里启用它。`)
      await refresh()
    } catch (reason) {
      setError(packErrorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  async function activate(character: CharacterSummary): Promise<void> {
    setBusy('activate')
    setStatus('')
    setError('')
    try {
      const active = await invoke<ActiveCharacter>('pet_pack_set_active', {
        packId: character.id,
      })
      setStatus(`正在使用「${active.name}」。`)
      await refresh()
    } catch (reason) {
      setError(packErrorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  async function uninstall(character: CharacterSummary): Promise<void> {
    const fallback = character.active ? '当前角色会立即回到默认的灵泡。' : ''
    if (!window.confirm(`卸载「${character.name}」？${fallback}`)) return
    setBusy('uninstall')
    setStatus('')
    setError('')
    try {
      await invoke<ActiveCharacter>('pet_pack_uninstall', { packId: character.id })
      setStatus(`已卸载「${character.name}」。`)
      await refresh()
    } catch (reason) {
      setError(packErrorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  const active = view?.characters.find((character) => character.active) ?? view?.characters[0]

  return (
    <main className="pack-page" aria-label="角色资源包">
      <header className="pack-head">
        <div>
          <h1>角色资源包</h1>
          <p>安装角色包后可切换桌宠形象。同时只能启用一位角色。</p>
        </div>
        {native && (
          <div className="pack-head-actions">
            <button
              type="button"
              className="pack-btn is-ghost"
              title="刷新"
              aria-label="刷新"
              disabled={busy !== '' || loading}
              onClick={() => void refresh()}
            >
              ↻
            </button>
            <button
              type="button"
              className="pack-btn is-primary"
              disabled={busy !== ''}
              onClick={() => void install()}
            >
              {busy === 'install' ? '正在安装…' : '安装资源包…'}
            </button>
          </div>
        )}
      </header>

      {!native ? (
        <p className="pack-notice is-error">请在器灵应用内管理角色资源包。</p>
      ) : (
        <>
          {loading && <p className="pack-notice">正在读取角色资源包…</p>}
          {status && (
            <p className="pack-notice is-status" role="status" aria-live="polite">
              {status}
            </p>
          )}
          {error && (
            <p className="pack-notice is-error" role="alert" aria-live="polite">
              {error}
            </p>
          )}

          {active && (
            <>
              <div className="pack-section-label">当前角色</div>
              <PackHero character={active} />
            </>
          )}

          {view && (
            <>
              <div className="pack-section-label">已安装</div>
              <PackList
                view={view}
                busy={busy}
                onActivate={(character) => void activate(character)}
                onUninstall={(character) => void uninstall(character)}
              />
            </>
          )}
        </>
      )}

      <div className="pack-foot">
        <details className="pack-help">
          <summary>安全与格式说明</summary>
          <div className="pack-help-inner">
            {packTrustNote} 资源包是自包含 ZIP（建议扩展名 <code>.qilingpet</code>）；
            安装、替换、卸载均需在此确认。
          </div>
        </details>
        <details className="pack-help">
          <summary>怎样制作角色资源包？</summary>
          <div className="pack-help-inner">
            按 <code>track_struct</code> 约定组织动画轨并打包为 ZIP 即可。必做动作是 idle、think、
            explain、advantage、disadvantage；pickup 默认要求完整 lift/hover/drop，也可声明{' '}
            <code>"pickup": "window-only"</code> 只保留移窗。完整字段与打包步骤见仓库文档{' '}
            <code>docs/pet-packs.md</code>。
          </div>
        </details>
        {view && <div className="pack-path">本地目录 · {view.storageDir}</div>}
      </div>
    </main>
  )
}
