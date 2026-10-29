import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { saveQiLingSettings } from '../lib/settings'
import SettingsApp from './SettingsApp'

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
    saveQiLingSettings({ voice: false, bubble: true })
    const page = renderToStaticMarkup(<SettingsApp />)
    expect(beforeLabel(page, '语音')).not.toContain('checked')
    expect(beforeLabel(page, '气泡')).toContain('checked')
  })
})
