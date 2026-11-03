import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window'
import { inTauri } from './sync'

interface DragSession {
  pointerId: number
  element: HTMLElement
  startScreenX: number
  startScreenY: number
  /** 窗口左上角的物理坐标，拿到后才开始跟手。 */
  originX: number
  originY: number
  scale: number
  ready: boolean
  dx: number
  dy: number
  frame: number
  window: TauriWindow | null
}

export interface PetDrag {
  holding: boolean
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void
  /** 收起窗口等拿不到 pointerup 的场合，主动收尾。 */
  cancel: () => void
}

/**
 * 按住器灵拖动窗口。
 *
 * 不用 data-tauri-drag-region：原生拖拽在 Windows 上会吞掉 pointerup，
 * 这里自己按指针位移移动窗口，松手才拿得到，吊起/落下动画才有落点。
 * 浏览器预览里窗口不动，但按住/松手仍会推进动画。
 */
export function usePetDrag(options: {
  onGrab: () => void
  onRelease: () => void
}): PetDrag {
  const [holding, setHolding] = useState(false)
  const session = useRef<DragSession | null>(null)
  const grab = useRef(options.onGrab)
  const release = useRef(options.onRelease)
  grab.current = options.onGrab
  release.current = options.onRelease

  useEffect(() => () => {
    const active = session.current
    if (active?.frame) window.cancelAnimationFrame(active.frame)
    session.current = null
  }, [])

  function scheduleMove(active: DragSession): void {
    if (active.frame || !active.ready) return
    active.frame = window.requestAnimationFrame(() => {
      active.frame = 0
      if (session.current !== active || !active.window) return
      const x = Math.round(active.originX + active.dx * active.scale)
      const y = Math.round(active.originY + active.dy * active.scale)
      void active.window.setPosition(new PhysicalPosition(x, y)).catch(() => {})
    })
  }

  function begin(event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0 || event.isPrimary === false || session.current) return
    event.preventDefault()
    const element = event.currentTarget
    try {
      element.setPointerCapture(event.pointerId)
    } catch {
      // 指针已经抬起时拿不到捕获，照常开播。
    }
    const active: DragSession = {
      pointerId: event.pointerId,
      element,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      originX: 0,
      originY: 0,
      scale: 1,
      ready: false,
      dx: 0,
      dy: 0,
      frame: 0,
      window: null,
    }
    session.current = active
    setHolding(true)
    grab.current()

    if (!inTauri()) return
    const petWindow = getCurrentWindow()
    active.window = petWindow
    Promise.all([petWindow.outerPosition(), petWindow.scaleFactor()])
      .then(([origin, scale]) => {
        if (session.current !== active) return
        active.originX = origin.x
        active.originY = origin.y
        active.scale = scale > 0 ? scale : 1
        active.ready = true
        if (active.dx || active.dy) scheduleMove(active)
      })
      .catch(() => {})
  }

  function move(event: ReactPointerEvent<HTMLElement>): void {
    const active = session.current
    if (!active || event.pointerId !== active.pointerId) return
    active.dx = event.screenX - active.startScreenX
    active.dy = event.screenY - active.startScreenY
    scheduleMove(active)
  }

  function cancel(): void {
    const active = session.current
    if (!active) return
    session.current = null
    if (active.frame) window.cancelAnimationFrame(active.frame)
    try {
      active.element.releasePointerCapture(active.pointerId)
    } catch {
      // 捕获已丢失时无需再释放。
    }
    setHolding(false)
    release.current()
  }

  function finish(event: ReactPointerEvent<HTMLElement>): void {
    const active = session.current
    if (!active || event.pointerId !== active.pointerId) return
    session.current = null
    if (active.frame) window.cancelAnimationFrame(active.frame)
    if (active.ready && active.window && (active.dx || active.dy)) {
      const x = Math.round(active.originX + active.dx * active.scale)
      const y = Math.round(active.originY + active.dy * active.scale)
      void active.window.setPosition(new PhysicalPosition(x, y)).catch(() => {})
    }
    try {
      active.element.releasePointerCapture(event.pointerId)
    } catch {
      // 捕获已丢失时无需再释放。
    }
    setHolding(false)
    release.current()
  }

  return {
    holding,
    onPointerDown: begin,
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    cancel,
  }
}
