const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const extensionPath = process.argv[2]
const registeredCommands = new Set()
const disposable = { dispose() {} }
const output = { appendLine() {} }
const statusBar = { show() {} }
const vscode = {
  commands: {
    registerCommand(command) {
      registeredCommands.add(command)
      return disposable
    },
  },
  window: {
    createOutputChannel: () => output,
    createStatusBarItem: () => statusBar,
    onDidChangeTextEditorSelection: () => disposable,
    onDidChangeActiveTextEditor: () => disposable,
  },
  StatusBarAlignment: { Right: 1 },
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode
  return originalLoad.call(this, request, parent, isMain)
}

async function main() {
  const extension = require(path.join(extensionPath, 'extension.cjs'))
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined },
    extension: { packageJSON: { version: '0.1.1' } },
  }
  await extension.activate(context)

  for (const command of [
    'qilingSpirit.pair',
    'qilingSpirit.connect',
    'qilingSpirit.disconnect',
    'qilingSpirit.selectModel',
  ]) {
    assert(registeredCommands.has(command), `Missing registered command: ${command}`)
  }
  console.log('VS Code extension activated and registered its commands.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
