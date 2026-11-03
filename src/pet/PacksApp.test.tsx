import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PacksApp, { PackHero, PackList } from './PacksApp'
import type { PacksView } from './packs'

const view: PacksView = {
  activeId: 'shiju',
  storageDir: 'C:\\Users\\tester\\AppData\\Roaming\\com.qiling.pet\\pet-packs',
  characters: [
    {
      id: 'shiju',
      name: '诗琚',
      builtin: true,
      active: true,
      thumbnailUrl: '/pet/idle.webp',
    },
    {
      id: 'dafeiyu',
      name: '大肥鱼',
      builtin: false,
      active: false,
      version: '1.0.0',
      author: '测试作者',
      description: 'Q 版鲸尾女孩',
      trackCount: 6,
      pickupMode: 'animated',
      installedAt: 1_760_000_000,
    },
  ],
}

describe('角色资源包页面', () => {
  it('stays in the browser preview without calling native commands', () => {
    const page = renderToStaticMarkup(<PacksApp />)
    expect(page).toContain('角色资源包')
    expect(page).toContain('请在器灵应用内管理角色资源包')
  })

  it('renders the install controls in the native shell', () => {
    const scope = globalThis as unknown as { window?: unknown }
    scope.window = { __TAURI_INTERNALS__: {} }
    try {
      const page = renderToStaticMarkup(<PacksApp />)
      expect(page).toContain('安装资源包…')
      expect(page).toContain('怎样制作角色资源包？')
      expect(page).toContain('正在读取角色资源包…')
      expect(page).toContain('请只安装来源可信的资源包')
    } finally {
      delete scope.window
    }
  })

  it('renders the current character hero', () => {
    const builtin = renderToStaticMarkup(<PackHero character={view.characters[0]} />)
    expect(builtin).toContain('启用中')
    expect(builtin).toContain('内置')
    expect(builtin).toContain('红唐装圆扇棋灵')
    expect(builtin).toContain('不可卸载')

    const pack = renderToStaticMarkup(<PackHero character={view.characters[1]} />)
    expect(pack).toContain('大肥鱼')
    expect(pack).toContain('Q 版鲸尾女孩')
    expect(pack).toContain('回到内置诗琚')
  })

  it('lists the built-in character and installed packs', () => {
    const page = renderToStaticMarkup(
      <PackList view={view} busy="" onActivate={() => {}} onUninstall={() => {}} />,
    )
    expect(page).toContain('诗琚')
    expect(page).toContain('内置')
    expect(page).toContain('启用中')
    expect(page).toContain('已启用')
    expect(page).toContain('大肥鱼')
    expect(page).toContain('用户安装')
    expect(page).toContain('未启用')
    expect(page).toContain('测试作者')
    expect(page).toContain('6 条轨')
    expect(page).toContain('完整吊起')
    expect(page).toContain('启用')
    expect(page).toContain('卸载')
  })

  it('does not offer an uninstall button for the built-in character', () => {
    const page = renderToStaticMarkup(
      <PackList view={view} busy="" onActivate={() => {}} onUninstall={() => {}} />,
    )
    const builtinCard = page.slice(page.indexOf('诗琚'), page.indexOf('大肥鱼'))
    expect(builtinCard).not.toContain('卸载</button>')
  })
})
