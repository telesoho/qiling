// 验证 lingpao-groove.html 的「系统声音」来源（浏览器 getDisplayMedia 路径）。
//
// 真机权限弹窗无法在无头浏览器里点，所以用 Page.addScriptToEvaluateOnNewDocument
// 注入一个假的 getDisplayMedia：返回「视频轨 + 128 BPM 底鼓脉冲音频轨」的 MediaStream，
// 其余全部走原型自己的代码路径（AudioContext → AnalyserNode → 实时估速 → 三档）。
//
// 前置：
//   1. 仓库根起静态服务：python -m http.server 8766 --bind 127.0.0.1
//   2. 无头 Chrome：chrome --headless=new --remote-debugging-port=9333 \
//        --user-data-dir=%TEMP%\qiling-chrome-groove about:blank
// 用法：
//   node design/characters/lingpao/_workshop/cdp-system-audio.mjs <wsUrl> <pageUrl> <wavPath> [outDir]
import fs from 'node:fs'

const [wsUrl, pageUrl, wavPath, outDir = 'design/characters/lingpao/_workshop/system-audio'] =
  process.argv.slice(2)
if (!wsUrl || !pageUrl || !wavPath) {
  throw new Error('usage: cdp-system-audio.mjs <wsUrl> <pageUrl> <wavPath> [outDir]')
}
fs.mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ws = new WebSocket(wsUrl)
let nextId = 0
const pending = new Map()
const pageErrors = []
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(String(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || ''))
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
const evaluate = async (expression, extra = {}) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, ...extra })
  return result.result && result.result.value
}
const shot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(`${outDir}/${name}`, Buffer.from(result.data, 'base64'))
}
const checks = {}
const check = (name, passed, detail = '') => {
  checks[name] = passed
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const stub = `(() => {
  if (!navigator.mediaDevices) return;
  navigator.mediaDevices.getDisplayMedia = async () => {
    if (window.__lpStubReject) throw new DOMException('Permission denied', 'NotAllowedError');
    window.__lpStubCalled = (window.__lpStubCalled || 0) + 1;
    const ac = new AudioContext();
    await ac.resume().catch(() => {});
    const dest = ac.createMediaStreamDestination();
    const master = ac.createGain();
    master.gain.value = 1;
    master.connect(dest);
    // 持续的低电平铺底，模拟真实音乐在鼓点之间也有声压（否则静音判定会反复清零）。
    const pad = ac.createOscillator();
    const padGain = ac.createGain();
    pad.type = 'sawtooth';
    pad.frequency.value = 110;
    padGain.gain.value = 0.035;
    pad.connect(padGain);
    padGain.connect(master);
    pad.start();
    // 带扫频与瞬态噪声的底鼓 + 反拍踩镲，接近真实音乐的低频起音。
    const noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.12), ac.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < noiseData.length; i += 1) {
      noiseData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / noiseData.length, 3);
    }
    const kick = (time) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.13);
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(0.95, time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);
      osc.connect(gain);
      gain.connect(master);
      osc.start(time);
      osc.stop(time + 0.26);
      const click = ac.createBufferSource();
      const clickGain = ac.createGain();
      click.buffer = noise;
      clickGain.gain.setValueAtTime(0.55, time);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      click.connect(clickGain);
      clickGain.connect(master);
      click.start(time);
    };
    const hat = (time) => {
      const source = ac.createBufferSource();
      const highpass = ac.createBiquadFilter();
      const gain = ac.createGain();
      source.buffer = noise;
      highpass.type = 'highpass';
      highpass.frequency.value = 6000; // 踩镲走高频，不让低频段误判成第二个鼓点
      gain.gain.setValueAtTime(0.16, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
      source.connect(highpass);
      highpass.connect(gain);
      gain.connect(master);
      source.start(time);
    };
    const beat = 0.46875; // 128 BPM
    let nextKick = ac.currentTime;
    const timer = setInterval(() => {
      while (nextKick < ac.currentTime + 0.6) {
        kick(nextKick);
        hat(nextKick + beat / 2);
        nextKick += beat;
      }
    }, 200);
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const videoTracks = canvas.captureStream(1).getVideoTracks();
    const stream = new MediaStream([...videoTracks, ...dest.stream.getAudioTracks()]);
    [...videoTracks, ...dest.stream.getAudioTracks()].forEach((track) => {
      track.addEventListener('ended', () => clearInterval(timer));
    });
    return stream;
  };
})();`

await new Promise((resolve) => { ws.onopen = resolve })
await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: stub })
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false })

const uiState = () =>
  evaluate(`JSON.stringify({
    source: document.querySelector('.source-option.is-on')?.id || '',
    dropHidden: document.getElementById('dropZone').hidden,
    listenHidden: document.getElementById('listenButton').hidden,
    listening: document.getElementById('listenButton').classList.contains('is-listening'),
    listenTitle: document.getElementById('listenTitle').textContent,
    playDisabled: document.getElementById('playButton').disabled,
    volumeDisabled: document.getElementById('volume').disabled,
    playerHidden: document.getElementById('player').hidden,
    beatLabel: document.getElementById('beatLabel').textContent,
    timeLabel: document.getElementById('timeLabel').textContent,
    time: document.getElementById('timeValue').textContent,
    bpm: document.getElementById('bpmValue').textContent.trim(),
    beat: document.getElementById('beatValue').textContent.trim(),
    beatState: document.getElementById('beatState').textContent,
    stage: document.getElementById('stageState').textContent,
    mood: document.getElementById('moodValue').textContent,
    energy: document.getElementById('energyValue').textContent,
    engine: document.getElementById('engineLabel').textContent,
    analyze: document.getElementById('analyzeState').textContent,
    phonesOn: document.getElementById('phones').classList.contains('on'),
    notesOn: document.getElementById('notes').classList.contains('on'),
    wave: document.getElementById('waveCaption').textContent,
    tempoHint: document.getElementById('tempoHint').textContent
  })`).then(JSON.parse)

// 1) 默认本地音乐来源
await send('Page.navigate', { url: pageUrl })
await sleep(1600)
let state = await uiState()
check('file source is default', state.source === 'sourceFile' && !state.dropHidden && state.listenHidden, state.source)
check('file player disabled before load', state.playDisabled === true)
await shot('01-file-default.png')

// 2) 切到系统声音
await evaluate("document.getElementById('sourceSystem').click()")
await sleep(400)
state = await uiState()
check('system source hides upload', state.source === 'sourceSystem' && state.dropHidden === true && state.listenHidden === false)
check('system player is disabled', state.playDisabled && state.volumeDisabled, `play=${state.playDisabled} volume=${state.volumeDisabled}`)
check('system hides file player', state.playerHidden === true && state.beatLabel === 'Live beats', `hidden=${state.playerHidden} label=${state.beatLabel}`)
check('system label swaps to listening time', state.timeLabel === '聆听时长', state.timeLabel)
check('system idle copy', state.stage.includes('系统声音') && state.bpm.replace(/\s/g, '') === '—BPM', `${state.stage} / ${state.bpm}`)
await shot('02-system-idle.png')

// 3) 开始聆听（桩流：128 BPM 底鼓）
await evaluate("document.getElementById('listenButton').click()", { userGesture: true, awaitPromise: true })
await sleep(700)
state = await uiState()
check('capture started', state.listening === true && state.listenTitle.includes('正在聆听'), state.listenTitle)
check('track row is system live', state.engine.includes('系统声音'))
await sleep(4000)
state = await uiState()
const bpmNumber = Number((state.bpm.match(/([\d.]+)\s*BPM/) || [])[1] || 0)
check('mood leaves idle', state.mood !== '待机 · 呼吸中', state.mood)
check('headphones on while listening', state.phonesOn === true, String(state.phonesOn))
check('live BPM estimated ~128', bpmNumber >= 112 && bpmNumber <= 144, state.bpm)
check('energy reacts', state.energy !== '0%', state.energy)
check('listening time advances', state.time !== '00:00', state.time)
check('beat state tracks live onsets', state.beatState.includes('跟拍') || state.beatState.includes('左右') || state.beatState.includes('轻跳'), state.beatState)
check('live beat counter advances', Number(state.beat) > 0, `${state.beatLabel}=${state.beat}`)
check('system tempo hint is live', state.tempoHint.includes('实时'), state.tempoHint)
await shot('03-system-playing.png')

// 4) 停止聆听
await evaluate("document.getElementById('listenButton').click()")
await sleep(500)
state = await uiState()
check('capture stopped', state.listening === false && state.listenTitle.includes('开始聆听'), state.listenTitle)
check('stops back to idle', state.mood.includes('待机'), state.mood)
check('stop copy', state.engine.includes('已停止'), state.engine)
check('headphones off after stop', state.phonesOn === false, String(state.phonesOn))
await shot('04-system-stopped.png')

// 5) 取消分享的错误路径
await evaluate('window.__lpStubReject = true')
await evaluate("document.getElementById('listenButton').click()", { userGesture: true, awaitPromise: true })
await sleep(500)
state = await uiState()
check('cancel shows friendly error', state.analyze.includes('没有开始聆听'), state.analyze)
check('cancel keeps idle copy', state.stage.includes('待聆听') && state.engine.includes('未开始'), `${state.stage} / ${state.engine}`)
await evaluate('window.__lpStubReject = false')
await shot('05-system-cancel.png')

// 6) 切回本地音乐并播放（回归）
await evaluate("document.getElementById('sourceFile').click()")
await sleep(400)
state = await uiState()
check('switch back restores upload UI', state.source === 'sourceFile' && state.dropHidden === false && state.listenHidden === true)
check('switch back restores player', state.playDisabled === true && state.volumeDisabled === false && state.playerHidden === false && state.beatLabel === 'Beat points', `hidden=${state.playerHidden} label=${state.beatLabel}`)
const doc = await send('DOM.getDocument', { depth: 1 })
const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' })
await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wavPath] })
for (let i = 0; i < 120; i++) {
  const analyze = await evaluate("document.getElementById('analyzeState').textContent")
  if (/分析完成|分析失败/.test(analyze || '')) break
  await sleep(250)
}
await evaluate("document.getElementById('audio').play()", { awaitPromise: true, userGesture: true })
await sleep(2200)
state = await uiState()
check('file playback still works after switching', state.mood !== '待机 · 呼吸中' && state.phonesOn === true, state.mood)
check('file BPM analysis still shown', /BPM/.test(state.bpm) && !state.bpm.startsWith('—'), state.bpm)
await shot('06-file-after-switch.png')
await evaluate("document.getElementById('audio').pause()")
await sleep(300)

// 6b) 本地整曲分析在「来源往返」后保留，不需要重新解码
const bpmBefore = await evaluate("document.getElementById('bpmValue').textContent.trim()")
await evaluate("document.getElementById('sourceSystem').click()")
await sleep(300)
await evaluate("document.getElementById('sourceFile').click()")
await sleep(300)
const bpmAfter = await evaluate("document.getElementById('bpmValue').textContent.trim()")
check('file analysis survives source round-trip', bpmBefore === bpmAfter && !/^—/.test(bpmAfter), `${bpmBefore} -> ${bpmAfter}`)
state = await uiState()
check('round-trip keeps beat points', state.beat !== '—', state.beat)

// 7) 移动端布局
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await send('Page.navigate', { url: `${pageUrl}?source=system` })
await sleep(1600)
await evaluate("document.getElementById('listenButton').click()", { userGesture: true, awaitPromise: true })
await sleep(2300)
await shot('07-system-mobile.png')
state = await uiState()
check('mobile source query works', state.source === 'sourceSystem' && state.listening === true, state.listenTitle)
await evaluate("document.getElementById('listenButton').click()")
await sleep(300)

check('no page exceptions', pageErrors.length === 0, pageErrors.join(' | '))
ws.close()
const failed = Object.entries(checks).filter(([, passed]) => !passed)
console.log(`\n${Object.keys(checks).length - failed.length}/${Object.keys(checks).length} checks passed`)
process.exit(failed.length ? 1 : 0)
