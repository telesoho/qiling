import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { loadQiLingSettings, saveQiLingSettings, watchQiLingSettings, type PetSettings } from '../lib/settings'

interface ClientInfo {
  id: string
  name: string
  version: string
}

interface CapabilityManifest {
  actions: Array<{ id: string; risk: string }>
  events: { publishes: string[]; subscribes: string[] }
}

interface PairingRequest {
  requestId: string
  client: ClientInfo
  requestedCapabilities: CapabilityManifest
}

interface AuthorizedClient {
  clientKey: string
  client: ClientInfo
  capabilities: CapabilityManifest
  createdAt: number
  connected: boolean
}

interface SpiritEvent {
  clientId: string
  eventType: string
  payload: { status?: string }
}

interface PairingCode {
  code: string
  expiresInSeconds: number
}

function capabilitySummary(capabilities: CapabilityManifest): string {
  const actions = capabilities.actions.map((action) => `${action.id}（${action.risk}）`)
  const events = capabilities.events.publishes.map((event) => `发布事件：${event}`)
  return [...actions, ...events].join('；') || '无'
}

export default function SettingsApp(): JSX.Element {
  const [settings, setSettings] = useState<PetSettings>(loadQiLingSettings)
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null)
  const [pending, setPending] = useState<PairingRequest[]>([])
  const [clients, setClients] = useState<AuthorizedClient[]>([])
  const [spiritEvent, setSpiritEvent] = useState<SpiritEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionStatus, setActionStatus] = useState('')
  const [actionError, setActionError] = useState('')

  useEffect(() => watchQiLingSettings(setSettings), [])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<SpiritEvent>('spirit-event', ({ payload }) => {
          if (active && payload.eventType === 'siju.analysis.status') {
            setSpiritEvent(payload)
          }
        }),
      )
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch((reason: unknown) => {
        if (active) setError(`无法订阅识局状态事件：${String(reason)}`)
      })
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const [nextPending, nextClients] = await Promise.all([
          invoke<PairingRequest[]>('spirit_pending_pairings'),
          invoke<AuthorizedClient[]>('spirit_list_clients'),
        ])
        if (!active) return
        setPending(nextPending)
        setClients(nextClients)
        setError('')
      } catch (reason) {
        if (active) setError(`无法读取客户端授权：${String(reason)}`)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  function patch(next: Partial<PetSettings>) {
    saveQiLingSettings({ ...loadQiLingSettings(), ...next })
  }

  async function startPairing() {
    setBusy(true)
    setError('')
    try {
      setPairingCode(await invoke<PairingCode>('spirit_start_pairing'))
    } catch (reason) {
      setError(`无法生成配对码：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  async function decidePairing(requestId: string, approve: boolean) {
    setBusy(true)
    setError('')
    try {
      await invoke(approve ? 'spirit_approve_pairing' : 'spirit_reject_pairing', { requestId })
      setPending((items) => items.filter((item) => item.requestId !== requestId))
    } catch (reason) {
      setError(`处理配对请求失败：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  async function revokeClient(clientKey: string) {
    setBusy(true)
    setError('')
    try {
      await invoke('spirit_revoke_client', { clientKey })
      setClients((items) => items.filter((client) => client.clientKey !== clientKey))
    } catch (reason) {
      setError(`撤销客户端失败：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  async function requestNarration() {
    setBusy(true)
    setError('')
    setActionStatus('')
    setActionError('')
    try {
      await invoke('spirit_invoke_narrate_current')
      setActionStatus('识局已返回新解说，器灵正在反馈。')
    } catch (reason) {
      const code = String(reason)
      const message = code.includes('client_unavailable')
        ? '识局当前未连接。'
        : code.includes('state_unavailable')
          ? '识局当前没有可用的局面分析。'
          : code.includes('state_stale')
            ? '局面分析已过期，请等待更新后重试。'
            : code.includes('summarizer_unavailable')
              ? '识局当前的解说服务不可用。'
              : code.includes('deadline_exceeded')
                ? '重新解说超时。'
                : code.includes('busy')
                  ? '识局正在处理另一条解说请求。'
                  : `请求解说失败：${code}`
      setActionError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="pet-settings" aria-label="设定">
      <section className="settings-section">
        <h1>器灵设定</h1>
        <label>
          <input
            type="checkbox"
            checked={settings.voice}
            onChange={(event) => patch({ voice: event.target.checked })}
          />
          语音
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.bubble}
            onChange={(event) => patch({ bubble: event.target.checked })}
          />
          气泡
        </label>
      </section>

      <section className="settings-section" aria-labelledby="clients-title">
        <h2 id="clients-title">已连接客户端</h2>
        <p>配对只开放给本机客户端；每个客户端及其能力都需要你批准。</p>
        <button type="button" disabled={busy} onClick={() => void startPairing()}>
          生成一次性配对码
        </button>
        {pairingCode && (
          <p className="pairing-code" role="status">
            配对码：<strong>{pairingCode.code}</strong>（{Math.floor(pairingCode.expiresInSeconds / 60)} 分钟内有效，仅可使用一次）
          </p>
        )}

        {pending.length > 0 && (
          <div className="settings-list">
            <h3>等待批准</h3>
            {pending.map((request) => (
              <article className="settings-card" key={request.requestId}>
                <strong>{request.client.name}</strong>
                <span>{request.client.id} · {request.client.version}</span>
                <span>请求能力：{capabilitySummary(request.requestedCapabilities)}</span>
                <div className="settings-actions">
                  <button type="button" disabled={busy} onClick={() => void decidePairing(request.requestId, true)}>
                    批准此客户端与能力
                  </button>
                  <button type="button" disabled={busy} onClick={() => void decidePairing(request.requestId, false)}>
                    拒绝
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="settings-list">
          <h3>已授权</h3>
          {clients.length === 0 && <p>暂无已授权客户端。</p>}
          {clients.map((client) => {
            const clientEvent = spiritEvent?.clientId === client.client.id ? spiritEvent : null
            return (
              <article className="settings-card" key={client.clientKey}>
                <strong>{client.client.name}</strong>
                <span>{client.client.id} · {client.client.version}</span>
                <span>已授权：{capabilitySummary(client.capabilities)}</span>
                <span>
                  连接状态：{client.connected ? '已连接' : '未连接'}
                  {clientEvent && ` · ${clientEvent.payload.status === 'ready' ? '可解说' : '当前不可解说'}`}
                </span>
                {client.capabilities.actions.some((action) => action.id === 'siju.narrate_current') && (
                  <button
                    type="button"
                    disabled={busy || !client.connected || clientEvent?.payload.status === 'unavailable'}
                    onClick={() => void requestNarration()}
                  >
                    {busy ? '正在请求…' : '请识局重新解说当前局面'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revokeClient(client.clientKey)}
                >
                  撤销授权
                </button>
              </article>
            )
          })}
        </div>
        {actionStatus && <p className="settings-status" role="status">{actionStatus}</p>}
        {actionError && <p className="settings-error" role="alert">{actionError}</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}
