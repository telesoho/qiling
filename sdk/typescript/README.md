# Spirit Protocol TypeScript SDK

`@qiling/spirit-client` is the first reference SDK for Spirit Protocol V1. It targets Node.js 22+ and uses the built-in WebSocket implementation; the package has no runtime dependencies. The credential store is supplied by the host application so access tokens can be kept in the operating system credential vault rather than a plaintext file.

Two constrained client profiles are supported: Siju (`com.siju.app`) and the experimental VS Code connector (`com.qiling.vscode`). The SDK rejects unknown client identities rather than accepting arbitrary capabilities.

## Build

From the Qiling repository root:

```powershell
npm run sdk:build
npm test -- sdk/typescript/src/index.test.ts
```

The package output is written to `sdk/typescript/dist/`.

## Minimal client

```ts
import { SpiritClient } from '@qiling/spirit-client'

const client = new SpiritClient({
  identity: { id: 'com.siju.app', name: '识局', version: '0.1.0' },
  credentials: systemCredentialVault,
  onNarrateCurrent: async () => {
    const result = await summarizeCurrentPosition()
    return { text: result.text, mood: result.mood }
  },
})

await client.pair(pairingCode) // call once; user approves the client in Qiling
await client.connect()         // reads the saved token, authenticates and initializes
await client.publishAnalysisStatus('ready')
```

Call `publishAnalysisStatus('unavailable')` when the action cannot run. `unpair()` asks Qiling to revoke the server-side authorization before clearing the credential; `disconnect()` only closes the current connection and preserves it for a later reconnect. After a network loss, call `connect()` again; the SDK does not silently replay pending requests.

`onNarrateCurrent` must use the application's existing selected model and current state. It must not report fallback or stale output as a successful result. Action timeouts are returned as protocol errors; the SDK does not replay a request after disconnect or timeout.

## Runnable reference client

The console example is an intentionally small protocol smoke-test provider, not a chess engine. It publishes the readiness event and returns a fixed line for `siju.narrate_current`.

The console example uses the Siju identity and Qiling allows one authorization for `com.siju.app`. To run this sample against the desktop app:

1. If the real Siju client is paired, revoke its authorization in Qiling settings and close Siju.
2. In Qiling settings, generate a one-time pairing code.
3. Build the package, then run in PowerShell:

   ```powershell
   npm run sdk:build
   $env:QILING_PAIRING_CODE = "ABCDEFGH"
   node sdk/typescript/examples/console-client.mjs
   ```

4. Approve the SDK example in Qiling. Confirm it becomes connected and reports “可解说”.
5. Trigger “请识局重新解说当前局面”. Qiling should display/speak the sample result.
6. Stop the sample, revoke the sample's authorization in Qiling settings, then pair Siju again.

The sample uses an in-memory credential store only for this process. Production applications must provide a system credential-vault adapter.

## Supported profile and compatibility

This release implements pairing, authentication, initialization, the Siju and VS Code profile-specific status events and Actions, unpairing, a 10-second default connection timeout, request timeouts, and connection loss handling. The VS Code profile reads a bounded active selection only after the user confirms the request in Qiling, then uses a language model selected in VS Code. It does not implement cancellation, arbitrary event subscriptions, or generic Action dispatch. Unknown capabilities are not silently downgraded. The protocol's declared limits are a 64 KiB message and a default 60-second Action timeout.

The package follows semantic versioning. `0.x` is experimental: pin the version and review the changelog/contract tests when upgrading. Protocol version `"1"` is negotiated during `connect()`; an unsupported version or server authorization error rejects the connection.
