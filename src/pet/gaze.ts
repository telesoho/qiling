/**
 * 眼神跟随的纯数学。
 *
 * 浏览器预览用 `pointermove`；Tauri 窗口只有 210×270，鼠标大多在窗口外，
 * 必须用全局指针坐标（`@tauri-apps/api/window` 的 `cursorPosition()`）换算。
 * 两者共用这里的向量钳制与平滑，组件只负责取坐标。
 */

export interface Gaze {
  x: number
  y: number
}

/** 原型：眼睛整体最多平移 ±7px、±5px，斜向不超过这个圆。 */
export const GAZE_MAX = { x: 7, y: 5 } as const

function round(value: number): number {
  return Math.round(value * 100) / 100
}

export function clampGaze(
  dx: number,
  dy: number,
  radiusPx: number,
  maxX: number = GAZE_MAX.x,
  maxY: number = GAZE_MAX.y,
): Gaze {
  if (!(radiusPx > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
    return { x: 0, y: 0 }
  }
  let nx = dx / radiusPx
  let ny = dy / radiusPx
  const magnitude = Math.hypot(nx, ny)
  if (magnitude > 1) {
    nx /= magnitude
    ny /= magnitude
  }
  return { x: round(nx * maxX), y: round(ny * maxY) }
}

export function gazeTowards(
  pointer: { x: number; y: number },
  center: { x: number; y: number },
  radiusPx: number,
  maxX: number = GAZE_MAX.x,
  maxY: number = GAZE_MAX.y,
): Gaze {
  return clampGaze(pointer.x - center.x, pointer.y - center.y, radiusPx, maxX, maxY)
}

export function smoothGaze(current: Gaze, target: Gaze, factor = 0.18): Gaze {
  return {
    x: round(current.x + (target.x - current.x) * factor),
    y: round(current.y + (target.y - current.y) * factor),
  }
}

/** 原型：每 3.2–6.8 秒眨一次，间隔不规律。 */
export function nextBlinkDelayMs(random: () => number = Math.random): number {
  return 3200 + random() * 3600
}

export const BLINK_DURATION_MS = 130