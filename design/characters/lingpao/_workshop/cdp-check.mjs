// Minimal Chrome DevTools Protocol driver: load the demo, feed it a local WAV,
// start playback, then report state + capture screenshots. No external deps.
import fs from 'node:fs';
const [,, wsUrl, pageUrl, wavPath, outDir] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const job = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) job.reject(new Error(JSON.stringify(msg.error)));
  else job.resolve(msg.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (expression, extra = {}) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, ...extra });
  return r.result && r.result.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}`, Buffer.from(r.data, 'base64'));
};

await new Promise((resolve) => { ws.onopen = resolve; });
await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: pageUrl });
await sleep(1800);

const doc = await send('DOM.getDocument', { depth: 1 });
const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [wavPath] });

let analysis = '';
const t0 = Date.now();
for (let i = 0; i < 240; i++) {
  analysis = await evalJs("document.getElementById('analyzeState').textContent");
  if (/分析完成|分析失败/.test(analysis || '')) break;
  await sleep(500);
}
console.log('ANALYZE_MS:', Date.now() - t0);
console.log('IDLE_PHONES:', await evalJs("document.getElementById('phones').className.baseVal || document.getElementById('phones').getAttribute('class')"));
await shot('cdp-idle.png');
console.log('ANALYZE:', analysis);
console.log('BPM:', await evalJs("document.getElementById('bpmValue').textContent"));
console.log('BEATS:', await evalJs("document.getElementById('beatValue').textContent"));

await evalJs("document.getElementById('audio').play()", { awaitPromise: true, userGesture: true });
await sleep(2600);
console.log('PLAYING:', await evalJs("JSON.stringify({paused:document.getElementById('audio').paused, t:+document.getElementById('audio').currentTime.toFixed(2), stage:document.getElementById('stageState').textContent, mood:document.getElementById('moodValue').textContent, beat:document.getElementById('beatState').textContent, energy:document.getElementById('energyFill').style.width, bass:document.getElementById('bassValue').textContent, time:document.getElementById('timeValue').textContent})"));
console.log('PLAY_PHONES:', await evalJs("document.getElementById('phones').getAttribute('class')"));
await shot('cdp-playing-1.png');
await sleep(900);
await shot('cdp-playing-2.png');
await sleep(900);
console.log('LATER:', await evalJs("JSON.stringify({t:+document.getElementById('audio').currentTime.toFixed(2), stage:document.getElementById('stageState').textContent, energy:document.getElementById('energyFill').style.width})"));
await shot('cdp-playing-3.png');

// preview buttons sanity check while the song is playing
await evalJs("document.querySelector('[data-mood=calm]').click()");
await sleep(700);
console.log('FORCED CALM:', await evalJs("JSON.stringify({stage:document.getElementById('stageState').textContent, mood:document.getElementById('moodValue').textContent, energy:document.getElementById('energyFill').style.width})"));
await shot('cdp-force-calm.png');
await evalJs("document.querySelector('[data-mood=auto]').click()");
await sleep(900);
console.log('BACK TO AUTO:', await evalJs("JSON.stringify({stage:document.getElementById('stageState').textContent, energy:document.getElementById('energyFill').style.width})"));
await shot('cdp-auto.png');

await evalJs("document.getElementById('audio').pause()");
await sleep(600);
console.log('PAUSE_PHONES:', await evalJs("document.getElementById('phones').getAttribute('class')"));
await shot('cdp-paused.png');
ws.close();
process.exit(0);