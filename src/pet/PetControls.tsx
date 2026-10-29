function SpeakerIcon(props: { muted: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.2 10h3.1L11 6.6v10.8L7.3 14H4.2v-4z" />
      {props.muted ? (
        <path d="M15.2 9.8l4.3 4.4M19.5 9.8l-4.3 4.4" />
      ) : (
        <>
          <path d="M15.1 9.2a3.4 3.4 0 0 1 0 5.6" />
          <path d="M17.4 6.8a6.2 6.2 0 0 1 0 10.4" />
        </>
      )}
    </svg>
  )
}

function CollapseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 12h12" />
    </svg>
  )
}

/** Frosted speech bubble. One tail, icon chrome, spoken line only. */
export function PetSpeechBubble(props: {
  text: string
  voiceOn: boolean
  speaking: boolean
  onToggleVoice: () => void
  onCollapse: () => void
  /** Standalone window. No drag region; layout fills that window. */
  windowed?: boolean
}): JSX.Element {
  const voiceLabel = props.speaking && props.voiceOn ? '停止' : props.voiceOn ? '静音' : '开声'
  const voiceTitle =
    voiceLabel === '停止' ? '停止当前播报' : voiceLabel === '静音' ? '关闭语音' : '打开语音'
  const drag = props.windowed ? undefined : ''

  return (
    <section className={`pet-bubble${props.windowed ? ' is-window' : ''}`} aria-label="诗琚">
      <div className="pet-bubble-bar">
        <div className="pet-bubble-name" data-tauri-drag-region={drag}>
          <span>诗琚</span>
          <span className="pet-online" aria-hidden="true" />
        </div>
        <div className="pet-bubble-actions">
          <button
            type="button"
            className="pet-icon-btn"
            aria-label={voiceLabel}
            title={voiceTitle}
            onClick={props.onToggleVoice}
          >
            <SpeakerIcon muted={!props.voiceOn} />
          </button>
          <button type="button" className="pet-icon-btn" aria-label="收起" title="收起" onClick={props.onCollapse}>
            <CollapseIcon />
          </button>
        </div>
      </div>
      <p className="pet-bubble-text" data-tauri-drag-region={drag}>
        {props.text}
      </p>
      <svg className="pet-bubble-tail" viewBox="0 0 30 16" aria-hidden="true">
        <path d="M0 0H30C21.5 0.6 19.2 14.2 15 15.2C10.8 14.2 8.5 0.6 0 0Z" fill="var(--pet-glass)" />
        <path
          d="M1.2 1.2C8.8 1.6 11.2 14.2 15 15C18.8 14.2 21.2 1.6 28.8 1.2"
          fill="none"
          stroke="var(--pet-glass-rim)"
          strokeWidth="1.15"
          strokeLinejoin="round"
        />
      </svg>
    </section>
  )
}

