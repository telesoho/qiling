import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { saveQiLingSettings } from '../lib/settings'
import SettingsApp, {
  capabilitySummary,
  modelOptions,
  normalizeModelName,
} from './SettingsApp'

const memory = () => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size },
  }
}

function beforeLabel(html: string, label: string): string {
  const at = html.indexOf(label)
  return html.slice(Math.max(0, at - 120), at)
}

describe('器灵设定', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memory(), configurable: true })
  })

  it('leaves voice unchecked when voice is off', () => {
    saveQiLingSettings({ voice: false, bubble: true, voiceAssistant: false, wakeWord: '器灵', voiceEngine: 'auto' })
    const page = renderToStaticMarkup(<SettingsApp />)
    expect(beforeLabel(page, '语音')).not.toContain('checked')
    expect(beforeLabel(page, '气泡')).toContain('checked')
  })

  it('keeps the wake-word microphone opt-in unchecked by default', () => {
    const page = renderToStaticMarkup(<SettingsApp />)
    expect(page).toMatch(/<label><input type="checkbox"(?: disabled="")?\/>唤醒词监听/)
    expect(page).toContain('id="voice-wake-word"')
    expect(page).toContain('id="voice-engine"')
    expect(page).toContain('自动：优先 CosyVoice，不可用时用系统语音')
    expect(page).toContain('value="器灵"')
    expect(page).toContain('2–8 个连续汉字')
    expect(page).toContain('最近识别到的语音：（等待识别）')
    expect(page).toContain('完整识别文本与唤醒词完全一致也会在本机触发')
    expect(page).toContain('5 分钟内可以直接追问')
    expect(page).toContain('连续 5 分钟没有新问题')
    expect(page).toContain('id="llm-provider"')
    expect(page).toContain('Ollama（本机）')
    expect(page).toContain('DeepSeek')
    expect(page).toContain('自定义 OpenAI 兼容服务')
    expect(page).toContain('连接测试会向当前模型发送一条简短测试提示')
    expect(page).not.toContain('id="llm-api-key"')
  })

  it('shows client pairing controls and the empty state', () => {
    const page = renderToStaticMarkup(<SettingsApp />)
    expect(page).toContain('已连接客户端')
    expect(page).toContain('生成一次性配对码')
    expect(page).toContain('暂无已授权客户端')
    expect(page).toContain('批准 VS Code 的选区解释能力后，点击按钮即可解释当前选区')
    expect(page).not.toContain('每次请求前征求确认')
  })

  it('explains the scope of the VS Code capability before it is approved', () => {
    expect(
      capabilitySummary({
        actions: [{ id: 'vscode.explain_selection', risk: 'sensitive' }],
        events: { publishes: ['vscode.editor.status'], subscribes: [] },
      }),
    ).toBe('VS Code：解释当前选区（读取所选文本）；发布事件：VS Code 编辑器状态')
  })

  it('offers an installed-model choice and a voice preview', () => {
    const page = renderToStaticMarkup(<SettingsApp />)
    expect(page).toContain('id="llm-model"')
    expect(page).toContain('刷新已安装模型')
    expect(page).toContain('读取本机 Ollama 的已安装模型')
    expect(page).toContain('>试听</button>')
    expect(page).toContain('把与自己播报文稿高度重合的结果当作回声丢弃')
  })

  it('keeps the saved model selectable even before Ollama reports it', () => {
    expect(modelOptions(['qwen3.5:4b', 'qwen3:latest'], 'qwen3.5:4b')).toEqual([
      { value: 'qwen3.5:4b', label: 'qwen3.5:4b' },
      { value: 'qwen3:latest', label: 'qwen3:latest' },
    ])
    expect(modelOptions(['qwen3:latest'], 'qwen3')).toEqual([
      { value: 'qwen3', label: 'qwen3（未在已安装列表）' },
      { value: 'qwen3:latest', label: 'qwen3:latest' },
    ])
  })

  it('resolves the implicit latest tag to a real installed model name', () => {
    expect(normalizeModelName(['qwen3:latest'], 'qwen3')).toBe('qwen3:latest')
    expect(normalizeModelName(['qwen3:0.6b'], 'qwen3')).toBe('qwen3')
    expect(normalizeModelName(['qwen3.5:4b'], ' qwen3.5:4b ')).toBe('qwen3.5:4b')
  })
})
