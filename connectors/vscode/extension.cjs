const vscode = require('vscode')
const WebSocket = require('ws')
const {
  MAX_SELECTION_CODE_POINTS,
  chooseChatModel,
  readSelection,
  validateExplanation,
} = require('./connector-core.cjs')

const CLIENT_ID = 'com.qiling.vscode'
const CLIENT_NAME = 'Visual Studio Code'
const SECRET_KEY = 'spirit-access-token'
const MODEL_SELECTION_KEY = 'explanation-model-id'
let sdkPromise

function loadSdk() {
  sdkPromise ??= import('./lib/spirit-client/dist/index.js')
  return sdkPromise
}

let client
let statusBar
let output
let statusTimer

function credentialStore(context) {
  return {
    get: () => context.secrets.get(SECRET_KEY),
    set: (token) => context.secrets.store(SECRET_KEY, token),
    clear: () => context.secrets.delete(SECRET_KEY),
  }
}

function socketAdapter(url) {
  const socket = new WebSocket(url, { maxPayload: 64 * 1024 })
  return {
    get readyState() {
      return socket.readyState
    },
    addEventListener(type, listener) {
      if (type === 'message') {
        socket.on('message', (data) => listener({ data: data.toString() }))
      } else {
        socket.on(type, listener)
      }
    },
    send(data) {
      socket.send(data)
    },
    close() {
      socket.close()
    },
  }
}

function setStatus(text, tooltip = text) {
  if (!statusBar) return
  statusBar.text = `$(plug) 器灵：${text}`
  statusBar.tooltip = tooltip
  statusBar.show()
}

async function selectExplanationModel(context, token, forcePicker = false) {
  const models = await vscode.lm.selectChatModels()
  if (token.isCancellationRequested) {
    const error = new Error('cancelled')
    error.code = 'cancelled'
    throw error
  }
  if (models.length === 0) {
    const error = new Error('model_unavailable')
    error.code = 'model_unavailable'
    throw error
  }

  const rememberedId = context.globalState.get(MODEL_SELECTION_KEY)
  const model = await chooseChatModel({
    models,
    rememberedModelId: rememberedId,
    forcePicker,
    pickModel: async (availableModels) => {
      const selected = await vscode.window.showQuickPick(
        availableModels.map((candidate) => ({
          label: candidate.name,
          description: `${candidate.vendor} · ${candidate.family}`,
          model: candidate,
        })),
        {
          title: '选择用于解释选区的模型',
          placeHolder: '只发送当前选区，不会发送整个文件。此选择会被记住，可随时更换。',
        },
        token,
      )
      return selected?.model
    },
    saveModelId: (modelId) => context.globalState.update(MODEL_SELECTION_KEY, modelId),
  })
  if (!model || token.isCancellationRequested) {
    const error = new Error('cancelled')
    error.code = 'cancelled'
    throw error
  }
  return model
}

async function explainSelection(context, signal) {
  const request = new vscode.CancellationTokenSource()
  const abort = () => request.cancel()
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) request.cancel()
    if (request.token.isCancellationRequested) {
      const error = new Error('cancelled')
      error.code = 'cancelled'
      throw error
    }
    const text = readSelection(vscode.window.activeTextEditor)
    const model = await selectExplanationModel(context, request.token)
    const prompt = [
      'Explain the selected code or text concisely in Chinese.',
      'Do not claim to have inspected surrounding files or executed the code.',
      'Keep the explanation under 400 Unicode code points.',
      '',
      'Selected text:',
      '```',
      text,
      '```',
    ].join('\n')
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '正在解释 VS Code 选区',
        cancellable: true,
      },
      async (_progress, progressToken) => {
        const cancellation = progressToken.onCancellationRequested(() => request.cancel())
        try {
          const response = await model.sendRequest(
            [vscode.LanguageModelChatMessage.User(prompt)],
            {},
            request.token,
          )
          let explanation = ''
          for await (const part of response.text) {
            explanation += part
            if (Array.from(explanation).length > 400) {
              const error = new Error('response_too_large')
              error.code = 'response_too_large'
              throw error
            }
          }
          return { text: validateExplanation(explanation), mood: 'neutral' }
        } catch (error) {
          if (request.token.isCancellationRequested) {
            const cancelled = new Error('cancelled')
            cancelled.code = 'cancelled'
            throw cancelled
          }
          throw error
        } finally {
          cancellation.dispose()
        }
      },
    )
  } finally {
    signal.removeEventListener('abort', abort)
    request.dispose()
  }
}

function publishEditorStatus() {
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(publishEditorStatusNow, 1200)
}

function publishEditorStatusNow() {
  statusTimer = undefined
  if (!client || client.connectionState !== 'connected') return
  const editor = vscode.window.activeTextEditor
  const selection = editor && !editor.selection.isEmpty
    ? editor.document.getText(editor.selection)
    : ''
  const ready =
    selection.trim().length > 0 &&
    Array.from(selection).length <= MAX_SELECTION_CODE_POINTS
  void client.publishEditorStatus(ready ? 'ready' : 'unavailable').catch((error) => {
    output.appendLine(`Editor status publish failed: ${error.code ?? 'internal_error'}`)
  })
}

async function connect(context) {
  if (!client) {
    const { SpiritClient } = await loadSdk()
    client = new SpiritClient({
      identity: {
        id: CLIENT_ID,
        name: CLIENT_NAME,
        version: context.extension.packageJSON.version,
      },
      credentials: credentialStore(context),
      onExplainSelection: (signal) => explainSelection(context, signal),
      createWebSocket: socketAdapter,
    })
  }
  await client.connect()
  setStatus('已连接')
  publishEditorStatus()
}

async function activate(context) {
  output = vscode.window.createOutputChannel('器灵')
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  statusBar.command = 'qilingSpirit.connect'
  context.subscriptions.push(output, statusBar)

  context.subscriptions.push(
    vscode.commands.registerCommand('qilingSpirit.pair', async () => {
      const pairingCode = await vscode.window.showInputBox({
        prompt: '输入器灵设置中生成的一次性配对码',
        placeHolder: 'ABCDEFGH',
        validateInput: (value) => /^[A-Z2-7]{8}$/i.test(value) ? undefined : '请输入 8 位配对码。',
      })
      if (!pairingCode) return
      try {
        const { SpiritClient } = await loadSdk()
        client = new SpiritClient({
          identity: {
            id: CLIENT_ID,
            name: CLIENT_NAME,
            version: context.extension.packageJSON.version,
          },
          credentials: credentialStore(context),
          onExplainSelection: (signal) => explainSelection(context, signal),
          createWebSocket: socketAdapter,
        })
        await client.pair(pairingCode.toUpperCase())
        await connect(context)
        vscode.window.showInformationMessage('已向器灵请求配对，请在器灵设置中核对并批准 VS Code 的只读选区解释能力。')
      } catch (error) {
        const code = error.code ?? 'internal_error'
        setStatus('连接失败', code)
        vscode.window.showErrorMessage(`器灵配对失败：${code}`)
      }
    }),
    vscode.commands.registerCommand('qilingSpirit.connect', async () => {
      try {
        await connect(context)
      } catch (error) {
        const code = error.code ?? 'internal_error'
        setStatus('未连接', code)
        vscode.window.showErrorMessage(`器灵连接失败：${code}`)
      }
    }),
    vscode.commands.registerCommand('qilingSpirit.disconnect', () => {
      client?.disconnect()
      setStatus('已断开')
    }),
    vscode.commands.registerCommand('qilingSpirit.selectModel', async () => {
      const request = new vscode.CancellationTokenSource()
      try {
        const model = await selectExplanationModel(
          context,
          request.token,
          true,
        )
        vscode.window.showInformationMessage(`选区解释模型已设为：${model.name}`)
      } catch (error) {
        if (error.code !== 'cancelled') {
          vscode.window.showErrorMessage(`选择解释模型失败：${error.code ?? 'internal_error'}`)
        }
      } finally {
        request.dispose()
      }
    }),
    vscode.window.onDidChangeTextEditorSelection(publishEditorStatus),
    vscode.window.onDidChangeActiveTextEditor(publishEditorStatus),
  )

  try {
    if (await context.secrets.get(SECRET_KEY)) await connect(context)
    else setStatus('未配对')
  } catch (error) {
    const code = error.code ?? 'internal_error'
    setStatus('未连接', code)
    output.appendLine(`Auto-connect failed: ${code}`)
  }
}

function deactivate() {
  if (statusTimer) clearTimeout(statusTimer)
  client?.disconnect()
}

module.exports = { activate, deactivate }
