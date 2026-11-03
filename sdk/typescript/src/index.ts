export type SpiritMood = 'neutral' | 'up' | 'down'
export type AnalysisStatus = 'ready' | 'unavailable'

export interface ClientIdentity {
  id: string
  name: string
  version: string
}

export interface NarrationResult {
  text: string
  mood: SpiritMood
}

export interface CredentialStore {
  get(): Promise<string | null>
  set(token: string): Promise<void>
  clear(): Promise<void>
}

export interface WebSocketLike {
  readonly readyState: number
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
  send(data: string): void
  close(): void
}

export interface SpiritClientOptions {
  identity: ClientIdentity
  credentials: CredentialStore
  onNarrateCurrent?: (signal: AbortSignal) => Promise<NarrationResult>
  onExplainSelection?: (signal: AbortSignal) => Promise<NarrationResult>
  endpoint?: string
  connectTimeoutMs?: number
  pairingTimeoutMs?: number
  createWebSocket?: (url: string) => WebSocketLike
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export class SpiritError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'SpiritError'
  }
}

type JsonRpcId = string | number
type JsonObject = Record<string, unknown>

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ClientProfile {
  actionId: 'siju.narrate_current' | 'vscode.explain_selection'
  eventType: 'siju.analysis.status' | 'vscode.editor.status'
  risk: 'no_state_change' | 'sensitive'
  handler: 'onNarrateCurrent' | 'onExplainSelection'
}

function profileFor(clientId: string): ClientProfile {
  if (clientId === 'com.siju.app') {
    return {
      actionId: 'siju.narrate_current',
      eventType: 'siju.analysis.status',
      risk: 'no_state_change',
      handler: 'onNarrateCurrent',
    }
  }
  if (clientId === 'com.qiling.vscode') {
    return {
      actionId: 'vscode.explain_selection',
      eventType: 'vscode.editor.status',
      risk: 'sensitive',
      handler: 'onExplainSelection',
    }
  }
  throw new SpiritError('unsupported_client')
}

function capabilitiesFor(profile: ClientProfile) {
  return {
    actions: [
      {
        id: profile.actionId,
        risk: profile.risk,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        outputSchema: {
          type: 'object',
          required: ['text', 'mood'],
          properties: {
            text: { type: 'string', maxLength: 400 },
            mood: { type: 'string', enum: ['neutral', 'up', 'down'] },
          },
          additionalProperties: false,
        },
        supportsCancellation: false,
      },
    ],
    events: {
      publishes: [profile.eventType],
      subscribes: [],
    },
  }
}

const OPEN = 1
const DEFAULT_ENDPOINT = 'ws://127.0.0.1:8766/v1/connect'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 64 * 1024

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rpcCode(error: unknown): string {
  if (!isObject(error)) return 'internal_error'
  const data = error.data
  if (isObject(data) && typeof data.code === 'string') return data.code
  return typeof error.message === 'string' ? error.message : 'internal_error'
}

function validateEndpoint(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new SpiritError('invalid_endpoint')
  }
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/v1/connect' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new SpiritError('invalid_endpoint')
  }
  return url.toString()
}

function validateNarration(value: unknown): NarrationResult {
  if (!isObject(value) || typeof value.text !== 'string' || typeof value.mood !== 'string') {
    throw new SpiritError('invalid_action_result')
  }
  const mood = value.mood
  if (
    value.text.trim().length === 0 ||
    Array.from(value.text).length > 400 ||
    mood !== 'neutral' &&
      mood !== 'up' &&
      mood !== 'down'
  ) {
    throw new SpiritError('invalid_action_result')
  }
  return { text: value.text, mood }
}

export class SpiritClient {
  private readonly endpoint: string
  private readonly profile: ClientProfile
  private readonly socketFactory: (url: string) => WebSocketLike
  private socket: WebSocketLike | null = null
  private state: ConnectionState = 'disconnected'
  private sequence = 0
  private readonly pending = new Map<string, PendingRequest>()
  private connectionPromise: Promise<void> | null = null
  private actionController: AbortController | null = null

  constructor(private readonly options: SpiritClientOptions) {
    this.profile = profileFor(options.identity.id)
    if (
      typeof options[this.profile.handler] !== 'function' ||
      typeof options[this.profile.handler === 'onNarrateCurrent'
        ? 'onExplainSelection'
        : 'onNarrateCurrent'] === 'function'
    ) {
      throw new SpiritError('invalid_client_handler')
    }
    this.endpoint = validateEndpoint(options.endpoint ?? DEFAULT_ENDPOINT)
    this.socketFactory =
      options.createWebSocket ??
      ((url) => {
        if (typeof WebSocket === 'undefined') throw new SpiritError('websocket_unavailable')
        return new WebSocket(url)
      })
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  async pair(pairingCode: string): Promise<void> {
    if (!/^[A-Z2-7]{8}$/.test(pairingCode)) throw new SpiritError('invalid_pairing_code')
    if (this.socket) throw new SpiritError('already_connected')

    const socket = await this.openSocket()
    this.socket = socket
    try {
      const result = await this.request(
        'client.pair',
        {
          pairingCode,
          client: this.options.identity,
          requestedCapabilities: capabilitiesFor(this.profile),
        },
        this.options.pairingTimeoutMs ?? 5 * 60_000,
      )
      if (!isObject(result) || typeof result.accessToken !== 'string' || result.accessToken.length < 32) {
        throw new SpiritError('invalid_pair_response')
      }
      await this.options.credentials.set(result.accessToken)
    } finally {
      this.closeSocket()
    }
  }

  async connect(): Promise<void> {
    if (this.state === 'connected') return
    if (this.connectionPromise) return this.connectionPromise
    this.state = 'connecting'
    this.connectionPromise = this.connectOnce().finally(() => {
      this.connectionPromise = null
      if (this.state !== 'connected') this.state = 'disconnected'
    })
    return this.connectionPromise
  }

  async publishAnalysisStatus(status: AnalysisStatus): Promise<void> {
    if (this.profile.eventType !== 'siju.analysis.status') {
      throw new SpiritError('unsupported_event')
    }
    return this.publishStatus(this.profile.eventType, status)
  }

  async publishEditorStatus(status: AnalysisStatus): Promise<void> {
    if (this.profile.eventType !== 'vscode.editor.status') {
      throw new SpiritError('unsupported_event')
    }
    return this.publishStatus(this.profile.eventType, status)
  }

  private async publishStatus(eventType: string, status: AnalysisStatus): Promise<void> {
    if (status !== 'ready' && status !== 'unavailable') {
      throw new SpiritError('invalid_analysis_status')
    }
    if (this.state !== 'connected' || !this.socket || this.socket.readyState !== OPEN) {
      throw new SpiritError('client_unavailable')
    }
    this.sendJson(this.socket, {
      jsonrpc: '2.0',
      method: 'event.publish',
      params: {
        eventId: this.newId(),
        eventType,
        occurredAt: new Date().toISOString(),
        payload: { status },
      },
    })
  }

  async unpair(): Promise<void> {
    if (this.state !== 'connected') throw new SpiritError('client_unavailable')
    const result = await this.request('client.unpair', {})
    if (!isObject(result) || result.unpaired !== true) {
      throw new SpiritError('invalid_unpair_response')
    }
    await this.options.credentials.clear()
    this.closeSocket()
  }

  disconnect(): void {
    this.closeSocket()
  }

  private async connectOnce(): Promise<void> {
    const token = await this.options.credentials.get()
    if (!token) throw new SpiritError('pairing_required')
    const socket = await this.openSocket()
    this.socket = socket
    try {
      const authenticated = await this.request('client.authenticate', { accessToken: token })
      if (
        !isObject(authenticated) ||
        authenticated.authenticated !== true ||
        authenticated.clientId !== this.options.identity.id
      ) {
        throw new SpiritError('not_authorized')
      }
      const initialized = await this.request('client.initialize', {
        protocolVersion: '1',
        client: this.options.identity,
        capabilities: capabilitiesFor(this.profile),
      })
      if (!isObject(initialized) || initialized.protocolVersion !== '1') {
        throw new SpiritError('version_unsupported')
      }
      if (
        !Array.isArray(initialized.grantedCapabilities) ||
        !initialized.grantedCapabilities.includes(this.profile.actionId) ||
        !initialized.grantedCapabilities.includes(`event.publish:${this.profile.eventType}`)
      ) {
        throw new SpiritError('not_authorized')
      }
      this.state = 'connected'
    } catch (error) {
      this.closeSocket()
      throw error
    }
  }

  private openSocket(): Promise<WebSocketLike> {
    return new Promise((resolve, reject) => {
      let socket: WebSocketLike
      try {
        socket = this.socketFactory(this.endpoint)
      } catch (error) {
        reject(error instanceof Error ? error : new SpiritError('client_unavailable'))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.close()
        reject(new SpiritError('deadline_exceeded'))
      }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(socket)
      })
      socket.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.close()
        reject(new SpiritError('client_unavailable'))
      })
      socket.addEventListener('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new SpiritError('client_unavailable'))
      })
      socket.addEventListener('message', (event) => this.receive(event.data, socket))
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return
        this.socket = null
        this.state = 'disconnected'
        this.actionController?.abort()
        this.actionController = null
        this.rejectPending(new SpiritError('client_unavailable'))
      })
    })
  }

  private request(method: string, params: JsonObject, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return Promise.reject(new SpiritError('client_unavailable'))
    const id = this.newId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SpiritError('deadline_exceeded'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.sendJson(socket, { jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new SpiritError('client_unavailable'))
      }
    })
  }

  private receive(data: unknown, socket: WebSocketLike): void {
    if (this.socket !== socket) return
    if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) {
      this.rejectPending(new SpiritError('invalid_response'))
      return
    }
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      this.rejectPending(new SpiritError('invalid_response'))
      return
    }
    if (!isObject(message)) return

    if (typeof message.id === 'string' || typeof message.id === 'number') {
      const key = String(message.id)
      const pending = this.pending.get(key)
      if (pending) {
        this.pending.delete(key)
        clearTimeout(pending.timer)
        const hasError = 'error' in message
        const hasResult = 'result' in message
        if (
          message.jsonrpc !== '2.0' ||
          Object.keys(message).length !== 3 ||
          (typeof message.id !== 'string' && typeof message.id !== 'number') ||
          hasError === hasResult
        ) {
          pending.reject(new SpiritError('invalid_response'))
        } else if (isObject(message.error)) {
          pending.reject(new SpiritError(rpcCode(message.error)))
        } else if (hasResult) {
          pending.resolve(message.result)
        } else {
          pending.reject(new SpiritError('invalid_response'))
        }
        return
      }
    }

    if (message.method === 'action.invoke') void this.handleAction(message, socket)
  }

  private async handleAction(message: JsonObject, socket: WebSocketLike): Promise<void> {
    const id = message.id
    if (typeof id !== 'string' && typeof id !== 'number') return
    const params = message.params
    let response: JsonObject
    if (
      !isObject(params) ||
      params.action !== this.profile.actionId
    ) {
      response = this.errorResponse(id, 'action_not_found')
    } else if (
      !isObject(params.arguments) ||
      Object.keys(params.arguments).length !== 0
    ) {
      response = this.errorResponse(id, 'invalid_params')
    } else {
      const handler = this.options[this.profile.handler]
      if (!handler) {
        response = this.errorResponse(id, 'action_not_found')
      } else {
        const timeoutMs =
          typeof params.timeoutMs === 'number' &&
          params.timeoutMs >= 1_000 &&
          params.timeoutMs <= 120_000
            ? params.timeoutMs
            : DEFAULT_TIMEOUT_MS
        const controller = new AbortController()
        this.actionController?.abort()
        this.actionController = controller
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        let timedOut = false
        let rejectOnAbort: (() => void) | undefined
        try {
          const narration = await Promise.race([
            handler(controller.signal).then(validateNarration),
            new Promise<never>((_, reject) => {
              rejectOnAbort = () =>
                reject(new SpiritError(timedOut ? 'deadline_exceeded' : 'client_unavailable'))
              controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
            }),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true
                controller.abort()
                reject(new SpiritError('deadline_exceeded'))
              }, timeoutMs)
            }),
          ])
          response = { jsonrpc: '2.0', id, result: narration }
        } catch (error) {
          const code = error instanceof SpiritError ? error.code : 'summarizer_unavailable'
          response = this.errorResponse(id, code)
        } finally {
          if (timeoutId) clearTimeout(timeoutId)
          if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
          if (this.actionController === controller) this.actionController = null
        }
      }
    }
    if (this.socket === socket && socket.readyState === OPEN) {
      try {
        this.sendJson(socket, response)
      } catch {
        this.closeSocket()
      }
    }
  }

  private sendJson(socket: WebSocketLike, message: JsonObject): void {
    const data = JSON.stringify(message)
    if (new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) {
      throw new SpiritError('message_too_large')
    }
    socket.send(data)
  }

  private errorResponse(id: JsonRpcId, code: string): JsonObject {
    const supportedCodes = [
      'state_unavailable',
      'state_stale',
      'summarizer_unavailable',
      'busy',
      'deadline_exceeded',
      'action_not_found',
      'invalid_params',
      'selection_unavailable',
      'selection_too_large',
      'model_unavailable',
      'response_too_large',
      'cancelled',
      'internal_error',
    ]
    const stableCode = supportedCodes.includes(code) ? code : 'internal_error'
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: stableCode,
        data: { code: stableCode },
      },
    }
  }

  private newId(): string {
    this.sequence += 1
    return `spirit-${this.sequence}`
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    this.state = 'disconnected'
    this.actionController?.abort()
    this.actionController = null
    this.rejectPending(new SpiritError('client_unavailable'))
    socket?.close()
  }
}
