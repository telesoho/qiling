# 器灵

桌宠。别的程序把写好的一句送到本机，器灵念出来。识局是第一个客户端。

只听 `127.0.0.1:8766`，可用 `QILING_PORT` 改。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/health` | `{ "ok": true, "name": "器灵" }` |
| POST | `/v1/say` | `{ "source", "phase": "thinking" \| "say" \| "idle", "text", "mood": "neutral" \| "up" \| "down" }` |
| POST | `/v1/cancel` | 停止正在读的那句 |

`thinking` 不张嘴。`mood` 决定优势、劣势或讲解。静音和收起气泡在宠物自己的气泡上。

```bash
npm install
npm run tauri dev
```

浏览器里看姿势：`http://localhost:1421/?pet=1`，加上 `&phase=say&mood=up&text=这步不错`。

语音优先走本机 CosyVoice。权重目录先找 `com.qiling.pet`，没有再读已经装好的 `com.siju.app/cosyvoice`。环境变量先认 `QILING_COSYVOICE_*`，没有再用 `SIJU_COSYVOICE_*`。

```bash
python scripts/setup_cosyvoice.py
python scripts/start_cosyvoice.py
```

## 测试

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```
