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

const client = new SpiritClient({
  identity: {
    id: 'com.siju.app',
    name: '识局 Spirit SDK 示例',
    version: '0.1.0',
  },
  credentials,
  onNarrateCurrent: async () => ({
    text: 'Spirit SDK 示例客户端已成功执行重新解说 Action。',
    mood: 'neutral',
  }),
})

try {
  await client.pair(pairingCode.trim().toUpperCase())
  console.log('Pairing approved; connecting with the issued credential.')
  await client.connect()
  await client.publishAnalysisStatus('ready')
  console.log('Connected and published siju.analysis.status=ready.')
  console.log('Use Qiling settings to invoke the sample Action. Press Ctrl+C to stop.')

  const stop = () => {
    client.disconnect()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  client.disconnect()
  console.error(`Spirit SDK sample failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
