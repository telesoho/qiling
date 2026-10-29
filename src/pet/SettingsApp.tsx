import { useEffect, useState } from 'react'
import { loadQiLingSettings, saveQiLingSettings, watchQiLingSettings, type PetSettings } from '../lib/settings'

export default function SettingsApp(): JSX.Element {
  const [settings, setSettings] = useState<PetSettings>(loadQiLingSettings)

  useEffect(() => watchQiLingSettings(setSettings), [])

  function patch(next: Partial<PetSettings>) {
    saveQiLingSettings({ ...loadQiLingSettings(), ...next })
  }

  return (
    <form className="pet-settings" aria-label="设定">
      <label>
        <input
          type="checkbox"
          checked={settings.voice}
          onChange={(event) => patch({ voice: event.target.checked })}
        />
        语音
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.bubble}
          onChange={(event) => patch({ bubble: event.target.checked })}
        />
        气泡
      </label>
    </form>
  )
}
