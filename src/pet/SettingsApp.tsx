import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  isVoiceEnginePreference,
  isValidWakeWord,
  loadQiLingSettings,
  saveQiLingSettings,
  watchQiLingSettings,
  type PetSettings,
} from '../lib/settings'
import { startVoiceTest, type VoiceTestPlayback } from '../lib/speech'
import {
  voiceAssistantErrorMessage,
  voiceAssistantStateLabel,
  type VoiceAssistantEvent,
} from '../lib/voice-assistant'
import {
  CHARACTER_EVENT,
  loadPacksView,
  packErrorMessage,
  type PacksView,
} from './packs'
import { musicErrorMessage, type MusicSenseStatus } from './music'
import { loadMusicSenseStatus } from './useMusicSense'
import { inTauri } from './sync'

interface ClientInfo {
  id: string
  name: string
  version: string
}

export interface VoiceCommandMetadata {
  examples: string[]
  locale?: string
}

export interface ActionCapabilityView {
  id: string
  risk: string
  description?: string
  voice?: VoiceCommandMetadata
}

export interface CapabilityManifest {
  actions: ActionCapabilityView[]
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

type LlmProvider = 'ollama' | 'deepseek' | 'openai_compatible'

interface LlmProfile {
  provider: LlmProvider
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
}

interface LlmSettings {
  provider: LlmProvider
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
  profiles: LlmProfile[]
}

interface EdgeVoiceOption {
  id: string
  label: string
  locale: string
}

const defaultLlmSettings: LlmSettings = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:4b',
  apiKeyConfigured: false,
  profiles: [],
}

const defaultLlmProfiles: Record<LlmProvider, Pick<LlmProfile, 'baseUrl' | 'model'>> = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  openai_compatible: { baseUrl: 'https://api.openai.com/v1', model: '' },
}

export function settingsForProvider(settings: LlmSettings, provider: LlmProvider): LlmSettings {
  const saved = settings.profiles.find((profile) => profile.provider === provider)
  const defaults = defaultLlmProfiles[provider]
  return {
    ...settings,
    provider,
    baseUrl: saved?.baseUrl ?? defaults.baseUrl,
    model: saved?.model ?? defaults.model,
    apiKeyConfigured: saved?.apiKeyConfigured ?? false,
  }
}

function llmSettingsErrorMessage(reason: unknown): string {
  const code = String(reason)
  const messages: Record<string, string> = {
    invalid_llm_model: '请填写有效的模型名称（最多 128 个字符）。',
    invalid_llm_url: '服务地址格式无效，请检查地址。',
    ollama_must_use_loopback: 'Ollama 仅允许使用本机地址（localhost 或 127.0.0.1）。',
    cloud_llm_requires_https: '云端服务地址必须使用 HTTPS。',
    invalid_api_key: 'API 密钥格式无效。',
    credential_store_unavailable: '无法访问 Windows 凭据管理器，请检查系统凭据服务。',
    llm_api_key_missing: '请先保存所选云端模型的 API 密钥。',
    llm_auth_failed: 'API 密钥无效或已失效，请检查服务商控制台。',
    model_unavailable: '找不到该模型，请确认模型名称和服务商设置。',
    llm_unavailable: '无法连接语言模型服务，请检查地址、网络和服务状态。',
    llm_timeout: '等待模型响应超时，请检查网络和模型服务后重试。',
    llm_settings_invalid: '已保存的模型设置无法读取，请重新保存。',
    llm_settings_unavailable: '无法读取或保存模型设置。',
    local_llm_failed: '模型响应格式异常，请检查所选服务是否兼容 OpenAI Chat Completions。',
  }
  return messages[code] ?? `语言模型操作失败：${code}`
}

function modelListErrorMessage(reason: unknown): string {
  const code = String(reason)
  if (code.includes('ollama_must_use_loopback')) return 'Ollama 只能读取本机地址上的模型。'
  if (code.includes('invalid_llm_url')) return '服务地址格式无效，读不到模型列表。'
  if (code.includes('llm_unavailable')) return '无法连接 Ollama，请确认它已经启动。'
  return `无法读取已安装模型：${code}`
}

/** Installed models first; keep a saved name that Ollama no longer lists selectable. */
export function modelOptions(
  installed: readonly string[],
  current: string,
): Array<{ value: string; label: string }> {
  const model = current.trim()
  const options = installed.map((name) => ({ value: name, label: name }))
  if (model && !installed.includes(model)) {
    options.unshift({ value: model, label: `${model}（未在已安装列表）` })
  }
  return options
}

/** `qwen3` that Ollama only knows as `qwen3:latest` becomes a real installed name. */
export function normalizeModelName(installed: readonly string[], current: string): string {
  const model = current.trim()
  if (!model) return current
  if (installed.includes(model)) return model
  const latest = `${model}:latest`
  return installed.includes(latest) ? latest : model
}

const knownActionLabels: Record<string, string> = {
  'siju.narrate_current': '识局：重新解说当前局面（只读）',
  'vscode.explain_selection': 'VS Code：解释当前选区（读取所选文本）',
}

const knownEventLabels: Record<string, string> = {
  'siju.analysis.status': '识局分析状态',
  'vscode.editor.status': 'VS Code 编辑器状态',
}

export function actionDisplayName(action: ActionCapabilityView): string {
  return knownActionLabels[action.id] ?? action.description?.trim() ?? action.id
}

export function capabilitySummary(capabilities: CapabilityManifest): string {
  const actions = capabilities.actions.map((action) =>
    knownActionLabels[action.id] ??
      `${action.description?.trim() || action.id}（${action.risk}）`,
  )
  const events = capabilities.events.publishes.map(
    (event) => `发布事件：${knownEventLabels[event] ?? event}`,
  )
  return [...actions, ...events].join('；') || '无'
}

export function voiceExamples(action: ActionCapabilityView): string[] {
  return action.voice?.examples ?? []
}

/** All client-provided spoken phrases in a manifest, for display only. */
export function voiceExampleSummary(capabilities: CapabilityManifest): string {
  const phrases = capabilities.actions.flatMap((action) =>
    voiceExamples(action).map((example) => `“${example}”`),
  )
  return Array.from(new Set(phrases)).join('、')
}

export function actionButtonLabel(
  action: ActionCapabilityView,
  clientName: string,
): string {
  if (action.id === 'siju.narrate_current') {
    return `请${clientName}重新解说当前局面`
  }
  if (action.id === 'vscode.explain_selection') {
    return '解释当前选区'
  }
  return action.description?.trim() || action.id
}

/** State-changing Actions still need a confirmation flow that V1 does not have. */
export function actionCanRunFromSettings(action: ActionCapabilityView): boolean {
  return action.risk !== 'state_change'
}

function actionErrorMessage(reason: unknown, clientName: string): string {
  const code = String(reason)
  const messages: Array<[string, string]> = [
    ['client_unavailable', `${clientName}当前未连接。`],
    ['not_authorized', `${clientName}尚未获准执行这个操作。`],
    ['action_not_found', `${clientName}没有提供这个操作。`],
    ['busy', `${clientName}正在处理另一条请求。`],
    ['state_unavailable', `${clientName}当前没有可用的状态。`],
    ['state_stale', `${clientName}的状态已经变化。`],
    ['summarizer_unavailable', `${clientName}当前的服务不可用。`],
    ['selection_unavailable', `${clientName}当前没有可解释的选区。`],
    ['selection_too_large', '当前选区太长，请缩小选区后再试。'],
    ['model_unavailable', `${clientName}当前没有可用且已授权的语言模型。`],
    ['deadline_exceeded', `等待${clientName}执行超时。`],
    ['cancelled', '已取消这次操作。'],
    ['invalid_action_response', `${clientName}返回的结果格式不正确。`],
  ]
  return messages.find(([needle]) => code.includes(needle))?.[1] ?? `执行${clientName}的操作失败：${code}`
}

export default function SettingsApp(): JSX.Element {
  const native = inTauri()
  const [settings, setSettings] = useState<PetSettings>(loadQiLingSettings)
  const [wakeWordDraft, setWakeWordDraft] = useState(() => loadQiLingSettings().wakeWord)
  const [savingWakeWord, setSavingWakeWord] = useState(false)
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null)
  const [pending, setPending] = useState<PairingRequest[]>([])
  const [clients, setClients] = useState<AuthorizedClient[]>([])
  const [spiritEvents, setSpiritEvents] = useState<Record<string, SpiritEvent>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionStatus, setActionStatus] = useState('')
  const [actionError, setActionError] = useState('')
  const [voiceAssistantState, setVoiceAssistantState] = useState(
    () => loadQiLingSettings().voiceAssistant ? 'starting' : 'stopped',
  )
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceAssistantError, setVoiceAssistantError] = useState('')
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(defaultLlmSettings)
  const [savedLlmSettings, setSavedLlmSettings] = useState<LlmSettings>(defaultLlmSettings)
  const [llmApiKey, setLlmApiKey] = useState('')
  const [clearLlmApiKey, setClearLlmApiKey] = useState(false)
  const [loadingLlmSettings, setLoadingLlmSettings] = useState(true)
  const [llmSettingsLoaded, setLlmSettingsLoaded] = useState(false)
  const [savingLlmSettings, setSavingLlmSettings] = useState(false)
  const [testingLlmConnection, setTestingLlmConnection] = useState(false)
  const [llmError, setLlmError] = useState('')
  const [llmStatus, setLlmStatus] = useState('')
  const [installedModels, setInstalledModels] = useState<string[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelListError, setModelListError] = useState('')
  const modelRequest = useRef(0)
  const [testingVoice, setTestingVoice] = useState(false)
  const [voiceTestStatus, setVoiceTestStatus] = useState('')
  const voiceTest = useRef<VoiceTestPlayback | null>(null)
  const [edgeVoices, setEdgeVoices] = useState<EdgeVoiceOption[]>([])
  const [loadingEdgeVoices, setLoadingEdgeVoices] = useState(false)
  const [edgeVoiceError, setEdgeVoiceError] = useState('')
  const [characterView, setCharacterView] = useState<PacksView | null>(null)
  const [characterError, setCharacterError] = useState('')
  const [musicStatus, setMusicStatus] = useState<MusicSenseStatus | null>(null)
  const [musicStatusError, setMusicStatusError] = useState('')

  useEffect(() => watchQiLingSettings(setSettings), [])
  useEffect(() => setWakeWordDraft(settings.wakeWord), [settings.wakeWord])

  useEffect(() => {
    if (!native) return
    let active = true
    let stop: (() => void) | undefined
    const refresh = () => {
      void loadPacksView()
        .then((view) => {
          if (active) {
            setCharacterView(view)
            setCharacterError('')
          }
        })
        .catch((reason: unknown) => {
          if (active) setCharacterError(packErrorMessage(reason))
        })
    }
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen(CHARACTER_EVENT, refresh))
      .then((unlisten) => {
        if (active) stop = unlisten
        else unlisten()
      })
      .catch(() => {})
    return () => {
      active = false
      stop?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [native])

  useEffect(() => {
    if (!native || !settings.music) {
      setMusicStatus(null)
      setMusicStatusError('')
      return
    }
    let active = true
    const refresh = () => {
      void loadMusicSenseStatus()
        .then((status) => {
          if (!active) return
          setMusicStatus(status)
          setMusicStatusError(status.lastError ? musicErrorMessage(status.lastError) : '')
        })
        .catch((reason: unknown) => {
          if (active) setMusicStatusError(musicErrorMessage(reason))
        })
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [native, settings.music])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return
    let active = true
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ engine?: string; detail?: string }>(
        'qiling-voice-route',
        ({ payload }) => {
          if (active && payload.engine === 'system' && payload.detail) {
            setVoiceTestStatus(payload.detail)
          }
        },
      ))
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch((reason: unknown) => {
        console.warn('无法接收语音回退状态', String(reason))
      })
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  useEffect(() => () => {
    voiceTest.current?.stop()
    voiceTest.current = null
  }, [])

  useEffect(() => {
    let active = true
    void invoke<LlmSettings>('qiling_llm_get_settings')
      .then((saved) => {
        if (active) {
          setLlmSettings(saved)
          setSavedLlmSettings(saved)
          setLlmSettingsLoaded(true)
        }
      })
      .catch((reason: unknown) => {
        if (active) setLlmError(llmSettingsErrorMessage(reason))
      })
      .finally(() => {
        if (active) setLoadingLlmSettings(false)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!llmSettingsLoaded || llmSettings.provider !== 'ollama') {
      setInstalledModels(null)
      setModelListError('')
      return
    }
    void refreshModels(llmSettings.baseUrl)
    // Only re-read when the provider changes; the address has its own refresh button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llmSettingsLoaded, llmSettings.provider])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    let stateEventRevision = 0
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<VoiceAssistantEvent>('voice-assistant-event', ({ payload }) => {
          if (!active) return
          if (payload.type === 'state' && payload.state) {
            stateEventRevision += 1
            setVoiceAssistantState(payload.state)
            setVoiceAssistantError('')
          } else if (payload.type === 'error') {
            stateEventRevision += 1
            setVoiceAssistantState('error')
            setVoiceAssistantError(voiceAssistantErrorMessage(payload.code ?? 'voice_engine_failed'))
          } else if (payload.type === 'warning') {
            setVoiceAssistantError('麦克风音频暂时拥塞，可能影响本轮识别。')
          } else if (
            (payload.type === 'debug_transcript' || payload.type === 'transcript') &&
            payload.text
          ) {
            setVoiceTranscript(payload.text)
          }
        }),
      )
      .then(async (stop) => {
        if (active) unlisten = stop
        else stop()
        if (!active) return
        const revision = stateEventRevision
        try {
          const currentState = await invoke<string>('qiling_voice_assistant_status')
          if (active && stateEventRevision === revision) {
            setVoiceAssistantState(currentState)
          }
          if (active && currentState === 'stopped' && loadQiLingSettings().voiceAssistant) {
            // The switch says on but nothing is listening. Start it again while the
            // pet is visible so the page cannot sit on a stale "已关闭".
            const petOpen = await invoke<boolean>('pet_is_open').catch(() => false)
            if (active && petOpen) {
              setVoiceAssistantState('starting')
              await invoke('qiling_voice_assistant_start', {
                wakeWord: loadQiLingSettings().wakeWord,
              })
              if (active) {
                setVoiceAssistantState(await invoke<string>('qiling_voice_assistant_status'))
              }
            }
          }
        } catch (reason) {
          if (active) {
            setVoiceAssistantState('error')
            setVoiceAssistantError(voiceAssistantErrorMessage(String(reason)))
          }
        }
      })
      .catch((reason: unknown) => {
        if (active) setVoiceAssistantError(`无法订阅本机语音状态：${String(reason)}`)
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
        const state = await invoke<string>('qiling_voice_assistant_status')
        if (active) setVoiceAssistantState(state)
      } catch {
        // The next tick can try again; the event stream carries the real errors.
      }
    }
    const timer = window.setInterval(() => void refresh(), 2_500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<SpiritEvent>('spirit-event', ({ payload }) => {
          if (
            active &&
            (payload.eventType === 'siju.analysis.status' ||
              payload.eventType === 'vscode.editor.status')
          ) {
            setSpiritEvents((events) => ({ ...events, [payload.clientId]: payload }))
          }
        }),
      )
      .then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      .catch((reason: unknown) => {
        if (active) setError(`无法订阅客户端状态事件：${String(reason)}`)
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

  async function refreshModels(baseUrl: string) {
    const request = modelRequest.current + 1
    modelRequest.current = request
    setLoadingModels(true)
    setModelListError('')
    try {
      const models = await invoke<string[]>('qiling_llm_list_models', { baseUrl })
      if (modelRequest.current !== request) return
      setInstalledModels(models)
      setLlmSettings((current) => {
        if (current.provider !== 'ollama') return current
        const model = normalizeModelName(models, current.model)
        return model === current.model ? current : { ...current, model }
      })
    } catch (reason) {
      if (modelRequest.current !== request) return
      setInstalledModels(null)
      setModelListError(modelListErrorMessage(reason))
    } finally {
      if (modelRequest.current === request) setLoadingModels(false)
    }
  }

  async function refreshEdgeVoices() {
    setLoadingEdgeVoices(true)
    setEdgeVoiceError('')
    try {
      const voices = await invoke<EdgeVoiceOption[]>('qiling_edge_voice_list')
      setEdgeVoices(voices)
      if (voices.length === 0) setEdgeVoiceError('在线服务没有返回可用的中文音色。')
    } catch (reason) {
      setEdgeVoiceError(`无法读取 Edge 中文音色：${String(reason)}`)
    } finally {
      setLoadingEdgeVoices(false)
    }
  }

  function playVoiceTest() {
    if (voiceTest.current) {
      voiceTest.current.stop()
      voiceTest.current = null
      setTestingVoice(false)
      setVoiceTestStatus('已停止试听。')
      return
    }
    setVoiceTestStatus('正在用当前播报声音试听…')
    const playback = startVoiceTest()
    voiceTest.current = playback
    setTestingVoice(true)
    void playback.done.then((engine) => {
      if (voiceTest.current !== playback) return
      voiceTest.current = null
      setTestingVoice(false)
      setVoiceTestStatus(
        engine === 'edge'
          ? '试听已用 Edge 在线语音播放。'
          : engine === 'cosyvoice'
            ? '试听已用本机 CosyVoice 播放。'
            : engine === 'system'
              ? '试听已改用 Windows 系统语音播放。'
              : '暂时没法播放试听，请检查播报声音设置。',
      )
    })
  }

  async function saveLlmSettings(): Promise<LlmSettings | null> {
    const targetChanged =
      savedLlmSettings.provider !== llmSettings.provider ||
      savedLlmSettings.baseUrl !== llmSettings.baseUrl
    if (settings.voiceAssistant && clearLlmApiKey) {
      setLlmError('请先关闭唤醒词监听，再移除正在使用的 API 密钥。')
      return null
    }
    if (
      settings.voiceAssistant &&
      llmSettings.provider !== 'ollama' &&
      targetChanged &&
      !llmSettings.apiKeyConfigured &&
      !llmApiKey.trim()
    ) {
      setLlmError('唤醒监听已开启。请先输入当前云端服务的 API 密钥，再切换对话模型。')
      return null
    }
    if (settings.voiceAssistant && llmSettings.provider !== 'ollama' && targetChanged) {
      const providerName =
        llmSettings.provider === 'deepseek' ? 'DeepSeek' : '你配置的云端兼容服务'
      if (
        !window.confirm(
          `唤醒监听当前已开启。保存后，之后识别出的语音文字将发送给${providerName}云端处理；麦克风音频仍只在本机处理。是否继续？`,
        )
      ) {
        return null
      }
    }
    setSavingLlmSettings(true)
    setLlmError('')
    setLlmStatus('')
    try {
      const saved = await invoke<LlmSettings>('qiling_llm_save_settings', {
        provider: llmSettings.provider,
        baseUrl: llmSettings.baseUrl,
        model: llmSettings.model,
        apiKey: llmApiKey,
        clearApiKey: clearLlmApiKey,
      })
      setLlmSettings(saved)
      setSavedLlmSettings(saved)
      setLlmSettingsLoaded(true)
      setLlmApiKey('')
      setClearLlmApiKey(false)
      setLlmStatus('模型设置已安全保存到本机。')
      return saved
    } catch (reason) {
      setLlmError(llmSettingsErrorMessage(reason))
      return null
    } finally {
      setSavingLlmSettings(false)
    }
  }

  async function testLlmConnection() {
    if (clearLlmApiKey) {
      setLlmError('移除 API 密钥后无法测试连接，请取消移除或先重新输入密钥。')
      return
    }
    const saved = await saveLlmSettings()
    if (!saved) return
    if (saved.provider !== 'ollama' && !saved.apiKeyConfigured) {
      setLlmStatus('')
      setLlmError('请先输入并保存当前服务商的 API 密钥，再测试连接。')
      return
    }
    setTestingLlmConnection(true)
    setLlmError('')
    setLlmStatus('正在连接并请求模型回复…')
    try {
      await invoke('qiling_llm_test_connection')
      setLlmStatus('连接成功，模型已返回回复。')
    } catch (reason) {
      setLlmStatus('')
      setLlmError(llmSettingsErrorMessage(reason))
    } finally {
      setTestingLlmConnection(false)
    }
  }

  async function setVoiceAssistant(enabled: boolean) {
    const cloudProvider =
      llmSettings.provider === 'deepseek'
        ? 'DeepSeek'
        : llmSettings.provider === 'openai_compatible'
          ? '你配置的云端兼容服务'
          : ''
    if (enabled && cloudProvider && !llmSettings.apiKeyConfigured) {
      setVoiceAssistantError('请先在“对话模型”中保存 API 密钥，再启用唤醒词监听。')
      return
    }
    if (
      enabled &&
      !window.confirm(
        `启用后器灵会持续从默认麦克风读取音频，在本机检测“${settings.wakeWord}”并临时识别语音，识别文字会显示在设定页。音频仅在本机内存中处理，不保存或上传。唤醒后，识别出的文字会发送给${cloudProvider ? `${cloudProvider}（云端模型服务）` : '本机 Ollama'}处理。是否开启？`,
      )
    ) {
      return
    }
    setVoiceAssistantError('')
    if (enabled) setVoiceAssistantState('starting')
    try {
      if (enabled) {
        await invoke('qiling_voice_assistant_start', { wakeWord: settings.wakeWord })
      } else {
        await invoke('qiling_voice_assistant_stop')
      }
      patch({ voiceAssistant: enabled })
      if (!enabled) setVoiceAssistantState('stopped')
    } catch (reason) {
      const code = String(reason)
      setVoiceAssistantState(enabled ? 'error' : voiceAssistantState)
      setVoiceAssistantError(voiceAssistantErrorMessage(code))
    }
  }

  async function saveWakeWord() {
    const wakeWord = wakeWordDraft.trim()
    if (!isValidWakeWord(wakeWord)) {
      setVoiceAssistantError('唤醒词需为 2–8 个连续汉字。')
      return
    }
    setSavingWakeWord(true)
    setVoiceAssistantError('')
    try {
      if (settings.voiceAssistant) {
        setVoiceAssistantState('starting')
        await invoke('qiling_voice_assistant_start', { wakeWord })
      }
      patch({ wakeWord })
      setWakeWordDraft(wakeWord)
    } catch (reason) {
      setVoiceAssistantError(voiceAssistantErrorMessage(String(reason)))
    } finally {
      setSavingWakeWord(false)
    }
  }

  async function cancelVoiceAssistantTurn() {
    try {
      await invoke('qiling_voice_assistant_cancel')
    } catch (reason) {
      setVoiceAssistantError(voiceAssistantErrorMessage(String(reason)))
    }
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

  async function runClientAction(
    clientId: string,
    clientName: string,
    action: ActionCapabilityView,
  ) {
    setBusy(true)
    setError('')
    setActionStatus('')
    setActionError('')
    try {
      await invoke('spirit_invoke_action', { clientId, actionId: action.id })
      setActionStatus(
        `已请求${clientName}执行“${actionButtonLabel(action, clientName)}”，器灵正在反馈。`,
      )
    } catch (reason) {
      setActionError(actionErrorMessage(reason, clientName))
    } finally {
      setBusy(false)
    }
  }

  const activeCharacter = characterView?.characters.find((character) => character.active)
  const packCount = characterView?.characters.filter((character) => !character.builtin).length ?? 0
  const musicIsForCurrentCharacter =
    !characterView || activeCharacter?.id === 'lingpao' || activeCharacter === undefined
  const musicStatusText = !native
    ? '仅应用内可用'
    : !settings.music
      ? '已关闭'
      : musicStatusError
        ? musicStatusError
        : !musicIsForCurrentCharacter
          ? '当前角色不是灵泡，音乐效果只在灵泡上出现'
          : musicStatus?.running
            ? musicStatus.music
              ? `正在跟随音乐${musicStatus.bpm && musicStatus.bpm > 0 ? ` · ${Math.round(musicStatus.bpm)} BPM` : ''}`
              : musicStatus.active
                ? '听到声音，但不是音乐（人声/噪声不跟拍）'
                : '正在监听，等待音乐'
            : musicStatus?.supported === false
              ? '当前系统不支持读取系统声音'
              : '已开启，灵泡显示时会开始跟随'

  return (
    <main className="pet-settings" aria-label="设定">
      <header className="settings-header">
        <h1>器灵设定</h1>
        <p>管理宠物角色、语音、对话模型与已授权的桌面客户端。</p>
      </header>

      <section className="settings-section" aria-labelledby="character-title">
        <h2 id="character-title">宠物角色</h2>
        <p>
          当前角色：{activeCharacter?.name ?? '灵泡'}。
          {characterView
            ? `已安装 ${packCount} 个第三方角色资源包；内置灵泡与诗琚始终可用。`
            : '正在读取角色资源包…'}
        </p>
        <p>安装资源包后会立即注册为可选角色；同一时间只有一个角色在场，切换在资源包页面完成。</p>
        <button type="button" disabled={!native} onClick={() => void invoke('pet_packs_open')}>
          管理角色资源包…
        </button>
        {characterError && <p className="settings-error" role="alert">{characterError}</p>}
      </section>

      <section className="settings-section" aria-labelledby="music-title">
        <h2 id="music-title">听音乐</h2>
        <label>
          <input
            type="checkbox"
            checked={settings.music}
            onChange={(event) => patch({ music: event.target.checked })}
          />
          听音乐时自动切换状态
        </label>
        <p>
          灵泡会读取系统正在播放的声音，在本机实时分析音量与节拍，自动在“舒缓 / 轻快 /
          激烈”之间切换并跟着摇摆。只分析声音特征，不录音、不保存、不上传。
        </p>
        <p>
          会先区分音乐与人声：视频里的说话、播客和零散提示音不会让灵泡进入摇摆状态。
        </p>
        <p>
          关闭开关或隐藏器灵后立即停止采集。只读取默认播放设备；独占模式、受版权保护的音频或非默认设备可能听不到。目前只有灵泡支持这个效果。
        </p>
        <p role="status" aria-live="polite">监听状态：{musicStatusText}</p>
      </section>

      <section className="settings-section" aria-labelledby="voice-title">
        <h2 id="voice-title">语音与唤醒</h2>
        <div className="settings-toggle-row">
          <label>
            <input
              type="checkbox"
              checked={settings.voice}
              onChange={(event) => patch({ voice: event.target.checked })}
            />
            语音播报
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.bubble}
              onChange={(event) => patch({ bubble: event.target.checked })}
            />
            对话气泡
          </label>
        </div>
        <label htmlFor="voice-engine">播报声音</label>
        <div className="voice-engine-controls">
          <select
            id="voice-engine"
            value={settings.voiceEngine}
            aria-describedby="voice-engine-help"
            onChange={(event) => {
              const voiceEngine = event.target.value
              if (isVoiceEnginePreference(voiceEngine)) patch({ voiceEngine })
            }}
          >
            <option value="auto">自动：优先 Edge 在线语音；不可用时用系统语音</option>
            <option value="edge">Edge 在线语音</option>
            <option value="cosyvoice">本机 CosyVoice</option>
            <option value="system">Windows 系统语音</option>
          </select>
          <button type="button" onClick={playVoiceTest}>
            {testingVoice ? '停止试听' : '试听'}
          </button>
        </div>
        <p id="voice-engine-help">
          自动模式会优先使用 Edge 在线语音；播报文本会发送到微软语音服务。麦克风音频及其他应用数据不会发送。“试听”会用当前选择的声音读一句示例；Edge 不可用时改用 Windows 系统语音。
        </p>
        {(settings.voiceEngine === 'auto' || settings.voiceEngine === 'edge') && (
          <>
            <label htmlFor="edge-voice">Edge 中文音色</label>
            <div className="voice-engine-controls">
              <select
                id="edge-voice"
                value={settings.edgeVoice}
                onChange={(event) => patch({ edgeVoice: event.target.value })}
              >
                {!edgeVoices.some((voice) => voice.id === settings.edgeVoice) && (
                  <option value={settings.edgeVoice}>{settings.edgeVoice}（当前）</option>
                )}
                {edgeVoices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}（{voice.locale}）
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void refreshEdgeVoices()} disabled={loadingEdgeVoices}>
                {loadingEdgeVoices ? '正在读取…' : '读取 Edge 音色'}
              </button>
            </div>
            {edgeVoiceError && (
              <p className="settings-error" role="status" aria-live="polite">
                {edgeVoiceError}
              </p>
            )}
          </>
        )}
        {voiceTestStatus && (
          <p className="settings-status" role="status" aria-live="polite">
            {voiceTestStatus}
          </p>
        )}
        <label>
          <input
            type="checkbox"
            checked={settings.voiceAssistant}
            disabled={!llmSettingsLoaded}
            onChange={(event) => void setVoiceAssistant(event.target.checked)}
          />
          唤醒词监听（麦克风）
        </label>
        <p>监听状态：{voiceAssistantStateLabel(voiceAssistantState)}</p>
        <p>隐藏器灵会暂停监听并关闭麦克风；再次显示器灵时，只要这个开关仍打开，就会自动恢复监听。</p>
        <label htmlFor="voice-wake-word">自定义唤醒词</label>
        <div className="wake-word-controls">
          <input
            id="voice-wake-word"
            type="text"
            value={wakeWordDraft}
            maxLength={8}
            aria-describedby="voice-wake-word-help"
            aria-invalid={wakeWordDraft.length > 0 && !isValidWakeWord(wakeWordDraft)}
            onChange={(event) => setWakeWordDraft(event.target.value)}
          />
          <button
            type="button"
            disabled={
              savingWakeWord ||
              !isValidWakeWord(wakeWordDraft) ||
              wakeWordDraft === settings.wakeWord
            }
            onClick={() => void saveWakeWord()}
          >
            {savingWakeWord ? '正在应用…' : settings.voiceAssistant ? '保存并应用' : '保存'}
          </button>
        </div>
        <p id="voice-wake-word-help">2–8 个连续汉字，默认“器灵”。监听开启时保存新词会立即应用。</p>
        <p>唤醒检测和语音识别均在本机运行，音频不保存。识别文字及唤醒命中信息会写入本机轮换日志（最多 4 个文件）：%APPDATA%\com.qiling.pet\voice-assistant\voice-assistant.log。</p>
        <p className="voice-transcript" role="status" aria-live="polite">
          最近识别到的语音：{voiceTranscript || '（等待识别）'}
        </p>
        <p>状态变为“器灵正在回应，请接着说”表示唤醒成功。唤醒词按拼音匹配：谐音字（例如把“七零七零”听成“欺凌欺凌”“麒麟麒麟”）以及声调说错也能命中；关键词检测漏检时，本机识别出的整句转写还会再按拼音比对一次。</p>
        <p>唤醒后器灵会保持对话状态，5 分钟内可以直接追问，不必再说唤醒词；连续 5 分钟没有新问题，才回到只监听唤醒词的状态。</p>
        <p>器灵回答时可以直接插话打断；它会继续识别，但把与自己播报文稿高度重合的结果当作回声丢弃，说完后再静音约半秒才恢复对话。器灵还念别的程序送来的句子（例如 VS Code 选区解释），这些句子同样可以打断。</p>
        <p>念到含英文标识符或数字的句子（代码类解释）时，本机识别器会把器灵自己的读音听成别的话；这类句子只响应“停”“等一下”这类明确指令，避免它被自己的声音打断。</p>
        <p>最近几条播报只记在内存里，退出器灵就清空，不写日志。只有你问“刚才讲了什么”“再复述一遍”这类指向上一句的问题时，才会把最近几条正文随问题发给当前对话模型；使用云端模型时，这些正文也会离开本机。</p>
        <p>唤醒后可以说已连接客户端登记的语音口令；例如识局获准“重新解说当前局面”后，说“重新解说当前局面”“再解说一次”即可。命中的口令不会交给对话模型。客户端未连接、未授权或当前状态不可用时，器灵会明确说明，不会用旧内容冒充成功。</p>
        <p>说“解释当前选区”暂不会触发 VS Code；请使用下方已连接客户端中的“解释当前选区”按钮，或在 VS Code 中执行“器灵：解释当前选区”。</p>
        <p>“请识局重新解说当前局面”按钮保留为语音不可用或手动重试时的备用入口。语音口令只影响匹配，不会扩大客户端授权。</p>
        {settings.voiceAssistant && (
          <button type="button" onClick={() => void cancelVoiceAssistantTurn()}>
            取消本轮对话
          </button>
        )}
        {voiceAssistantError && <p className="settings-error" role="alert">{voiceAssistantError}</p>}
      </section>

      <section className="settings-section" aria-labelledby="llm-title">
        <h2 id="llm-title">对话模型</h2>
        <p>选择器灵回答语音问题时使用的语言模型。语音播报声音不受此设置影响。</p>
        <label htmlFor="llm-provider">服务商</label>
        <select
          id="llm-provider"
          value={llmSettings.provider}
          disabled={loadingLlmSettings || savingLlmSettings}
          onChange={(event) => {
            const provider = event.target.value
            if (provider !== 'ollama' && provider !== 'deepseek' && provider !== 'openai_compatible') return
            setLlmSettings(settingsForProvider(savedLlmSettings, provider))
            setClearLlmApiKey(false)
            setLlmError('')
            setLlmStatus('')
          }}
        >
          <option value="ollama">Ollama（本机）</option>
          <option value="deepseek">DeepSeek</option>
          <option value="openai_compatible">自定义 OpenAI 兼容服务</option>
        </select>
        {llmSettings.provider !== 'deepseek' && (
          <>
            <label htmlFor="llm-base-url">服务地址</label>
            <input
              id="llm-base-url"
              type="url"
              value={llmSettings.baseUrl}
              disabled={loadingLlmSettings || savingLlmSettings}
              aria-describedby="llm-endpoint-help"
              onChange={(event) => setLlmSettings((current) => ({ ...current, baseUrl: event.target.value }))}
            />
            <p id="llm-endpoint-help">
              {llmSettings.provider === 'ollama'
                ? 'Ollama 仅连接本机地址，不会把请求发送到局域网或互联网。'
                : '自定义云端服务必须使用 HTTPS，并兼容 OpenAI Chat Completions 接口。'}
            </p>
          </>
        )}
        <label htmlFor="llm-model">模型名称</label>
        {llmSettings.provider === 'ollama' ? (
          <>
            {installedModels === null ? (
              <input
                id="llm-model"
                type="text"
                value={llmSettings.model}
                maxLength={128}
                disabled={loadingLlmSettings || savingLlmSettings}
                aria-describedby="llm-model-help"
                onChange={(event) => setLlmSettings((current) => ({ ...current, model: event.target.value }))}
              />
            ) : (
              <select
                id="llm-model"
                value={llmSettings.model}
                disabled={loadingLlmSettings || savingLlmSettings || loadingModels}
                aria-describedby="llm-model-help"
                onChange={(event) => setLlmSettings((current) => ({ ...current, model: event.target.value }))}
              >
                {modelOptions(installedModels, llmSettings.model).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            <div className="settings-actions">
              <button
                type="button"
                disabled={loadingModels || savingLlmSettings}
                onClick={() => void refreshModels(llmSettings.baseUrl)}
              >
                {loadingModels ? '正在读取…' : '刷新已安装模型'}
              </button>
            </div>
            <p id="llm-model-help">
              {loadingModels
                ? '正在从本机 Ollama 读取已安装的模型…'
                : modelListError
                  ? `${modelListError} 也可以直接填写模型名称。`
                  : installedModels === null
                    ? '正在读取本机 Ollama 的已安装模型…'
                    : installedModels.length > 0
                      ? `已安装 ${installedModels.length} 个可对话模型，从列表中选择要用的一个。`
                      : 'Ollama 里还没有可对话的模型，先运行 ollama pull 安装一个。'}
            </p>
          </>
        ) : (
          <>
            <input
              id="llm-model"
              type="text"
              value={llmSettings.model}
              maxLength={128}
              disabled={loadingLlmSettings || savingLlmSettings}
              onChange={(event) => setLlmSettings((current) => ({ ...current, model: event.target.value }))}
            />
            <p>填写服务商提供的模型名称，例如 deepseek-chat。</p>
          </>
        )}
        {llmSettings.provider !== 'ollama' && (
          <>
            <label htmlFor="llm-api-key">API 密钥</label>
            <input
              id="llm-api-key"
              type="password"
              autoComplete="new-password"
              value={llmApiKey}
              disabled={loadingLlmSettings || savingLlmSettings}
              placeholder={llmSettings.apiKeyConfigured ? '已保存；留空可继续使用' : '输入服务商提供的 API 密钥'}
              aria-describedby="llm-api-key-help"
              onChange={(event) => {
                setLlmApiKey(event.target.value)
                setClearLlmApiKey(false)
              }}
            />
            <p id="llm-api-key-help">
              {llmSettings.apiKeyConfigured
                ? '密钥已保存在 Windows 凭据管理器，不会显示或写入应用设置文件。'
                : '密钥仅保存在 Windows 凭据管理器，不会写入应用设置文件。'}
            </p>
            {llmSettings.apiKeyConfigured && (
              <label>
                <input
                  type="checkbox"
                  checked={clearLlmApiKey}
                  onChange={(event) => setClearLlmApiKey(event.target.checked)}
                />
                保存时移除已保存的 API 密钥
              </label>
            )}
            <p className="llm-privacy-note">
              使用云端模型时，唤醒后的语音识别文字会发送给所选服务商；麦克风音频始终只在本机处理。
            </p>
          </>
        )}
        <div className="settings-actions">
          <button
            type="button"
            disabled={loadingLlmSettings || savingLlmSettings || testingLlmConnection}
            onClick={() => void saveLlmSettings()}
          >
            {savingLlmSettings ? '正在保存…' : '保存模型设置'}
          </button>
          <button
            type="button"
            disabled={loadingLlmSettings || savingLlmSettings || testingLlmConnection}
            onClick={() => void testLlmConnection()}
          >
            {testingLlmConnection ? '正在测试…' : '保存并测试连接'}
          </button>
        </div>
        <p>连接测试会向当前模型发送一条简短测试提示。模型设置保存在本机。</p>
        {llmStatus && <p className="settings-status" role="status">{llmStatus}</p>}
        {llmError && <p className="settings-error" role="alert">{llmError}</p>}
      </section>

      <section className="settings-section" aria-labelledby="clients-title">
        <h2 id="clients-title">已连接客户端</h2>
        <p>配对只开放给本机客户端；每个客户端及其能力都需要你批准。</p>
        <p>唤醒器灵后，可以说已连接客户端自己登记的语音口令（例如识局的“重新解说当前局面”）；命中的口令不会交给对话模型。客户端未连接、未获授权或当前状态不可用时，器灵会明确说明。</p>
        <p>语音口令由客户端提供，只用于匹配，不会扩大授权；客户端可在已批准的操作范围内更新口令，断线或撤销后立即失效。</p>
        <p>下方按钮是语音不可用或手动重试时的备用入口。批准 VS Code 的选区解释能力后，点击按钮即可解释当前选区。VS Code 首次会让你选择模型并记住选择；可通过命令“器灵：选择解释模型”更换。只读取当前选区，不修改文件；可随时撤销授权。</p>
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
            {pending.map((request) => {
              const phrases = voiceExampleSummary(request.requestedCapabilities)
              return (
                <article className="settings-card" key={request.requestId}>
                  <strong>{request.client.name}</strong>
                  <span>{request.client.id} · {request.client.version}</span>
                  <span>请求能力：{capabilitySummary(request.requestedCapabilities)}</span>
                  {phrases && (
                    <span>语音口令（客户端提供，仅用于匹配）：{phrases}</span>
                  )}
                  <div className="settings-actions">
                    <button type="button" disabled={busy} onClick={() => void decidePairing(request.requestId, true)}>
                      批准此客户端与能力
                    </button>
                    <button type="button" disabled={busy} onClick={() => void decidePairing(request.requestId, false)}>
                      拒绝
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        <div className="settings-list">
          <h3>已授权</h3>
          {clients.length === 0 && <p>暂无已授权客户端。</p>}
          {clients.map((client) => {
            const clientEvent = spiritEvents[client.client.id]
            const eventStatus =
              clientEvent?.payload.status === 'ready'
                ? client.client.id === 'com.qiling.vscode'
                  ? '可解释选区'
                  : '可用'
                : clientEvent?.payload.status === 'unavailable'
                  ? '当前不可用'
                  : ''
            return (
              <article className="settings-card" key={client.clientKey}>
                <strong>{client.client.name}</strong>
                <span>{client.client.id} · {client.client.version}</span>
                <span>已授权：{capabilitySummary(client.capabilities)}</span>
                <span>
                  连接状态：{client.connected ? '已连接' : '未连接'}
                  {eventStatus && ` · ${eventStatus}`}
                </span>
                {client.capabilities.actions.map((action) => {
                  const examples = voiceExamples(action)
                  const blockedByStatus =
                    (action.id === 'vscode.explain_selection' &&
                      clientEvent?.payload.status !== 'ready') ||
                    (action.id === 'siju.narrate_current' &&
                      clientEvent?.payload.status === 'unavailable')
                  return (
                    <div className="settings-action" key={action.id}>
                      {actionCanRunFromSettings(action) ? (
                        <button
                          type="button"
                          disabled={busy || !client.connected || blockedByStatus}
                          onClick={() =>
                            void runClientAction(
                              client.client.id,
                              client.client.name,
                              action,
                            )
                          }
                        >
                          {actionButtonLabel(action, client.client.name)}
                        </button>
                      ) : (
                        <span>
                          {actionButtonLabel(action, client.client.name)}：需要确认流程，暂不支持手动或语音触发。
                        </span>
                      )}
                      {examples.length > 0 && (
                        <span>
                          语音口令：{examples.map((example) => `“${example}”`).join('、')}
                        </span>
                      )}
                    </div>
                  )
                })}
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
