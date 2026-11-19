/**
 * 灵泡的 SVG 渲染与运行期动画。
 *
 * 骨架、配色与运动参数来自 `design/characters/lingpao/`：
 *   - `sheets/lingpao-groove.html`：身体/耳机/音符/腮红/眼/嘴 + 三档律动；
 *   - `sheets/state-preview.html`：灯泡/省略号/汗滴/蒸汽/星星；
 *   - `sheets/lingpao-idle.svg`：待机定稿。
 *
 * 待机、说话、拎起由 CSS 驱动；听音乐时由单个 rAF 直接写 transform，
 * 这样 20Hz 的后端事件不会触发 React 重渲染。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject, ReactNode } from 'react'
import { BLINK_DURATION_MS, gazeTowards, nextBlinkDelayMs, type Gaze } from './gaze'
import {
  lingpaoAriaLabel,
  poseForRuntime,
  type LingpaoEye,
  type LingpaoFx,
  type LingpaoMouth,
  type LingpaoPose,
  type LingpaoProp,
} from './lingpao'
import {
  beatAt,
  blendGround,
  blendMotion,
  createBeatClock,
  groundFor,
  IDLE_GROUND,
  lockBeatPhase,
  MOOD_BLEND_MS,
  MOOD_SETTLE_MS,
  motionFor,
  REST_MOTION,
  retuneBeatClock,
  visibleMusicMood,
  type GroundShadow,
  type Motion,
  type MusicMood,
  type MusicTuning,
} from './music'
import type { PetStateId } from './states'
import { inTauri } from './sync'
import type { LocalMusicSense } from './localMusic'
import { useMusicSense } from './useMusicSense'
import './lingpao.css'

const INK = '#2B1618'
const CREAM = '#FFF3E6'
const GOLD = '#FFC978'
const SKY = '#8FCBFF'

/**
 * 换眼睛＝换图形（椭圆 ↔ 弯眼弧），CSS 没法 tween 两个不同节点，
 * 所以先眨眼遮住，在最闭的一帧换图形，再睁开。时长与 `.lp-eyes` 的过渡对齐。
 */
const EYE_COVER_CLOSE_MS = 90
const EYE_COVER_OPEN_MS = 110

const BODY_PATH =
  'M90 101 C119 101 143 123 145 155 C147 189 123 209 90 209 C57 209 33 189 35 155 C37 123 61 101 90 101 Z'

export interface LingpaoParts {
  dance?: RefObject<SVGGElement>
  breathe?: RefObject<SVGGElement>
  ground?: RefObject<SVGEllipseElement>
  gaze?: RefObject<SVGGElement>
  eyes?: RefObject<SVGGElement>
}

function eyeNode(eye: LingpaoEye, x: number, scale: number, key: string): ReactNode {
  const y = 152
  const side = x < 90 ? 1 : -1
  switch (eye) {
    case 'open':
      return (
        <g className="lp-eye" key={key}>
          <ellipse cx={x} cy={y} rx={8.6 * scale} ry={12.4 * scale} fill={INK} />
        </g>
      )
    case 'wide':
      return (
        <g className="lp-eye" key={key}>
          <ellipse cx={x} cy={y} rx={9.8 * scale} ry={14.6 * scale} fill={INK} />
        </g>
      )
    case 'lookup':
      return (
        <g className="lp-eye" key={key}>
          <ellipse cx={x} cy={y - 3} rx={8.2 * scale} ry={11 * scale} fill={INK} />
          <path
            d={`M${x - 9} ${y - 8} A9 9 0 0 0 ${x + 9} ${y - 8}`}
            fill="none"
            stroke={INK}
            strokeWidth={3}
            strokeLinecap="round"
          />
        </g>
      )
    case 'happy':
      return (
        <path
          key={key}
          d={`M${x - 9} ${y + 3} Q${x} ${y - 10} ${x + 9} ${y + 3}`}
          fill="none"
          stroke={INK}
          strokeWidth={6.2}
          strokeLinecap="round"
        />
      )
    case 'closed':
      return (
        <path
          key={key}
          d={`M${x - 9} ${y - 1} Q${x} ${y + 6} ${x + 9} ${y - 1}`}
          fill="none"
          stroke={INK}
          strokeWidth={5.8}
          strokeLinecap="round"
        />
      )
    case 'angry':
      return (
        <g key={key}>
          <g className="lp-eye" transform={`rotate(${side * 16} ${x} ${y})`}>
            <ellipse cx={x} cy={y + 1} rx={8.8 * scale} ry={9.4 * scale} fill={INK} />
          </g>
          <path
            d={`M${x - side * 4} ${y - 15} L${x + side * 12} ${y - 19}`}
            fill="none"
            stroke={INK}
            strokeWidth={3.4}
            strokeLinecap="round"
          />
        </g>
      )
    case 'worry':
      return (
        <g key={key}>
          <g className="lp-eye">
            <ellipse cx={x} cy={y + 1} rx={7.2 * scale} ry={10.4 * scale} fill={INK} />
          </g>
          <path
            d={`M${x - side * 2} ${y - 16} L${x + side * 11} ${y - 12}`}
            fill="none"
            stroke={INK}
            strokeWidth={3.2}
            strokeLinecap="round"
          />
        </g>
      )
    case 'star':
      return (
        <g className="lp-eye" key={key}>
          <path
            transform={`translate(${x} ${y}) scale(0.92)`}
            d="M0 -12 C2.2 -3.5 3.5 -2.2 12 0 C3.5 2.2 2.2 3.5 0 12 C-2.2 3.5 -3.5 2.2 -12 0 C-3.5 -2.2 -2.2 -3.5 0 -12 Z"
            fill={INK}
          />
        </g>
      )
    default:
      return null
  }
}

function mouthNode(mouth: LingpaoMouth): ReactNode {
  switch (mouth) {
    case 'grin':
      return <path d="M80 172 Q90 186 100 172 Z" fill={INK} />
    case 'talk':
      return (
        <g className="lp-mouth-talk">
          <ellipse cx={90} cy={176} rx={5.8} ry={4.2} fill={INK} />
        </g>
      )
    case 'smirk':
      return (
        <path
          d="M83 174 Q91 180 99 171"
          fill="none"
          stroke={INK}
          strokeWidth={4.2}
          strokeLinecap="round"
        />
      )
    case 'wavy':
      return (
        <path
          d="M82 176 q4 -4 8 0 q4 4 8 0"
          fill="none"
          stroke={INK}
          strokeWidth={3.4}
          strokeLinecap="round"
        />
      )
    case 'pout':
      return (
        <path
          d="M83 177 Q90 172 97 177"
          fill="none"
          stroke={INK}
          strokeWidth={4.2}
          strokeLinecap="round"
        />
      )
    case 'o':
      return <ellipse cx={90} cy={176} rx={4.6} ry={5.4} fill={INK} />
    case 'smile':
      return (
        <path
          d="M84 174 Q90 178 96 174"
          fill="none"
          stroke={INK}
          strokeWidth={3.6}
          strokeLinecap="round"
        />
      )
    case 'smile-wide':
      return (
        <path
          d="M82 174 Q90 181 98 174"
          fill="none"
          stroke={INK}
          strokeWidth={4}
          strokeLinecap="round"
        />
      )
    default:
      return null
  }
}

function propNode(prop: LingpaoProp): ReactNode {
  switch (prop) {
    case 'bulb':
      return (
        <g transform="translate(138 82)">
          <circle r={10} fill={GOLD} stroke={INK} strokeWidth={3} />
          <rect x={-4} y={8} width={8} height={5.5} rx={2} fill={INK} />
          <g stroke={INK} strokeWidth={2.4} strokeLinecap="round" opacity={0.65}>
            <path d="M0 -17 L0 -13.5" />
            <path d="M-15 -4 L-11 -2" />
            <path d="M15 -4 L11 -2" />
          </g>
        </g>
      )
    case 'dots':
      return (
        <g fill={CREAM} stroke={INK} strokeWidth={2.4}>
          <circle className="lp-dot" cx={128} cy={98} r={4} />
          <circle className="lp-dot" cx={141} cy={87} r={3.3} style={{ animationDelay: '0.45s' }} />
          <circle className="lp-dot" cx={152} cy={74} r={2.6} style={{ animationDelay: '0.9s' }} />
        </g>
      )
    case 'sweat':
      return (
        <g transform="translate(126 116)">
          <g className="lp-drop">
            <path
              d="M0 -11 C7 -3 8 3 4.5 7 C1 11 -5 9 -6 4.5 C-7 0 -4 -4 0 -11 Z"
              fill={SKY}
              stroke={INK}
              strokeWidth={2.6}
            />
          </g>
        </g>
      )
    case 'steam':
      return (
        <g fill="none" strokeLinecap="round" opacity={0.9}>
          <g className="lp-steam">
            <path
              stroke={INK}
              strokeWidth={6.6}
              opacity={0.55}
              d="M64 92 q-7 -8 0 -16 q7 -8 0 -15"
            />
            <path stroke={CREAM} strokeWidth={3.4} d="M64 92 q-7 -8 0 -16 q7 -8 0 -15" />
          </g>
          <g className="lp-steam" style={{ animationDelay: '0.7s' }}>
            <path
              stroke={INK}
              strokeWidth={6.6}
              opacity={0.55}
              d="M118 92 q7 -8 0 -16 q-7 -8 0 -15"
            />
            <path stroke={CREAM} strokeWidth={3.4} d="M118 92 q7 -8 0 -16 q-7 -8 0 -15" />
          </g>
        </g>
      )
    case 'bang':
      return (
        <g transform="translate(140 76)">
          <path
            d="M-3 -16 h6 l-1.4 12 h-3.2 Z"
            fill={GOLD}
            stroke={INK}
            strokeWidth={2.6}
            strokeLinejoin="round"
          />
          <circle cx={0} cy={9} r={3.4} fill={GOLD} stroke={INK} strokeWidth={2.6} />
        </g>
      )
    case 'ear':
      return (
        <g fill="none" strokeLinecap="round" opacity={0.9}>
          <path
            stroke={INK}
            strokeWidth={5.6}
            opacity={0.3}
            d="M151 124 q8 10 0 21 M160 118 q12 16 0 32"
          />
          <path stroke={GOLD} strokeWidth={3} d="M151 124 q8 10 0 21" />
          <path stroke={GOLD} strokeWidth={3} d="M160 118 q12 16 0 32" />
        </g>
      )
    default:
      return null
  }
}

function fxNode(fx: LingpaoFx): ReactNode {
  switch (fx) {
    case 'sparkles':
      return (
        <g fill={GOLD} stroke={INK} strokeWidth={2} strokeLinejoin="round">
          <g transform="translate(44 112)">
            <path
              className="lp-spark"
              d="M0 -9 C1.6 -2.6 2.6 -1.6 9 0 C2.6 1.6 1.6 2.6 0 9 C-1.6 2.6 -2.6 1.6 -9 0 C-2.6 -1.6 -1.6 -2.6 0 -9 Z"
            />
          </g>
          <g transform="translate(137 104) scale(0.8)">
            <path
              className="lp-spark"
              style={{ animationDelay: '0.7s' }}
              d="M0 -9 C1.6 -2.6 2.6 -1.6 9 0 C2.6 1.6 1.6 2.6 0 9 C-1.6 2.6 -2.6 1.6 -9 0 C-2.6 -1.6 -1.6 -2.6 0 -9 Z"
            />
          </g>
        </g>
      )
    case 'ripple':
      return (
        <g fill="none" opacity={0.9}>
          <circle
            className="lp-ripple"
            cx={90}
            cy={150}
            r={74}
            stroke={INK}
            strokeWidth={4.4}
            opacity={0.28}
          />
          <circle className="lp-ripple" cx={90} cy={150} r={74} stroke={GOLD} strokeWidth={2.4} />
        </g>
      )
    default:
      return null
  }
}

function phonesNode(music: boolean): ReactNode {
  return (
    <g data-part="phones" className={`lp-phones${music ? ' on' : ''}`} aria-hidden="true">
      <path
        d="M38 146 C36 112 62 99 90 99 C118 99 144 112 142 146"
        fill="none"
        stroke={INK}
        strokeWidth={7}
        strokeLinecap="round"
      />
      <path
        d="M38 146 C36 112 62 99 90 99 C118 99 144 112 142 146"
        fill="none"
        stroke={CREAM}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <rect
        x={29.5}
        y={134}
        width={17}
        height={28}
        rx={8.5}
        fill={CREAM}
        stroke={INK}
        strokeWidth={3}
      />
      <rect
        x={133.5}
        y={134}
        width={17}
        height={28}
        rx={8.5}
        fill={CREAM}
        stroke={INK}
        strokeWidth={3}
      />
    </g>
  )
}

function notesNode(music: boolean): ReactNode {
  return (
    <g data-part="notes" className={`lp-notes${music ? ' on' : ''}`} aria-hidden="true">
      <g transform="translate(140 100) scale(1.24) translate(-140 -100)">
        <g
          className="lp-note-a"
          fill={GOLD}
          stroke={INK}
          strokeWidth={2.4}
          strokeLinecap="round"
        >
          <ellipse cx={132} cy={98} rx={5} ry={4} transform="rotate(-18 132 98)" />
          <path d="M136 97 L136 78" fill="none" />
        </g>
        <g
          className="lp-note-b"
          fill={GOLD}
          stroke={INK}
          strokeWidth={2.2}
          strokeLinecap="round"
        >
          <ellipse cx={150} cy={112} rx={4.2} ry={3.4} transform="rotate(-18 150 112)" />
          <path d="M153.4 111 L153.4 95" fill="none" />
        </g>
      </g>
    </g>
  )
}

export interface LingpaoFigureProps {
  pose: LingpaoPose
  ariaLabel: string
  holding?: boolean
  dancing?: boolean
  mood?: MusicMood | null
  parts?: LingpaoParts
}

/** 纯展示：给定 Pose 就能 SSR，便于快照/可访问性测试。 */
export function LingpaoFigure(props: LingpaoFigureProps): JSX.Element {
  const { pose, parts } = props
  const music = pose.prop === 'music'
  const cheeks = music && pose.eye !== 'happy'
  const eyeScale = pose.eyeScale ?? 1
  const className = `lingpao${props.dancing ? ' is-dancing' : ''}${props.holding ? ' is-holding' : ''}`

  return (
    <svg
      className={className}
      width={180}
      height={240}
      viewBox="0 0 180 240"
      role="img"
      aria-label={props.ariaLabel}
      data-part="root"
      data-mood={props.mood ?? undefined}
      data-pose-eye={pose.eye}
      data-pose-mouth={pose.mouth}
    >
      <ellipse
        className="lp-ground"
        ref={parts?.ground}
        cx={90}
        cy={216}
        rx={34}
        ry={6}
      />
      <g className="lp-dance" ref={parts?.dance}>
        {pose.fx !== 'none' && <g data-part="fx">{fxNode(pose.fx)}</g>}
        <g className="lp-tilt" style={{ transform: `rotate(${pose.tilt}deg)` }}>
          <g className="lp-breathe" ref={parts?.breathe}>
            <path className="lp-body" d={BODY_PATH} data-part="body" />
            {phonesNode(music)}
            <g
              data-part="cheeks"
              className={`lp-cheeks${cheeks ? ' on' : ''}`}
              aria-hidden="true"
            >
              <ellipse cx={56} cy={176} rx={9} ry={5} />
              <ellipse cx={124} cy={176} rx={9} ry={5} />
            </g>
            <g className="lp-gaze" ref={parts?.gaze}>
              <g data-part="eyes" className="lp-eyes" ref={parts?.eyes}>
                {eyeNode(pose.eye, 71, eyeScale, 'left')}
                {eyeNode(pose.eye, 109, eyeScale, 'right')}
              </g>
            </g>
            <g data-part="mouth">{mouthNode(pose.mouth)}</g>
            {notesNode(music)}
          </g>
        </g>
        {pose.prop !== 'none' && pose.prop !== 'music' && (
          <g data-part="prop">{propNode(pose.prop)}</g>
        )}
      </g>
    </svg>
  )
}

const MemoFigure = memo(LingpaoFigure)

export interface SvgSpriteProps {
  stateId: PetStateId
  speaking: boolean
  holding: boolean
  /** 设定里开了听音乐，且器灵可见、已就绪。 */
  musicEnabled: boolean
  /** 用户在设定页调整的识别阈值。 */
  musicTuning: MusicTuning
  /** 曲库播放引擎的实时状态；播放中时优先于系统声音。 */
  localMusic?: LocalMusicSense
  /** 器灵可见时才跟随鼠标，隐藏时停掉轮询。 */
  gazeEnabled: boolean
}

export default function SvgSprite(props: SvgSpriteProps): JSX.Element {
  const local = props.localMusic
  const localActive = local?.active ?? false
  const sense = useMusicSense({
    enabled: props.musicEnabled && !localActive,
    tuning: props.musicTuning,
  })
  // 曲库播放时由本地引擎驱动；否则继续跟随系统声音。
  const sourceMood = localActive ? local?.mood ?? null : sense.mood
  // 器灵自己的播报会经过系统回环被采集到；后端会判成人声，这里再加一道门：
  // 正在说话时即使误判也不进入听音乐状态，说完再恢复。
  const music = visibleMusicMood(props.musicEnabled, props.speaking, sourceMood)
  const pose = poseForRuntime({
    stateId: props.stateId,
    speaking: props.speaking,
    holding: props.holding,
    music,
  })
  const ariaLabel = lingpaoAriaLabel({
    stateId: props.stateId,
    speaking: props.speaking,
    holding: props.holding,
    music,
  })
  const [reduced, setReduced] = useState(false)
  const danceRef = useRef<SVGGElement>(null)
  const breatheRef = useRef<SVGGElement>(null)
  const groundRef = useRef<SVGEllipseElement>(null)
  const gazeRef = useRef<SVGGElement>(null)
  const eyesRef = useRef<SVGGElement>(null)
  const gazeTarget = useRef<Gaze>({ x: 0, y: 0 })
  const dancing =
    props.musicEnabled && !props.holding && props.stateId === 'idle' && music !== null && !reduced
  // 音乐停下不立刻把 transform 交还 CSS：先让 rAF 在 360ms 内收拢到静止，
  // 否则会从「摇到一半」瞬移回待机位。`danceActive` 覆盖这段收尾时间。
  const [danceActive, setDanceActive] = useState(false)
  const dancingRef = useRef(false)
  dancingRef.current = danceActive
  // rAF 循环靠 ref 读档位，这样换档只改变目标，不重启循环、不重置节拍相位。
  const moodRef = useRef<MusicMood | null>(music)
  moodRef.current = music
  const parts = useMemo<LingpaoParts>(
    () => ({
      dance: danceRef,
      breathe: breatheRef,
      ground: groundRef,
      gaze: gazeRef,
      eyes: eyesRef,
    }),
    [],
  )

  useEffect(() => {
    if (dancing) {
      setDanceActive(true)
      return
    }
    if (!danceActive) return
    // 被拎起或用户要求减少动效时立刻停；音乐自然结束才走收尾过渡。
    if (props.holding || reduced) {
      setDanceActive(false)
      return
    }
    const timer = window.setTimeout(() => setDanceActive(false), MOOD_SETTLE_MS + 60)
    return () => window.clearTimeout(timer)
  }, [dancing, danceActive, props.holding, reduced])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // 眨眼：3.2–6.8s 随机；闭眼笑（舒缓）与静态闭眼不眨。
  useEffect(() => {
    if (reduced) return
    if (pose.eye !== 'open' && pose.eye !== 'wide') return
    if (music === 'calm') return
    let alive = true
    let nextTimer = 0
    let closeTimer = 0
    const schedule = () => {
      nextTimer = window.setTimeout(() => {
        if (!alive) return
        eyesRef.current?.classList.add('blink')
        closeTimer = window.setTimeout(() => {
          eyesRef.current?.classList.remove('blink')
          if (alive) schedule()
        }, BLINK_DURATION_MS)
      }, nextBlinkDelayMs())
    }
    schedule()
    return () => {
      alive = false
      window.clearTimeout(nextTimer)
      window.clearTimeout(closeTimer)
      eyesRef.current?.classList.remove('blink')
    }
  }, [pose.eye, music, reduced])

  // 换眼遮罩：眼睛形状变了就先用 `.cover` 闭一下，在最闭的一帧换图形再睁开。
  // 只跟着 `pose.eye` 走，`setShownEye` 不会重跑本 effect（否则会提前睁眼）。
  const [shownEye, setShownEye] = useState<LingpaoEye>(pose.eye)
  const shownEyeRef = useRef<LingpaoEye>(pose.eye)
  useEffect(() => {
    if (pose.eye === shownEyeRef.current) return
    if (reduced) {
      shownEyeRef.current = pose.eye
      setShownEye(pose.eye)
      return
    }
    const eyes = eyesRef.current
    eyes?.classList.add('cover')
    const close = window.setTimeout(() => {
      shownEyeRef.current = pose.eye
      setShownEye(pose.eye)
    }, EYE_COVER_CLOSE_MS)
    const open = window.setTimeout(() => {
      eyes?.classList.remove('cover')
    }, EYE_COVER_CLOSE_MS + EYE_COVER_OPEN_MS)
    return () => {
      window.clearTimeout(close)
      window.clearTimeout(open)
      eyes?.classList.remove('cover')
    }
  }, [pose.eye, reduced])
  // 换脸期间先画旧眼睛，闭眼帧之后切到新眼睛。
  const shownPose = shownEye === pose.eye ? pose : { ...pose, eye: shownEye }

  // 眼神跟随：浏览器用指针；Tauri 用全局光标（窗口外也跟随）。
  useEffect(() => {
    if (reduced || !props.gazeEnabled) return
    const node = gazeRef.current
    if (!node) return
    let alive = true
    let timer = 0
    const apply = (gaze: Gaze) => {
      if (!alive) return
      gazeTarget.current = gaze
      if (!dancingRef.current) {
        node.style.transform = `translate(${gaze.x}px, ${gaze.y}px)`
      }
    }

    if (!inTauri()) {
      const onMove = (event: PointerEvent) => {
        const svg = node.ownerSVGElement
        if (!svg) return
        const rect = svg.getBoundingClientRect()
        apply(
          gazeTowards(
            { x: event.clientX, y: event.clientY },
            { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.61 },
            Math.min(rect.width, rect.height) * 0.42,
          ),
        )
      }
      const onLeave = () => apply({ x: 0, y: 0 })
      window.addEventListener('pointermove', onMove)
      document.addEventListener('pointerleave', onLeave)
      return () => {
        alive = false
        window.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerleave', onLeave)
      }
    }

    void (async () => {
      const { cursorPosition, getCurrentWindow } = await import('@tauri-apps/api/window')
      if (!alive) return
      const win = getCurrentWindow()
      let origin: { x: number; y: number } | null = null
      let outer: { width: number; height: number } | null = null
      let geometryAge = 0
      const tick = async () => {
        if (!alive) return
        try {
          const cursor = await cursorPosition()
          if (geometryAge <= 0 || !origin || !outer) {
            const [nextOrigin, nextOuter] = await Promise.all([
              win.outerPosition(),
              win.outerSize(),
            ])
            origin = nextOrigin
            outer = nextOuter
            geometryAge = 10
          }
          geometryAge -= 1
          if (origin && outer && cursor) {
            apply(
              gazeTowards(
                { x: cursor.x, y: cursor.y },
                {
                  x: origin.x + outer.width / 2,
                  y: origin.y + outer.height * 0.61,
                },
                Math.min(outer.width, outer.height) * 0.42,
              ),
            )
          }
        } catch {
          // 光标或窗口信息取不到时保持上一次视线。
        }
        if (alive) timer = window.setTimeout(tick, 100)
      }
      void tick()
    })().catch(() => {})

    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [props.gazeEnabled, reduced])

  // 听音乐：单一 rAF 写三档运动。
  //
  // 换档**不重启**这个循环：节拍时钟和上一帧动作都留在闭包里。若按档位重启，
  // 清理会先清掉 inline transform（瞬移回原位）、新时钟又从 wave=+1 起拍，
  // 于是「激烈 → 舒缓」必然跳一下。现在换档只换目标，并用 smoothstep 从上一帧
  // 真正画出的值过渡过去；音乐结束则先收拢到静止，再把 transform 交还 CSS。
  useEffect(() => {
    if (!danceActive || reduced) return
    const danceNode = danceRef.current
    const breatheNode = breatheRef.current
    const groundNode = groundRef.current
    const gazeNode = gazeRef.current
    if (!danceNode || !breatheNode || !groundNode) return

    const bpmRef = localActive ? local?.bpm ?? sense.bpm : sense.bpm
    const beatAtRef = localActive ? local?.beatAt ?? sense.beatAt : sense.beatAt
    const nextBeat = localActive ? local?.nextBeatMs.current ?? 0 : 0
    let clock = createBeatClock(performance.now(), bpmRef.current, nextBeat)
    let lastIndex = -1
    let pulse = 0
    let lastNow = performance.now()
    let lastBeat = beatAtRef.current
    let accentTimer = 0
    let raf = 0

    // 逐拍的点缀只动眼睛（换表情仍由 mood 决定），不打断换档与换眼遮罩。
    const accentEyes = () => {
      const eyes = eyesRef.current
      if (!eyes) return
      eyes.classList.add('beat')
      window.clearTimeout(accentTimer)
      accentTimer = window.setTimeout(() => eyes.classList.remove('beat'), 110)
    }

    let mood: MusicMood | null = moodRef.current
    let lastMotion: Motion = REST_MOTION
    let lastGround: GroundShadow = IDLE_GROUND
    // 入场也走过渡：从待机位淡入，而不是第一帧直接贴上摇摆值。
    let motionFrom: Motion = REST_MOTION
    let groundFrom: GroundShadow = IDLE_GROUND
    let blendStart = performance.now()
    let blendDuration = MOOD_SETTLE_MS
    let blending = true

    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastNow) / 1000))
      lastNow = now
      const bpm = bpmRef.current
      const reference = Math.max(clock.bpm || bpm, 1)
      if (Math.abs(bpm - clock.bpm) / reference > 0.08) {
        clock = retuneBeatClock(clock, now, bpm)
      }
      if (beatAtRef.current > lastBeat) {
        lastBeat = beatAtRef.current
        clock = lockBeatPhase(clock, now, bpm)
      }
      const beat = beatAt(clock, now)
      if (beat.index !== lastIndex) {
        lastIndex = beat.index
        pulse = 1
        if (moodRef.current !== null && moodRef.current !== 'calm') accentEyes()
      }
      pulse *= Math.exp(-dt * 4.2)

      const nextMood = moodRef.current
      if (nextMood !== mood) {
        // 从上一帧真正画出来的姿态起步，无论换档多频繁都接得上，不会跳回基准位。
        motionFrom = lastMotion
        groundFrom = lastGround
        blendStart = now
        blendDuration = nextMood === null || mood === null ? MOOD_SETTLE_MS : MOOD_BLEND_MS
        blending = true
        mood = nextMood
      }

      const target = motionFor(mood, beat.wave, pulse, now / 1000)
      let motion = target
      let ground = mood === null ? IDLE_GROUND : groundFor(target)
      if (blending) {
        const progress = (now - blendStart) / blendDuration
        if (progress >= 1) {
          blending = false
        } else {
          motion = blendMotion(motionFrom, target, progress)
          ground = blendGround(
            groundFrom,
            mood === null ? IDLE_GROUND : groundFor(motion),
            progress,
          )
        }
      }
      lastMotion = motion
      lastGround = ground

      danceNode.style.transform = `translate3d(${motion.x.toFixed(2)}px,${motion.y.toFixed(2)}px,0) rotate(${motion.rotation.toFixed(2)}deg)`
      breatheNode.style.transform = `scale(${motion.sx.toFixed(4)},${motion.sy.toFixed(4)})`
      groundNode.style.opacity = ground.opacity.toFixed(3)
      groundNode.style.transform = `scale(${ground.scale.toFixed(3)})`
      if (gazeNode) {
        gazeNode.style.transform = `translate(${(gazeTarget.current.x + beat.wave * 2.5).toFixed(2)}px,${gazeTarget.current.y.toFixed(2)}px)`
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(accentTimer)
      eyesRef.current?.classList.remove('beat')
      danceNode.style.transform = ''
      breatheNode.style.transform = ''
      groundNode.style.opacity = ''
      groundNode.style.transform = ''
      if (gazeNode) {
        gazeNode.style.transform = `translate(${gazeTarget.current.x}px, ${gazeTarget.current.y}px)`
      }
    }
  }, [danceActive, reduced, localActive, sense.bpm, sense.beatAt])

  return (
    <MemoFigure
      pose={shownPose}
      ariaLabel={ariaLabel}
      holding={props.holding}
      dancing={danceActive}
      mood={music}
      parts={parts}
    />
  )
}