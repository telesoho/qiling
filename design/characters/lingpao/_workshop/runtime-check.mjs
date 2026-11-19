// Runtime check for 灵泡: screenshots + motion assertions against the live preview.
//
// Prerequisites:
//   1. `npm run dev` (Vite on http://localhost:1421)
//   2. headless Chrome with CDP on 9223:
//      chrome --headless=new --remote-debugging-port=9223 \
//        --user-data-dir=%TEMP%\qiling-chrome --autoplay-policy=no-user-gesture-required about:blank
//
// Usage: node design/characters/lingpao/_workshop/runtime-check.mjs [outDir]
// Writes app-{idle,calm,groove,intense,shiju}.png and prints motion assertions.
import fs from 'node:fs'

const outDir = process.argv[2] || '.'
const CDP = 'http://127.0.0.1:9223'
const APP = 'http://localhost:1421/?pet=1'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = await (await fetch(`${CDP}/json`)).json()
const page = targets.find((entry) => entry.type === 'page')
if (!page) throw new Error('no CDP page target; start Chrome with --remote-debugging-port=9223')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const errors = []
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(String(message.params?.exceptionDetails?.text || ''))
  }
  if (!message.id || !pending.has(message.id)) return
  const job = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) job.reject(new Error(JSON.stringify(message.error)))
  else job.resolve(message.result)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.result && result.result.value
}
const navigate = async (url) => {
  await send('Page.navigate', { url })
  await sleep(1400)
}

await new Promise((resolve) => {
  ws.onopen = resolve
})
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 320,
  height: 420,
  deviceScaleFactor: 2,
  mobile: false,
})
fs.mkdirSync(outDir, { recursive: true })

const cases = [
  ['app-idle.png', APP],
  ['app-calm.png', `${APP}&music=calm`],
  ['app-groove.png', `${APP}&music=groove`],
  ['app-intense.png', `${APP}&music=intense`],
  ['app-shiju.png', `${APP}&character=shiju`],
]
const origins = {}
for (const [name, url] of cases) {
  await navigate(url)
  const info = await evaluate(`(() => {
    const svg = document.querySelector('.lingpao');
    const dance = document.querySelector('.lp-dance');
    return JSON.stringify({
      aria: svg && svg.getAttribute('aria-label'),
      classes: svg && svg.getAttribute('class'),
      phones: !!document.querySelector('.lp-phones.on'),
      notes: !!document.querySelector('.lp-notes.on'),
      cheeks: !!document.querySelector('.lp-cheeks.on'),
      img: document.querySelector('.pet-sprite img')?.getAttribute('src') || null,
      danceOrigin: dance ? getComputedStyle(dance).transformOrigin : null,
    });
  })()`)
  origins[name] = JSON.parse(info).danceOrigin
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`${outDir}/${name}`, Buffer.from(shot.data, 'base64'))
  console.log(name, info)
}

async function motion(music) {
  await navigate(`${APP}&music=${music}`)
  const frames = []
  for (let index = 0; index < 6; index += 1) {
    frames.push(
      JSON.parse(
        await evaluate(`(() => {
          const dance = document.querySelector('.lp-dance');
          const gaze = document.querySelector('.lp-gaze');
          return JSON.stringify({ dance: dance.style.transform, gaze: gaze.style.transform });
        })()`),
      ),
    )
    await sleep(180)
  }
  return frames
}

const yOf = (transform) => {
  const match = /translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px/.exec(transform || '')
  return match ? Number(match[2]) : 0
}

const groove = await motion('groove')
const intense = await motion('intense')
const calm = await motion('calm')
const checks = {
  'groove sways': new Set(groove.map((frame) => frame.dance)).size > 1,
  // SVG 分组不写 transform-origin 时默认绕 (0, 0)（画布左上角）旋转；
  // 摇摆必须绕身体底部 (90, 209)，和原型 #dance 的支点一致。
  'sway pivots at the body base': origins['app-groove.png'] === '90px 209px',
  'groove never hops': groove.every((frame) => yOf(frame.dance) === 0),
  'intense hops on beats': intense.some((frame) => yOf(frame.dance) < -0.5),
  'calm stays near rest': calm.every((frame) => Math.abs(yOf(frame.dance)) <= 3.3),
  'gaze follows the beat': new Set(groove.map((frame) => frame.gaze)).size > 1,
  'no page errors': errors.length === 0,
}
console.log(checks)
if (Object.values(checks).some((value) => !value)) {
  process.exitCode = 1
}
ws.close()
setTimeout(() => process.exit(process.exitCode || 0), 100)