import fs from 'node:fs';
const [,, wsUrl, pageUrl, outPng] = process.argv;
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
await new Promise((resolve) => { ws.onopen = resolve; });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: pageUrl });
await sleep(2200);
const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({w: innerWidth, mq420: matchMedia('(max-width:420px)').matches, mq780: matchMedia('(max-width:780px)').matches, scrollW: document.documentElement.scrollWidth, shell: document.querySelector('.shell').getBoundingClientRect().width, stage: document.querySelector('.stage').getBoundingClientRect().width})`,
  returnByValue: true,
});
console.log(info.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
ws.close();
process.exit(0);