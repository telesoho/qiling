import { SpiritClient } from '../dist/index.js'

const pairingCode = process.env.QILING_PAIRING_CODE
if (!pairingCode) {
  throw new Error('Set QILING_PAIRING_CODE to the one-time code shown in Qiling settings.')
}

const credentials = {
  token: null,
  async get() {
    return this.token
  },
  async set(token) {
    this.token = token
  },
  async clear() {
    this.token = null
  },
}

// A generic client: Qiling has no built-in knowledge of this identity, Action,
// or these phrases. The voice metadata only helps matching; approval still
// happens in Qiling's pairing dialog.
const client = new SpiritClient({
  identity: {
    id: 'com.example.voice-demo',
    name: '示例客户端',
    version: '0.1.0',
  },
  credentials,
  capabilities: {
    actions: [
      {
        id: 'demo.say_hello',
        risk: 'no_state_change',
        description: '打个招呼',
        voice: {
          locale: 'zh-CN',
          examples: ['打个招呼', '说声你好'],
        },
      },
    ],
    events: { publishes: [] },
  },
  handlers: {
    'demo.say_hello': async () => ({
      text: '你好呀，我是示例客户端。',
      mood: 'up',
    }),
  },
})

try {
  await client.pair(pairingCode.trim().toUpperCase())
  console.log('Pairing approved; connecting with the issued credential.')
  await client.connect()
  console.log('Connected. Wake Qiling and say “打个招呼” or “说声你好”.')
  console.log('Press Ctrl+C to stop; revoke this sample in Qiling when finished.')

  const stop = () => {
    client.disconnect()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  client.disconnect()
  console.error(`Voice sample failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
