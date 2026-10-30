# 器灵

桌宠。别的程序把写好的一句送到本机，器灵念出来。识局是第一个客户端。

只听 `127.0.0.1:8766`，可用 `QILING_PORT` 改。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/health` | `{ "ok": true, "name": "器灵" }` |
| POST | `/v1/say` | `{ "source", "phase": "thinking" \| "say" \| "idle", "text", "mood": "neutral" \| "up" \| "down" }` |
| POST | `/v1/cancel` | 停止正在读的那句 |
| GET | `/docs` | Swagger UI，可在页面上直接试 |
| GET | `/openapi.yaml` | 协议原文（OpenAPI 3.1） |

`thinking` 不张嘴。`mood` 决定优势、劣势或讲解。静音和收起气泡在宠物自己的气泡上。

协议以 `docs/openapi.yaml` 为准，Swagger UI 资源内嵌在程序里，离线也能看：启动器灵后打开 `http://127.0.0.1:8766/docs`（改过 `QILING_PORT` 就换成对应端口）。动接口时，`docs/openapi.yaml` 和 `src-tauri/src/http.rs` 要一起改。

```bash
npm install
npm run tauri dev
```

`tauri dev` 要在普通（非沙箱）终端里跑，并先关掉已经在跑的器灵：WebView2 需要在 `%LOCALAPPDATA%\com.qiling.pet\EBWebView` 建用户数据目录，目录被占用或被沙箱限制写入时都会以 `0x800700AA` / `0x8000FFFF` 启动失败。

浏览器里看姿势：`http://localhost:1421/?pet=1`，加上 `&phase=say&mood=up&text=这步不错` 看说话；加 `&track=shiju-butterfly` 锁定任一条运行时轨。按住器灵拖拽会播吊起、悬空跟手，松手播落下；浏览器预览里窗口不动，动画照播。

桌宠的动画轨从 `design/anim/tracks.manifest.json` 生成：`npm run bake:anim` 会写出 `public/pet/anim/`（`dev`/`build`/`test` 前自动执行）。

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
