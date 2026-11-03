import { useEffect, useRef } from 'react'
import { frameUrl, imageFor, type AnimTrack } from './anim'
import {
  pickupPlayback,
  stepPickup,
  type PickupPhase,
  type PickupSegments,
} from './pickup'

/**
 * 画吊起/悬空/落下分帧。相位播完只通知父级换相位，
 * 由父级重新挂载后从新相位的首帧继续。
 */
export function PickupSprite(props: {
  track: AnimTrack
  segments: PickupSegments
  phase: Exclude<PickupPhase, 'idle'>
  holding: boolean
  /** 分帧还没载入时先画当前姿势，避免吊起瞬间空白。 */
  fallbackSrc: string
  onAdvance: (next: Exclude<PickupPhase, 'lift'>) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fallback = useRef<HTMLImageElement | null>(null)
  const holding = useRef(props.holding)
  const advance = useRef(props.onAdvance)
  holding.current = props.holding
  advance.current = props.onAdvance

  const width = props.track.frameSize.width
  const height = props.track.frameSize.height
  const frameMs = 1000 / (props.track.fps > 0 ? props.track.fps : 24)

  useEffect(() => {
    if (typeof Image === 'undefined') return
    const image = new Image()
    image.src = props.fallbackSrc
    fallback.current = image
  }, [props.fallbackSrc])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return

    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)

    let playback = pickupPlayback(props.segments, props.phase)
    let raf = 0
    let last = 0
    let acc = 0
    let lastUrl: string | null = null

    const draw = () => {
      const url = frameUrl(props.track, playback.phase, playback.frame)
      const frame = url ? imageFor(url) : undefined
      if (frame && frame.complete && frame.naturalWidth > 0) {
        context.clearRect(0, 0, width, height)
        context.drawImage(frame, 0, 0, width, height)
        lastUrl = url ?? null
        return
      }
      const previous = lastUrl ? imageFor(lastUrl) : undefined
      if (previous && previous.complete && previous.naturalWidth > 0) {
        context.clearRect(0, 0, width, height)
        context.drawImage(previous, 0, 0, width, height)
        return
      }
      const pose = fallback.current
      if (!pose || !pose.complete || pose.naturalWidth === 0) return
      context.clearRect(0, 0, width, height)
      context.drawImage(pose, 0, height - pose.naturalHeight, pose.naturalWidth, pose.naturalHeight)
    }

    const tick = (now: number) => {
      if (!last) last = now
      let elapsed = now - last
      last = now
      if (elapsed > 200) elapsed = frameMs
      acc += elapsed
      let steps = 0
      while (acc >= frameMs && steps < 4) {
        acc -= frameMs
        steps += 1
        const next = stepPickup(props.segments, playback, holding.current)
        if (next.phase !== playback.phase) {
          if (next.phase !== 'lift') advance.current(next.phase)
          return
        }
        playback = next
      }
      draw()
      raf = window.requestAnimationFrame(tick)
    }

    draw()
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [props.phase, props.track, props.segments, width, height, frameMs])

  return (
    <canvas
      ref={canvasRef}
      className="pet-pickup"
      width={width}
      height={height}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
}
