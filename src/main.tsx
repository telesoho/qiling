import React from 'react'
import ReactDOM from 'react-dom/client'
import BubbleApp from './pet/BubbleApp'
import PetApp from './pet/PetApp'
import SettingsApp from './pet/SettingsApp'
import './index.css'

type Shell = 'pet' | 'bubble' | 'settings'

async function shell(): Promise<Shell> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const label = getCurrentWindow().label
    if (label === 'bubble') return 'bubble'
    if (label === 'settings') return 'settings'
  }
  if (window.location.hash === '#bubble') return 'bubble'
  if (window.location.hash === '#settings') return 'settings'
  return 'pet'
}

function view(kind: Shell): JSX.Element {
  if (kind === 'bubble') return <BubbleApp />
  if (kind === 'settings') return <SettingsApp />
  return <PetApp />
}

async function boot() {
  const kind = await shell()
  if (kind !== 'settings') document.documentElement.classList.add('pet-window')
  document.title = kind === 'settings' ? '设定' : '器灵'
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>{view(kind)}</React.StrictMode>
  )
}

void boot()
