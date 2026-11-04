# Spirit Protocol TypeScript SDK

`@qiling/spirit-client` is the reference SDK for Spirit Protocol V1. It targets Node.js 22+ and uses the built-in WebSocket implementation; the package has no runtime dependencies. The credential store is supplied by the host application so access tokens can be kept in the operating system credential vault rather than a plaintext file.

The SDK supports two ways to declare clients:

- **Generic clients (recommended):** pass `capabilities` and `handlers`. Any well-formed client ID is accepted by the server and shown to the user for approval. Actions, events, and optional voice command examples are declared explicitly.
- **Legacy profiles:** Siju (`com.siju.app`) and the VS Code connector (`com.qiling.vscode`) can keep using `onNarrateCurrent` / `onExplainSelection`. They are preserved for compatibility and are not required for new clients.

## Build

From the Qiling repository root:

```powershell
npm run sdk:build
npm test -- sdk/typescript/src/index.test.ts
```

The package output is written to `sdk/typescript/dist/`.

## Generic client

```ts
import { SpiritClient } from '@qiling/spirit-client'

const client = new SpiritClient({
  identity: { id: 'com.example.voice-demo', name: '示例客户端', version: '0.1.0' },
  credentials: systemCredentialVault,
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
    'demo.say_hello': async (signal) => ({ text: '你好呀。', mood: 'up' }),
  },
})

await client.pair(pairingCode) // once; the user approves the client and its capabilities in Qiling
await client.connect()         // reads the saved token, authenticates, and initializes
```

The SDK fills in the canonical no-argument `inputSchema` and narrative `outputSchema` when an Action omits them. When `capabilities` is provided, every Action must have a handler under `handlers`, and every handler key must name a declared Action.

## Voice command metadata

`voice.examples` are client-provided phrases that Qiling uses **only for matching** a final speech transcript. They do not grant the Action, change its risk, or bypass pairing approval. Qiling enforces these limits:

- 1–12 examples per Action, each 2–40 characters;
- examples must be unique after normalizing whitespace and punctuation;
- local voice-runtime phrases (`停`, `取消`, …) and negated phrases are rejected;
- only `no_state_change` Actions with no arguments and `supportsCancellation: false` may declare voice metadata;
- voice metadata may be refreshed on reconnect without re-approval; changing the Action, its risk, schema, description, or events requires re-pairing.

Choose phrases that cover how users actually speak: 3–8 short variants are usually better than one long sentence. The phrase is matched after the wake word, so it should not include the wake word itself.

## Legacy profiles

```ts
const client = new SpiritClient({
  identity: { id: 'com.siju.app', name: '识局', version: '0.1.0' },
  credentials: systemCredentialVault,
  onNarrateCurrent: async () => {
    const result = await summarizeCurrentPosition()
    return { text: result.text, mood: result.mood }
  },
})

await client.pair(pairingCode)
await client.connect()
await client.publishAnalysisStatus('ready')
```

Call `publishAnalysisStatus('unavailable')` when the action cannot run. `unpair()` asks Qiling to revoke the server-side authorization before clearing the credential; `disconnect()` only closes the current connection and preserves it for a later reconnect. After a network loss, call `connect()` again; the SDK does not silently replay pending requests.

Legacy handlers must use the application's existing selected model and current state. They must not report fallback or stale output as a successful result. Action timeouts are returned as protocol errors; the SDK does not replay a request after disconnect or timeout.

Generic clients can publish any event declared in `events.publishes` with `publishEvent(eventType, payload)`. `publishAnalysisStatus` and `publishEditorStatus` remain available as legacy wrappers.

## Runnable reference clients

- `examples/console-client.mjs` — legacy Siju profile smoke test.
- `examples/voice-client.mjs` — generic client with a voice command; no Qiling code change is needed to discover it.

Run the voice example against the desktop app:

1. In Qiling settings, generate a one-time pairing code.
2. Build the package, then run in PowerShell:

   ```powershell
   npm run sdk:build
   $env:QILING_PAIRING_CODE = "ABCDEFGH"
   node sdk/typescript/examples/voice-client.mjs
   ```

3. Approve the sample in Qiling. Confirm it becomes connected and its “打个招呼” / “说声你好” phrases appear under the client's authorized Actions.
4. Wake Qiling and say “打个招呼”. The sample's reply should be shown and spoken.
5. Stop the sample; the same phrase should now report that the client is not connected.
6. Revoke the sample's authorization when finished.

The samples use an in-memory credential store only for this process. Production applications must provide a system credential-vault adapter.

## Supported scope and compatibility

This release implements pairing, authentication, initialization, generic per-Action dispatch, generic event publishing, the legacy Siju and VS Code profiles, unpairing, a 10-second default connection timeout, request timeouts, and connection loss handling. The VS Code profile reads a bounded active selection only after the user confirms the request in Qiling, then uses a language model selected in VS Code. The SDK does not implement parameterized Actions, cancellation propagation, arbitrary event subscriptions, or automatic replay. Unknown capabilities are not silently downgraded. The protocol's declared limits are a 64 KiB message and a default 60-second Action timeout.

The package follows semantic versioning. `0.x` is experimental: pin the version and review the changelog/contract tests when upgrading. Protocol version `"1"` is negotiated during `connect()`; an unsupported version or server authorization error rejects the connection.
