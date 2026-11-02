# 器灵

桌宠。别的程序把写好的一句送到本机，器灵念出来。识局是第一个客户端。

产品方向与阶段性开发路线见[器灵开发计划](docs/development-plan.md)。
Spirit Protocol V1 的本机 WebSocket、配对、撤销、状态事件和 `siju.narrate_current` 已通过实现与桌面验收。TypeScript 客户端 SDK 及参考示例也已通过阶段 4 验收，说明见 [SDK README](sdk/typescript/README.md)；阶段 5 的 VS Code Connector 已实现并可打包，桌面验收和语音闭环仍待完成，见 [Connector README](connectors/vscode/README.md)。

只听 `127.0.0.1:8766`，可用 `QILING_PORT` 改。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/health` | `{ "ok": true, "name": "器灵" }` |
| POST | `/v1/say` | `{ "source", "phase": "thinking" \| "say" \| "idle", "text", "mood": "neutral" \| "up" \| "down" }` |
| POST | `/v1/cancel` | 停止正在读的那句 |
| GET | `/docs` | Swagger UI，可在页面上直接试 |
| GET | `/openapi.yaml` | 协议原文（OpenAPI 3.1） |

`thinking` 不张嘴。`mood` 决定优势、劣势或讲解。静音和收起气泡在宠物自己的气泡上。

现有 HTTP 接口以 `docs/openapi.yaml` 为准，Swagger UI 资源内嵌在程序里，离线也能看：启动器灵后打开 `http://127.0.0.1:8766/docs`（改过 `QILING_PORT` 就换成对应端口）。HTTP CORS 仅允许已知本机应用 Origin。动现有接口时，`docs/openapi.yaml` 和 `src-tauri/src/http.rs` 要一起改；Spirit WebSocket 当前只支持已文档化的 V1 客户端/能力子集，不应假设可调用任意应用 Action。

```bash
# Get-Process qiling -ErrorAction SilentlyContinue | Stop-Process -Force 
# $env:CARGO_TARGET_DIR = "C:\Users\telesoho\qiling-target-medium"
npm install
npm run tauri dev
```

`tauri dev` 要在普通（非沙箱）终端里跑，并先关掉已经在跑的器灵：WebView2 需要在 `%LOCALAPPDATA%\com.qiling.pet\EBWebView` 建用户数据目录，目录被占用或被沙箱限制写入时都会以 `0x800700AA` / `0x8000FFFF` 启动失败。

浏览器里看姿势：`http://localhost:1421/?pet=1`，加上 `&phase=say&mood=up&text=这步不错` 看说话；加 `&track=shiju-butterfly` 锁定任一条运行时轨。按住器灵拖拽会播吊起、悬空跟手，松手播落下；浏览器预览里窗口不动，动画照播。

桌宠的动画轨从 `design/anim/tracks.manifest.json` 生成：`npm run bake:anim` 会写出 `public/pet/anim/`（`dev`/`build`/`test` 前自动执行）。

### 播报声音

器灵默认使用 Edge 在线语音；“自动”模式在 Edge TTS 不可用或合成失败时改用 Windows 系统语音。也可以在设定中固定选择 Edge、Windows 系统语音或本机 CosyVoice。CosyVoice 权重目录先找 `com.qiling.pet`，没有再读已经装好的 `com.siju.app/cosyvoice`；环境变量先认 `QILING_COSYVOICE_*`，没有再用 `SIJU_COSYVOICE_*`。

Edge 使用 Rust `edge-tts-rust` 连接 Edge Read Aloud 在线服务，不需要安装 Python。默认中文音色是 `zh-CN-XiaoxiaoNeural`；在器灵设定中点“读取 Edge 音色”可刷新中文音色列表并选择其他声音。Edge 不可用时，播报会回退到 Windows 系统语音。

**隐私提示：**自动模式及 Edge 音色会把器灵要朗读的文本发送到在线语音服务。麦克风音频和其他应用数据不会发送给 Edge。要完全离线播报，请选择“本机 CosyVoice”或“Windows 系统语音”。设定页会显示此联网行为。

```bash
python scripts/setup_cosyvoice.py
python scripts/start_cosyvoice.py
```

### 多角色音色

服务只加载一份 CosyVoice 3 权重，角色是服务内的音色预设。默认音色仍是 `child-girl-zero-shot`，参考音继续按上面的环境变量 / 应用数据目录解析；额外音色放在 `%APPDATA%\com.qiling.pet\cosyvoice\voices\<voice_id>\`（`meta.json` + `prompt.wav`），启动时扫描并逐个调用 `add_zero_shot_spk` 从 `prompt.wav` 重新提取嵌入，注册进模型。这里不写 `embedding.pt`，避免换模型版本后读到旧缓存。合成请求只带音色 id，不重复上传参考音。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/voices` | 注册音色，`multipart/form-data`：`prompt_text` + `prompt_audio`，可选 `voice_id`、`name`、`description`、`tags` |
| `GET` | `/v1/voices` | 列出全部音色和 `defaultVoice` |
| `GET` | `/v1/voices/{voice_id}` | 查单个音色 |
| `PATCH` | `/v1/voices/{voice_id}` | 改显示名、说明、标签 |
| `PUT` | `/v1/voices/{voice_id}/prompt` | 替换参考音并重新注册 |
| `DELETE` | `/v1/voices/{voice_id}` | 删除音色；内置音色返回 400 `builtin_voice` |
| `POST` | `/v1/voices/{voice_id}/default` | 设为默认音色 |
| `POST` | `/v1/audio/speech` | 合成；新增可选 `voice`（或 `voice_id`），缺省用默认音色 |

```bash
# 注册：3–10 秒单人干声；wav/mp3/m4a，1–30 秒，最大 10 MB
curl -F voice_id=pet-a -F name=宠物A -F prompt_text='今天想先看棋盘上的这一步。' \
  -F tags='宠物,旁白' -F prompt_audio=@pet-a.wav http://127.0.0.1:8765/v1/voices

curl http://127.0.0.1:8765/v1/voices

curl -H 'Content-Type: application/json' \
  -d '{"input":"红方略优。","voice":"pet-a","request_id":1,"stream":true}' \
  http://127.0.0.1:8765/v1/audio/speech
```

`prompt_text` 必须和参考音严格对应，限 1–500 字；音频按魔数校验，不看扩展名。mp3/m4a 用 CosyVoice 环境里已有的 soundfile/torchaudio/librosa 解码，缺解码器时会提示改用 wav。`voice_id` 只允许 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，防止路径穿越。找不到请求里的 `voice` 时返回 404 `voice_not_found`，不会静默回落到默认音色。流式和整段响应都带 `X-Voice-Id`，走默认时也能确认实际用了哪个音色。`GET /v1/health` 的 `voice` 保留为默认音色，新增 `defaultVoice` 和 `voiceCount`；health 可能被轮询，不返回完整音色列表。合成、注册、删除共用一把推理锁，注册是同步的（提取嵌入几百 ms 到几秒），桌面宠物不需要任务队列。注册请求体上限约 10 MB，合成仍保持 16 KB。

### 说话卡壳时

宠物说话“卡壳”多半不是算力不够，而是首包等太久，或者一句太长把延迟拖长。服务现在默认做了这些事，并且在 stderr 为每一句打印一行 `voice=… chars=… chunks=… first=…ms rtf=…`：

- **流式是默认路径**：器灵请求里带 `stream: true`，服务每合成一块就回一块 PCM（`0x01` 帧，结束 `0x00`），播放端边收边播，不等整句合成完。
- **CUDA 上默认 fp16 autocast**：`QILING_COSYVOICE_FP16=0` 关掉，`=1` 强制开；也可以用 `--fp16` / `--fp32`。这里用上游的 autocast，而不是把权重 `.half()`：CosyVoice3 的 frontend 特征和 HiFT/F0 路径给的是 float32，裸 `.half()` 会撞 dtype；autocast 只让矩阵乘和卷积走半精度，省的是激活和算力，权重仍留 fp32。
- **启动时先预热一句**（`QILING_COSYVOICE_WARMUP=0` 可关）：cuDNN/cuBLAS 的首次自动调优和显存增长算在启动里，不算在第一句台词上。
- **每句按标点切成不超过 48 字**（`QILING_COSYVOICE_UTTERANCE_CHARS` 可改，最小 8）：自回归前缀和声码器窗口有上限，第一块音频更早出来，长句也不会“越说越慢”。
- **显存碎片**：没设过 `PYTORCH_CUDA_ALLOC_CONF` 时设为 `expandable_segments:True`，8GB 卡上少一次长句分配失败。
- **单请求串行**：一把推理锁，不做批处理，桌面宠物没有并发可批。

还是卡就先看那行日志：`first` 大是首包问题，`rtf` 持续大于 1 说明这张卡跟不上，得换后端（llama.cpp 的 GGUF，或在 Ampere 及更新的卡上试 TensorRT）。0.5B 的模型不值得上 8-bit 量化，权重本来只有 1–2GB，量化的计算开销抵不过显存收益。

可选的唤醒词与中文识别使用本机 sherpa-onnx。语音识别文字会发送给设定页中选择的对话模型；默认是本机 Ollama，也可使用 DeepSeek 或自定义 OpenAI 兼容云端服务。云端服务只接收识别文字，不会收到麦克风音频。安装前请审阅依赖和模型的上游许可；安装会下载模型，但不会打开麦克风：

```powershell
python scripts/setup_voice_assistant.py
ollama list
```

唤醒词与中文识别需要 64 位 Python 3.12；Ollama 服务和默认模型 `qwen3.5:4b` 仅在选择本机 Ollama 时需要。语音运行时安装在器灵自己的应用数据目录；模型下载中断后可重新运行脚本，脚本会尝试从已下载位置续传。启动器灵后，在“设定”中可选择对话模型和播报声音，也可设置 2–8 个连续汉字作为自定义唤醒词（默认“器灵”），然后手动启用“唤醒词监听（麦克风）”。唤醒词按拼音而不是汉字匹配：本机关键词检测器用的就是拼音（声母+韵母）词表，所以同音字本来就无法区分；程序还会把唤醒词的近音读法（zh/z、ch/c、sh/s、n/l、j/q 等声母相近，以及 ing/in、eng/en、ang/an 等韵母相近）一起写入关键词表，因此把“七零七零”听成“麒麟麒麟”“七凌七凌”也能命中；如果关键词检测器漏检，本机识别出的整句转写会再按拼音比对一次唤醒词，声调说错（七/欺/其）同样可以唤醒，但整句必须就是唤醒词，句子中间出现唤醒词不会触发。sherpa-onnx 的关键词检测接口不提供热词偏置，唤醒词只靠上述关键词表与本机兜底生效。选择本机 Ollama 时，“模型名称”会读取 `ollama list` 里已安装且可对话的模型供下拉选择，也可点“刷新已安装模型”重新读取；DeepSeek 与自定义 OpenAI 兼容服务仍手填模型名。播报声音旁有“试听”，会用当前选择的 Edge 在线语音、本机 CosyVoice 或 Windows 系统语音读一句示例。DeepSeek 与自定义 OpenAI 兼容服务要求 HTTPS；API 密钥保存在 Windows 凭据管理器。启用唤醒监听时会明确告知语音识别文字将发送到所选的云端服务，音频始终只在本机处理。检测到唤醒词后，器灵会先说“我在，请说。”，回应播放完毕后才开始识别你的问题，避免把器灵自己的回应识别进去。对话按半双工状态机运行：器灵说话时麦克风不再送入唤醒词检测，只保留用于插话的识别，并把与正在播报的文稿高度重合的结果当作扬声器回声丢弃；说话结束后先静音约 0.4 秒让尾音消散，再恢复对话，因此不会把自己的回答当成新问题。唤醒后器灵会保持对话状态，5 分钟内可以直接追问、不必再说唤醒词；连续 5 分钟没有新问题，才回到只监听唤醒词的非唤醒状态。回答期间说“停”“等一下”可以打断播报，直接说新问题也能插话。本机 ASR 转写和 KWS 命中结果会写入 `%APPDATA%\com.qiling.pet\voice-assistant\voice-assistant.log`，并轮换保留最多 4 个日志文件。隐藏宠物或关闭监听会停止语音子进程并关闭麦克风；再次显示器灵时，只要开关仍然打开，就会自动恢复监听，开关本身保留你的选择。若不希望下次启动自动恢复监听，请在退出前关闭此开关。

器灵常驻系统托盘。左键单击托盘图标或使用托盘菜单可在“显示器灵/隐藏器灵”之间切换，菜单里也有“设定…”和“退出器灵”。关闭器灵窗口现在只是隐藏宠物，要真正退出请用托盘菜单的“退出器灵”。

## 测试

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
python -m unittest discover -s scripts -p "test_*.py"
```
