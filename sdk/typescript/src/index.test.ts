import { describe, expect, it } from 'vitest'
import {
  SpiritClient,
  SpiritError,
  type CredentialStore,
  type WebSocketLike,
} from './index.js'

class MockSocket implements WebSocketLike {
  readyState = 0
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>()

  constructor(
    private readonly onSend: (message: Record<string, unknown>) => void,
    autoOpen = true,
  ) {
    if (autoOpen) {
      queueMicrotask(() => {
        this.readyState = 1
        this.emit('open')
      })
    }
  }

  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, unknown>
    this.sent.push(message)
    this.onSend(message)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  reply(id: string | number, result: unknown): void {
    this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
  }

  notify(message: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(message) })
  }

  private emit(type: string, event: { data: unknown } = { data: undefined }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class MemoryCredentials implements CredentialStore {
  token: string | null = null

  async get(): Promise<string | null> {
    return this.token
  }

  async set(token: string): Promise<void> {
    this.token = token
  }

  async clear(): Promise<void> {
    this.token = null
  }
}

function replyTo(socket: MockSocket, message: Record<string, unknown>, result: unknown): void {
  if (typeof message.id !== 'string' && typeof message.id !== 'number') {
    throw new Error('Request is missing a JSON-RPC id.')
  }
  socket.reply(message.id, result)
}

describe('SpiritClient', () => {
  it('declares the VS Code capability profile for a second client identity', async () => {
    const sockets: MockSocket[] = []
    const client = new SpiritClient({
      identity: {
        id: 'com.qiling.vscode',
        name: 'Visual Studio Code',
        version: '0.1.0',
      },
      credentials: new MemoryCredentials(),
      onExplainSelection: async () => ({ text: 'const answer = 42;', mood: 'neutral' }),
      createWebSocket: () => {
        const socket = new MockSocket((message) => {
          if (message.method === 'client.pair') {
            replyTo(socket, message, {
              clientId: 'com.qiling.vscode',
              accessToken: 'vscode-token-with-enough-length-123456',
            })
          }
        })
        sockets.push(socket)
        return socket
      },
    })

    await client.pair('ABCDEFGH')

    expect(sockets[0].sent[0]).toMatchObject({
      method: 'client.pair',
      params: {
        client: { id: 'com.qiling.vscode' },
        requestedCapabilities: {
          actions: [{ id: 'vscode.explain_selection', risk: 'sensitive' }],
          events: { publishes: ['vscode.editor.status'] },
        },
      },
    })
  })

  it('connects a VS Code client, publishes editor status, and returns bounded selection text', async () => {
    const credentials = new MemoryCredentials()
    const sockets: MockSocket[] = []
    const client = new SpiritClient({
      identity: {
        id: 'com.qiling.vscode',
        name: 'Visual Studio Code',
        version: '0.1.0',
      },
      credentials,
      onExplainSelection: async () => ({ text: 'const answer = 42;', mood: 'neutral' }),
      createWebSocket: () => {
        const socket = new MockSocket((message) => {
          if (message.method === 'client.pair') {
            replyTo(socket, message, {
              clientId: 'com.qiling.vscode',
              accessToken: 'vscode-token-with-enough-length-123456',
            })
          } else if (message.method === 'client.authenticate') {
            replyTo(socket, message, {
              authenticated: true,
              clientId: 'com.qiling.vscode',
            })
          } else if (message.method === 'client.initialize') {
            replyTo(socket, message, {
              protocolVersion: '1',
              grantedCapabilities: [
                'vscode.explain_selection',
                'event.publish:vscode.editor.status',
              ],
            })
          }
        })
        sockets.push(socket)
        return socket
      },
    })

    await client.pair('ABCDEFGH')
    await client.connect()
    expect(client.connectionState).toBe('connected')
    await client.publishEditorStatus('ready')
    expect(sockets[1].sent.at(-1)).toMatchObject({
      method: 'event.publish',
      params: {
        eventType: 'vscode.editor.status',
        payload: { status: 'ready' },
      },
    })

    sockets[1].notify({
      jsonrpc: '2.0',
      id: 'selection-1',
      method: 'action.invoke',
      params: { action: 'vscode.explain_selection', arguments: {}, timeoutMs: 1_000 },
    })
    await viWaitFor(() =>
      expect(sockets[1].sent.at(-1)).toMatchObject({
        id: 'selection-1',
        result: { text: 'const answer = 42;', mood: 'neutral' },
      }),
    )
  })

  it('aborts a running Action handler when its connection is closed', async () => {
    const credentials = new MemoryCredentials()
    credentials.token = 'vscode-token-with-enough-length-123456'
    const sockets: MockSocket[] = []
    let actionSignal: AbortSignal | undefined
    const client = new SpiritClient({
      identity: {
        id: 'com.qiling.vscode',
        name: 'Visual Studio Code',
        version: '0.1.0',
      },
      credentials,
      onExplainSelection: (signal) => {
        actionSignal = signal
        return new Promise(() => {})
      },
      createWebSocket: () => {
        const socket = new MockSocket((message) => {
          if (message.method === 'client.authenticate') {
            replyTo(socket, message, { authenticated: true, clientId: 'com.qiling.vscode' })
          } else if (message.method === 'client.initialize') {
            replyTo(socket, message, {
              protocolVersion: '1',
              grantedCapabilities: [
                'vscode.explain_selection',
                'event.publish:vscode.editor.status',
              ],
            })
          }
        })
        sockets.push(socket)
        return socket
      },
    })

    await client.connect()
    sockets[0].notify({
      jsonrpc: '2.0',
      id: 'selection-2',
      method: 'action.invoke',
      params: { action: 'vscode.explain_selection', arguments: {}, timeoutMs: 60_000 },
    })
    await viWaitFor(() => expect(actionSignal).toBeDefined())

    sockets[0].close()

    expect(actionSignal?.aborted).toBe(true)
  })

  it('pairs, authenticates, publishes status, handles the approved Action, and unpairs', async () => {
    const credentials = new MemoryCredentials()
    const sockets: MockSocket[] = []
    const token = 'example-token-with-enough-length-1234567890'
    const client = new SpiritClient({
      identity: { id: 'com.siju.app', name: 'Siju SDK sample', version: '0.1.0' },
      credentials,
      onNarrateCurrent: async () => ({ text: 'Sample client completed the Action.', mood: 'neutral' }),
      createWebSocket: () => {
        const socket = new MockSocket((message) => {
          if (message.method === 'client.pair') {
            replyTo(socket, message, { clientId: 'com.siju.app', accessToken: token })
          } else if (message.method === 'client.authenticate') {
            replyTo(socket, message, { authenticated: true, clientId: 'com.siju.app' })
          } else if (message.method === 'client.initialize') {
            replyTo(socket, message, {
              protocolVersion: '1',
              grantedCapabilities: [
                'siju.narrate_current',
                'event.publish:siju.analysis.status',
              ],
            })
          } else if (message.method === 'client.unpair') {
            replyTo(socket, message, { unpaired: true })
          }
        })
        sockets.push(socket)
        return socket
      },
    })

    await client.pair('ABCDEFGH')
    expect(credentials.token).toBe(token)
    expect(sockets[0].sent[0].method).toBe('client.pair')

    await client.connect()
    expect(client.connectionState).toBe('connected')
    expect(sockets[1].sent.map((message) => message.method)).toEqual([
      'client.authenticate',
      'client.initialize',
    ])

    await client.publishAnalysisStatus('ready')
    expect(sockets[1].sent.at(-1)).toMatchObject({
      method: 'event.publish',
      params: {
        eventType: 'siju.analysis.status',
        payload: { status: 'ready' },
      },
    })

    sockets[1].notify({
      jsonrpc: '2.0',
      id: 'narrate-1',
      method: 'action.invoke',
      params: { action: 'siju.narrate_current', arguments: {}, timeoutMs: 1_000 },
    })
    await viWaitFor(() =>
      expect(sockets[1].sent.at(-1)).toMatchObject({
        id: 'narrate-1',
        result: { text: 'Sample client completed the Action.', mood: 'neutral' },
      }),
    )

    await client.unpair()
    expect(credentials.token).toBeNull()
    expect(client.connectionState).toBe('disconnected')
  })

  it('reports server authorization errors and does not claim a connection', async () => {
    const credentials = new MemoryCredentials()
    credentials.token = 'example-token-with-enough-length-1234567890'
    const client = new SpiritClient({
      identity: { id: 'com.siju.app', name: 'Siju SDK sample', version: '0.1.0' },
      credentials,
      onNarrateCurrent: async () => ({ text: 'unused', mood: 'neutral' }),
      createWebSocket: () => {
        const socket = new MockSocket((message) => {
          if (message.method === 'client.authenticate') {
            socket.notify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: 'not_authorized', data: { code: 'not_authorized' } },
            })
          }
        })
        sockets.push(socket)
        return socket
      },
    })
    const sockets: MockSocket[] = []

    await expect(client.connect()).rejects.toMatchObject({ code: 'not_authorized' })
    expect(client.connectionState).toBe('disconnected')
  })

  it('rejects a pending handshake when the socket closes', async () => {
    const credentials = new MemoryCredentials()
    credentials.token = 'example-token-with-enough-length-1234567890'
    let socket: MockSocket | undefined
    const client = new SpiritClient({
      identity: { id: 'com.siju.app', name: 'Siju SDK sample', version: '0.1.0' },
      credentials,
      onNarrateCurrent: async () => ({ text: 'unused', mood: 'neutral' }),
      createWebSocket: () => {
        const created = new MockSocket((message) => {
          if (message.method === 'client.authenticate') {
            if (socket) {
              replyTo(socket, message, { authenticated: true, clientId: 'com.siju.app' })
            }
          }
        })
        socket = created
        return created
      },
    })

    const connecting = client.connect()
    await viWaitFor(() =>
      expect(socket?.sent.some((message) => message.method === 'client.initialize')).toBe(true),
    )
    socket?.close()

    await expect(connecting).rejects.toMatchObject({ code: 'client_unavailable' })
    expect(client.connectionState).toBe('disconnected')
  })

  it('times out pairing and rejects non-loopback endpoints', async () => {
    const client = new SpiritClient({
      identity: { id: 'com.siju.app', name: 'Siju SDK sample', version: '0.1.0' },
      credentials: new MemoryCredentials(),
      onNarrateCurrent: async () => ({ text: 'unused', mood: 'neutral' }),
      pairingTimeoutMs: 5,
      createWebSocket: () => new MockSocket(() => {}),
    })
    await expect(client.pair('ABCDEFGH')).rejects.toMatchObject({ code: 'deadline_exceeded' })

    expect(
      () =>
        new SpiritClient({
          identity: { id: 'com.siju.app', name: 'Siju SDK sample', version: '0.1.0' },
          credentials: new MemoryCredentials(),
          onNarrateCurrent: async () => ({ text: 'unused', mood: 'neutral' }),
          endpoint: 'ws://192.168.1.2:8766/v1/connect',
        }),
    ).toThrowError('invalid_endpoint')
  })

  it('times out when the WebSocket never opens', async () => {
    const credentials = new MemoryCredentials()
    credentials.token = 'example-token-with-enough-length-1234567890'
    const client = new SpiritClient({
      identity: { id: 'com.siju.app', name: 'Siju SDK sample', version: '0.1.0' },
      credentials,
      connectTimeoutMs: 5,
      onNarrateCurrent: async () => ({ text: 'unused', mood: 'neutral' }),
      createWebSocket: () => new MockSocket(() => {}, false),
    })

    await expect(client.connect()).rejects.toMatchObject({ code: 'deadline_exceeded' })
    expect(client.connectionState).toBe('disconnected')
  })
})

async function viWaitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 100
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  assertion()
}
