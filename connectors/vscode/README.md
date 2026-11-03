# VS Code Spirit Connector

The connector is an experimental second-client implementation for the constrained `com.qiling.vscode` profile. It uses `@qiling/spirit-client`, stores the access token in VS Code `SecretStorage`, and publishes only whether the active editor currently has a usable selection.

## Development

Requirements: VS Code 1.100+, Node.js 22+, and a locally running Qiling desktop app.

From the Qiling repository root:

```powershell
npm install --prefix connectors/vscode
npm run vscode:package
code --install-extension connectors/vscode/qiling-spirit-vscode-0.1.1.vsix --force
```

Reload the VS Code window after installation. The package check verifies the extension includes its runtime dependencies.

To run the extension from source in an Extension Development Host:

```powershell
npm run vscode:build
code --extensionDevelopmentPath="$PWD/connectors/vscode"
```

In the Extension Development Host, run **器灵：配对** from the Command Palette, enter the one-time pairing code from Qiling settings, then review and approve `com.qiling.vscode` and its `sensitive` read-selection capability in Qiling.

## Selection handling

Approving the connector in Qiling authorizes its read-selection capability. Each click on **解释当前选区** explicitly triggers one explanation; no extra Qiling confirmation dialog is shown. On first use, the user chooses an available VS Code language model; that choice is remembered in VS Code and reused. Run **器灵：选择解释模型** from the Command Palette to change it. The extension reads only the active editor's current selection, limited to 8,000 Unicode code points, and sends that selection to the chosen model provider. It does not read the full file, send a path, write files, execute commands, or log selection contents. Model availability and provider-specific data handling are controlled by VS Code and that provider; the user must choose a model they permit to process the selected text. The Qiling authorization can be revoked at any time.

The explanation is limited to 400 Unicode code points and returned through the authenticated Spirit Protocol connection. No active editor, empty/oversized selection, no available model, cancellation, timeout, and disconnect are explicit failure paths.

## Validation

Run the focused checks from the Qiling repository root:

```powershell
npm run sdk:build
npx vitest run sdk/typescript/src/index.test.ts connectors/vscode/connector-core.test.ts
cargo test --manifest-path src-tauri/Cargo.toml vscode_client_pairs_initializes_and_publishes_editor_status_over_wire
```

The loopback protocol test verifies pairing, initialization, status publication, and the Action request/response path. A desktop acceptance pass is still required for VS Code Extension Host activation, Qiling approval, and model-provider interaction.
