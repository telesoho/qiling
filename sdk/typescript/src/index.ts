export type SpiritMood = 'neutral' | 'up' | 'down'
export type AnalysisStatus = 'ready' | 'unavailable'
export type ActionRisk = 'no_state_change' | 'state_change' | 'sensitive'

export interface ClientIdentity {
  id: string
  name: string
  version: string
}

export interface NarrationResult {
  text: string
  mood: SpiritMood
}

export interface VoiceCommandDeclaration {
  examples: string[]
  locale?: string
}

export interface ActionDeclaration {
  id: string
  risk: ActionRisk
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  supportsCancellation?: boolean
  /** Client-provided matching hints. They never grant the Action. */
  voice?: VoiceCommandDeclaration
}

export interface CapabilitiesDeclaration {
  actions: ActionDeclaration[]
  events: { publishes: string[]; subscribes?: string[] }
}

export type ActionHandler = (
  signal: AbortSignal,
  args: Record<string, never>,
) => Promise<NarrationResult>

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
  /**
   * Declare a generic client. When omitted, the legacy Siju / VS Code profile
   * is inferred from `identity.id` and the legacy handler options are used.
   */
  capabilities?: CapabilitiesDeclaration
  /** One handler per declared Action, keyed by Action ID. */
  handlers?: Record<string, ActionHandler>
  /** Legacy Siju profile handler. */
  onNarrateCurrent?: (signal: AbortSignal) => Promise<NarrationResult>
  /** Legacy VS Code profile handler. */
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
type LegacyHandlerName = 'onNarrateCurrent' | 'onExplainSelection'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ClientProfile {
  actionId: 'siju.narrate_current' | 'vscode.explain_selection'
  eventType: 'siju.analysis.status' | 'vscode.editor.status'
  risk: 'no_state_change' | 'sensitive'
  handler: LegacyHandlerName
}

interface ResolvedAction {
  id: string
  risk: ActionRisk
  description?: string
  inputSchema: JsonObject
  outputSchema: JsonObject
  supportsCancellation: boolean
  voice?: VoiceCommandDeclaration
}

interface ResolvedCapabilities {
  actions: ResolvedAction[]
  events: { publishes: string[]; subscribes: string[] }
}

interface Resolution {
  capabilities: ResolvedCapabilities
  handlers: Map<string, ActionHandler>
}

const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

function profileFor(clientId: string): ClientProfile | null {
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
  return null
}

function defaultInputSchema(): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {},
  }
}

function defaultOutputSchema(): JsonObject {
  return {
    type: 'object',
    required: ['text', 'mood'],
    properties: {
      text: { type: 'string', maxLength: 400 },
      mood: { type: 'string', enum: ['neutral', 'up', 'down'] },
    },
    additionalProperties: false,
  }
}

function legacyCapabilities(profile: ClientProfile): ResolvedCapabilities {
  return {
    actions: [
      {
        id: profile.actionId,
        risk: profile.risk,
        inputSchema: defaultInputSchema(),
        outputSchema: defaultOutputSchema(),
        supportsCancellation: false,
      },
    ],
    events: {
      publishes: [profile.eventType],
      subscribes: [],
    },
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateActionDeclaration(action: ActionDeclaration): ResolvedAction {
  if (!isPlainObject(action)) throw new SpiritError('invalid_capabilities')
  if (typeof action.id !== 'string' || !ACTION_ID_PATTERN.test(action.id)) {
    throw new SpiritError('invalid_capabilities')
  }
  if (
    action.risk !== 'no_state_change' &&
    action.risk !== 'state_change' &&
    action.risk !== 'sensitive'
  ) {
    throw new SpiritError('invalid_capabilities')
  }
  if (action.description !== undefined) {
    const description = action.description.trim()
    if (!description || Array.from(description).length > 120) {
      throw new SpiritError('invalid_capabilities')
    }
  }
  const inputSchema = action.inputSchema ?? defaultInputSchema()
  const outputSchema = action.outputSchema ?? defaultOutputSchema()
  if (!isPlainObject(inputSchema) || !isPlainObject(outputSchema)) {
    throw new SpiritError('invalid_capabilities')
  }
  const supportsCancellation = action.supportsCancellation ?? false
  if (typeof supportsCancellation !== 'boolean') {
    throw new SpiritError('invalid_capabilities')
  }
  const voice = action.voice
  if (voice !== undefined) {
    if (action.risk !== 'no_state_change' || supportsCancellation) {
      throw new SpiritError('invalid_capabilities')
    }
    if (
      !Array.isArray(voice.examples) ||
      voice.examples.length < 1 ||
      voice.examples.length > 12
    ) {
      throw new SpiritError('invalid_capabilities')
    }
    const seen = new Set<string>()
    for (const example of voice.examples) {
      if (typeof example !== 'string') throw new SpiritError('invalid_capabilities')
      const trimmed = example.trim()
      const length = Array.from(trimmed).length
      if (length < 2 || length > 40 || seen.has(trimmed)) {
        throw new SpiritError('invalid_capabilities')
      }
      seen.add(trimmed)
    }
    if (voice.locale !== undefined && !LOCALE_PATTERN.test(voice.locale)) {
      throw new SpiritError('invalid_capabilities')
    }
  }
  return {
    id: action.id,
    risk: action.risk,
    ...(action.description === undefined ? {} : { description: action.description.trim() }),
    inputSchema,
    outputSchema,
    supportsCancellation,
    ...(voice === undefined ? {} : { voice }),
  }
}

function validateEventTypes(eventTypes: unknown): string[] {
  if (!Array.isArray(eventTypes) || eventTypes.length > 16) {
    throw new SpiritError('invalid_capabilities')
  }
  const seen = new Set<string>()
  return eventTypes.map((eventType) => {
    if (typeof eventType !== 'string' || !ACTION_ID_PATTERN.test(eventType) || seen.has(eventType)) {
      throw new SpiritError('invalid_capabilities')
    }
    seen.add(eventType)
    return eventType
  })
}

function normalizeDeclaration(declaration: CapabilitiesDeclaration): ResolvedCapabilities {
  if (!isPlainObject(declaration) || !Array.isArray(declaration.actions)) {
    throw new SpiritError('invalid_capabilities')
  }
  if (declaration.actions.length > 16) throw new SpiritError('invalid_capabilities')
  const actions = declaration.actions.map(validateActionDeclaration)
  const ids = new Set<string>()
  for (const action of actions) {
    if (ids.has(action.id)) throw new SpiritError('invalid_capabilities')
    ids.add(action.id)
  }
  if (!isPlainObject(declaration.events)) throw new SpiritError('invalid_capabilities')
  const publishes = validateEventTypes(declaration.events.publishes)
  const subscribes = validateEventTypes(declaration.events.subscribes ?? [])
  return { actions, events: { publishes, subscribes } }
}

function resolveOptions(options: SpiritClientOptions): Resolution {
  if (options.capabilities) {
    const capabilities = normalizeDeclaration(options.capabilities)
    const handlers = new Map<string, ActionHandler>()
    for (const action of capabilities.actions) {
      const handler = options.handlers?.[action.id]
      if (typeof handler !== 'function') throw new SpiritError('invalid_client_handler')
      handlers.set(action.id, handler)
    }
    for (const declared of Object.keys(options.handlers ?? {})) {
      if (!capabilities.actions.some((action) => action.id === declared)) {
        throw new SpiritError('invalid_client_handler')
      }
    }
    return { capabilities, handlers }
  }

  const profile = profileFor(options.identity.id)
  if (!profile) throw new SpiritError('unsupported_client')
  const handler = options[profile.handler]
  if (typeof handler !== 'function') throw new SpiritError('invalid_client_handler')
  const legacyCapabilities_ = legacyCapabilities(profile)
  return {
    capabilities: legacyCapabilities_,
    handlers: new Map([
      [profile.actionId, (signal) => handler(signal)],
    ]),
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
    (mood !== 'neutral' && mood !== 'up' && mood !== 'down')
  ) {
    throw new SpiritError('invalid_action_result')
  }
  return { text: value.text, mood }
}

export class SpiritClient {
  private readonly endpoint: string
  private readonly capabilities: ResolvedCapabilities
  private readonly handlers: Map<string, ActionHandler>
  private readonly socketFactory: (url: string) => WebSocketLike
  private socket: WebSocketLike | null = null
  private state: ConnectionState = 'disconnected'
  private sequence = 0
  private readonly pending = new Map<string, PendingRequest>()
  private connectionPromise: Promise<void> | null = null
  private actionController: AbortController | null = null

  constructor(private readonly options: SpiritClientOptions) {
    const resolution = resolveOptions(options)
    this.capabilities = resolution.capabilities
    this.handlers = resolution.handlers
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
          requestedCapabilities: this.capabilities,
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

  async publishEvent(eventType: string, payload: JsonObject): Promise<void> {
    if (!this.capabilities.events.publishes.includes(eventType)) {
      throw new SpiritError('unsupported_event')
    }
    if (!isObject(payload)) throw new SpiritError('invalid_event_payload')
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
        payload,
      },
    })
  }

  async publishAnalysisStatus(status: AnalysisStatus): Promise<void> {
    if (!this.capabilities.events.publishes.includes('siju.analysis.status')) {
      throw new SpiritError('unsupported_event')
    }
    if (status !== 'ready' && status !== 'unavailable') {
      throw new SpiritError('invalid_analysis_status')
    }
    return this.publishEvent('siju.analysis.status', { status })
  }

  async publishEditorStatus(status: AnalysisStatus): Promise<void> {
    if (!this.capabilities.events.publishes.includes('vscode.editor.status')) {
      throw new SpiritError('unsupported_event')
    }
    if (status !== 'ready' && status !== 'unavailable') {
      throw new SpiritError('invalid_analysis_status')
    }
    return this.publishEvent('vscode.editor.status', { status })
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
        capabilities: this.capabilities,
      })
      if (!isObject(initialized) || initialized.protocolVersion !== '1') {
        throw new SpiritError('version_unsupported')
      }
      const granted = initialized.grantedCapabilities
      const required = [
        ...this.capabilities.actions.map((action) => action.id),
        ...this.capabilities.events.publishes.map((event) => `event.publish:${event}`),
      ]
      if (!Array.isArray(granted) || !required.every((item) => granted.includes(item))) {
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
    if (!isObject(params)) {
      response = this.errorResponse(id, 'action_not_found')
    } else {
      const action = this.capabilities.actions.find(
        (declared) => declared.id === params.action,
      )
      if (!action) {
        response = this.errorResponse(id, 'action_not_found')
      } else if (!isObject(params.arguments) || Object.keys(params.arguments).length !== 0) {
        response = this.errorResponse(id, 'invalid_params')
      } else {
        const handler = this.handlers.get(action.id)
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
              handler(controller.signal, {}).then(validateNarration),
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
