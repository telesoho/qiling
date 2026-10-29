import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { type PetStateId, isPetStateId } from './states'

const STATE_KEY = 'qiling.pet.state'
const CHANNEL = 'qiling-pet'

export type PetMessage =
  | { type: 'state'; state: PetStateId }
  | { type: 'visibility'; open: boolean }

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function readPetState(): PetStateId {
  try {
    const saved = localStorage.getItem(STATE_KEY)
    if (saved && isPetStateId(saved)) return saved
  } catch {
    // 隐私模式里读不到本地记录时，回到待命。
  }
  return 'idle'
}

let outbound: BroadcastChannel | null = null

function channel(): BroadcastChannel {
  if (!outbound) outbound = new BroadcastChannel(CHANNEL)
  return outbound
}

export function publishPet(message: PetMessage): void {
  if (message.type === 'state') {
    try {
      localStorage.setItem(STATE_KEY, message.state)
    } catch {
      // 写不进去也不影响这一次切换。
    }
    if (inTauri()) {
      void emit('pet-state', message.state)
    }
  }
  channel().postMessage(message)
}

export function subscribePet(handler: (message: PetMessage) => void): () => void {
  const incoming = new BroadcastChannel(CHANNEL)
  incoming.onmessage = (event: MessageEvent<PetMessage>) => {
    const message = event.data
    if (!message || (message.type !== 'state' && message.type !== 'visibility')) return
    if (message.type === 'state' && !isPetStateId(message.state)) return
    handler(message)
  }

  let dead = false
  const stops: Array<() => void> = []
  if (inTauri()) {
    const remember = (pending: Promise<() => void>) => {
      pending.then((stop) => {
        if (dead) stop()
        else stops.push(stop)
      }).catch(() => {})
    }
    remember(listen<boolean>('pet-visibility', (event) => {
      handler({ type: 'visibility', open: event.payload })
    }))
    remember(listen<string>('pet-state', (event) => {
      if (isPetStateId(event.payload)) handler({ type: 'state', state: event.payload })
    }))
  }

  return () => {
    dead = true
    stops.forEach((stop) => stop())
    incoming.close()
  }
}

export async function setPetWindowOpen(open: boolean): Promise<boolean> {
  if (inTauri()) {
    return invoke<boolean>('pet_set_open', { open })
  }
  if (open) {
    const popup = window.open('/?pet=1', 'qiling-pet', 'popup=yes,width=420,height=700')
    return popup != null
  }
  publishPet({ type: 'visibility', open: false })
  return false
}

export async function petWindowIsOpen(): Promise<boolean> {
  if (!inTauri()) return false
  return invoke<boolean>('pet_is_open')
}
