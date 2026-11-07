import React from 'react'
import ReactDOM from 'react-dom/client'
import BubbleApp from './pet/BubbleApp'
import MusicApp from './pet/MusicApp'
import PacksApp from './pet/PacksApp'
import PetApp from './pet/PetApp'
import SettingsApp from './pet/SettingsApp'
import './index.css'

type Shell = 'pet' | 'bubble' | 'settings' | 'packs' | 'music'

async function shell(): Promise<Shell> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const label = getCurrentWindow().label
    if (label === 'bubble') return 'bubble'
    if (label === 'settings') return 'settings'
    if (label === 'packs') return 'packs'
    if (label === 'music') return 'music'
  }
  if (window.location.hash === '#bubble') return 'bubble'
  if (window.location.hash === '#settings') return 'settings'
  if (window.location.hash === '#packs') return 'packs'
  if (window.location.hash === '#music') return 'music'
  return 'pet'
}

function view(kind: Shell): JSX.Element {
  if (kind === 'bubble') return <BubbleApp />
  if (kind === 'settings') return <SettingsApp />
  if (kind === 'packs') return <PacksApp />
  if (kind === 'music') return <MusicApp />
  return <PetApp />
}

async function boot() {
  const kind = await shell()
  if (kind === 'pet' || kind === 'bubble') document.documentElement.classList.add('pet-window')
  document.title =
    kind === 'settings'
      ? '设定'
      : kind === 'packs'
        ? '器灵 · 角色资源包'
        : kind === 'music'
          ? '器灵 · 曲库'
          : '器灵'
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>{view(kind)}</React.StrictMode>
  )
}

void boot()