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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => watchQiLingSettings(setSettings), [])

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
          {clients.map((client) => (
            <article className="settings-card" key={client.clientKey}>
              <strong>{client.client.name}</strong>
              <span>{client.client.id} · {client.client.version}</span>
              <span>已授权：{capabilitySummary(client.capabilities)}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void revokeClient(client.clientKey)}
              >
                撤销授权
              </button>
            </article>
          ))}
        </div>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>
    </main>
  )
}
