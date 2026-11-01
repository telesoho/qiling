export interface VoiceAssistantEvent {
  type:
    | 'state'
    | 'transcript'
    | 'debug_transcript'
    | 'debug_keyword'
    | 'warning'
    | 'error'
    | 'stop_playback'
  state?: string
  code?: string
  text?: string
  id?: number
  /** The runtime heard a real interruption while the pet was speaking. */
  barge_in?: boolean
}

export const WAKE_ACKNOWLEDGMENT = '我在，请说。'

/** States where the pet speaks one line before the microphone is armed again. */
export function isListeningPaused(state: string): boolean {
  return state === 'wake_acknowledgment' || state === 'responding'
}

/**
 * The microphone stays closed while the pet speaks, so the pet cannot hear itself
 * and answer the same question twice. Recognize/resume once the line is done:
 * right away when voice is off, otherwise after the current `say` line was heard.
 *
 * `lineChanged` says the paused state has already shown a different line. It keeps
 * the previous answer (still on screen when the next turn starts) from being
 * mistaken for a finished reply.
 */
export function shouldResumeListening(input: {
  state: string
  voice: boolean
  phase: string
  text: string
  speaking: boolean
  heardLine: string
  lineChanged: boolean
}): boolean {
  if (!isListeningPaused(input.state)) return false
  if (!input.voice) return true
  if (input.state === 'responding' && !input.lineChanged) return false
  const text = input.text.trim()
  if (input.phase !== 'say' || !text) return false
  if (input.state === 'wake_acknowledgment' && text !== WAKE_ACKNOWLEDGMENT) return false
  return !input.speaking && input.heardLine === text
}

export function voiceAssistantStateLabel(state: string): string {
  const labels: Record<string, string> = {
    stopped: '已关闭',
    starting: '正在启动',
    listening: '本机监听唤醒词',
    wake_acknowledgment: '器灵正在回应，请接着说',
    recognizing: '本机正在识别语音',
    conversing: '对话中，可以直接追问',
    responding: '器灵正在回答，可以打断',
    settle: '正在恢复监听',
    error: '不可用',
  }
  return labels[state] ?? state
}

export function voiceAssistantErrorMessage(code: string): string {
  if (code.includes('wake_word_invalid')) return '唤醒词需为 2–8 个连续汉字，请修改后重试。'
  if (code.includes('wake_word_encoding_failed')) return '无法为该唤醒词生成本机识别规则，请换一个常用汉字短语。'
  if (code.includes('voice_runtime_not_installed')) return '本机语音组件尚未安装，请按开发计划运行 scripts/setup_voice_assistant.py。'
  if (code.includes('voice_model_missing')) return '本机唤醒词或中文识别模型缺失，请重新运行语音组件安装脚本。'
  if (code.includes('microphone_unavailable')) return '麦克风不可用。请检查 Windows 麦克风隐私权限和默认输入设备。'
  if (code.includes('voice_engine_failed')) return '本机语音引擎启动失败，请重新安装语音组件。'
  if (code.includes('voice_runtime_start_failed')) return '无法启动本机语音服务。'
  if (code.includes('model_unavailable')) return '本机 Ollama 或配置的模型不可用。'
  if (code.includes('cancelled')) return '已取消本轮语音。'
  return `本机语音操作失败：${code}`
}
