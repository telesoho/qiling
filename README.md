# 器灵

器灵是一只本机桌宠：别的程序把一句话送到本机，器灵就会在桌面上念出来。识局是它的第一个客户端。

如果你想了解产品方向和阶段性路线，请看 [器灵开发计划](docs/development-plan.md)。

## 1. 项目概览

- 目标：把语音与桌宠动画组合成一个本地运行的“会说话的桌宠”。
- 当前完成情况：
  - 默认角色为灵泡（SVG 动态骨架）；诗琚保留为第二内置角色。
  - 灵泡可以听系统正在播放的音乐，先区分音乐与人声，再在本机分析节拍后自动切换「舒缓 / 轻快 / 激烈」并跟着节拍摇摆。
  - Spirit Protocol V1 的本机 WebSocket、配对、撤销、状态事件和 Action 闭环已通过实现和桌面验收。
  - 客户端语音口令已改为按声明的 Action 元数据动态发现；新客户端接入后无需修改器灵代码。
  - TypeScript 客户端 SDK 和参考示例已通过阶段 4 验收，见 [SDK README](sdk/typescript/README.md)。
  - VS Code Connector 已实现并可打包，见 [Connector README](connectors/vscode/README.md)。
  - 语音闭环与第二客户端（VS Code）已通过阶段 5 验收；下一阶段见开发计划「阶段 6：产品化可试用」。

## 2. 本机接口

监听地址默认是 `127.0.0.1:8766`，可通过环境变量 `QILING_PORT` 修改。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/v1/health` | 健康检查：返回 `{ "ok": true, "name": "器灵" }` |
| POST | `/v1/say` | 让器灵朗读文本，参数包含 `source`、`phase`、`text`、`mood` |
| POST | `/v1/cancel` | 停止当前正在朗读的内容 |
| GET | `/docs` | Swagger UI，可直接在浏览器里试接口 |
| GET | `/openapi.yaml` | 协议原文（OpenAPI 3.1） |

接口参数说明：

- `phase`：`thinking`、`say`、`idle`
  - `thinking` 表示思考中，不张嘴。
- `mood`：`neutral`、`up`、`down`
  - 用于决定动画表情与说话状态，例如优势、劣势、讲解。
- `source`：调用来源标识。

> 现有 HTTP 接口以 `docs/openapi.yaml` 为准，Swagger UI 资源内嵌在程序中，离线也能查看。启动器灵后，可在浏览器访问 `http://127.0.0.1:8766/docs`（如果改过 `QILING_PORT`，请使用对应端口）。

> HTTP CORS 仅允许已知的本机应用 Origin。修改现有接口时，需同步更新 `docs/openapi.yaml` 和 `src-tauri/src/http.rs`。

> Spirit WebSocket 支持经用户配对批准、无参数、`no_state_change` 的 Action，并从中动态生成语音口令；客户端仍不能调用任意应用 Action，语音口令也不构成授权。

## 3. 本地开发与运行

```bash
# 如果已有 qiling 进程在跑，可先关闭
# Get-Process qiling -ErrorAction SilentlyContinue | Stop-Process -Force
# $env:CARGO_TARGET_DIR = "C:\Users\telesoho\qiling-target-medium"

npm install
npm run tauri dev
```

注意事项：

- `tauri dev` 必须在普通（非沙箱）终端中运行。
- 先关闭已经在运行的器灵，否则可能出现 WebView2 启动失败。
- WebView2 需要在 `%LOCALAPPDATA%\com.qiling.pet\EBWebView` 下创建用户数据目录；如果目录被占用，或者沙箱限制写入，就可能报 `0x800700AA` / `0x8000FFFF` 启动错误。

### 浏览器预览

- 预览地址：`http://localhost:1421/?pet=1`
- 例如：
  - `&phase=say&mood=up&text=这步不错`：查看说话状态
  - `&track=shiju-butterfly`：锁定某一条运行时轨道（仅位图角色）
  - `&character=shiju`：在浏览器里切换到诗琚；默认是灵泡
  - `&music=calm` / `&music=groove` / `&music=intense`：强制音乐档位预览，不采集系统声音
- 拖拽器灵时会播放“吊起 / 悬空跟手 / 落下”的动画；浏览器预览时窗口本身不动，但动画会照常播放。

### 动画轨道生成

桌宠动画轨来自 `design/anim/tracks.manifest.json`，执行：

```bash
npm run bake:anim
```

它会输出到 `public/pet/anim/`。`dev` / `build` / `test` 前会自动执行。

## 4. 播报声音

### 默认语音方案

器灵默认使用 Edge 在线语音；在“自动”模式中，如果 Edge TTS 不可用或合成失败，会回退到 Windows 系统语音。

也可在设置中固定选择：

- Edge
- Windows 系统语音
- 本机 CosyVoice

CosyVoice 的权重目录优先查找 `com.qiling.pet`，如果不存在，则回退到已安装的 `com.siju.app/cosyvoice`；环境变量优先使用 `QILING_COSYVOICE_*`，未设置时再尝试 `SIJU_COSYVOICE_*`。

### Edge TTS

- 通过 Rust `edge-tts-rust` 连接 Edge Read Aloud 在线服务，不需要安装 Python。
- 默认中文音色：`zh-CN-XiaoxiaoNeural`
- 在器灵设置中，可点击“读取 Edge 音色”刷新中文音色列表，并选择别的声音。
- Edge 不可用时会自动回退到 Windows 系统语音。

### 隐私提示

**重要：**自动模式和 Edge 音色会把器灵要朗读的文本发送到在线语音服务。麦克风音频和其他应用数据不会发送给 Edge。

如果你想完全离线播报，请选：

- “本机 CosyVoice”
- “Windows 系统语音”

设置页会明确显示联网行为。

```bash
python scripts/setup_cosyvoice.py
python scripts/start_cosyvoice.py
```

## 5. 多角色音色

服务只加载一份 CosyVoice 3 权重，角色是服务内的音色预设。默认音色仍然是 `child-girl-zero-shot`。

参考音按以下顺序解析：

1. `QILING_COSYVOICE_*` / `SIJU_COSYVOICE_*`
2. 应用数据目录中的已有权重目录
3. 默认路径

额外音色会放在：

`%APPDATA%\com.qiling.pet\cosyvoice\voices\<voice_id>\`

其中包含：

- `meta.json`
- `prompt.wav`

启动时会扫描这些目录，并逐个调用 `add_zero_shot_spk` 从 `prompt.wav` 中重新提取嵌入并注册进模型。这里不写 `embedding.pt`，这样在更换模型版本后，不会读到过期缓存。

合成请求只带音色 ID，不重复上传参考音。

### 语音 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/voices` | 注册音色，`multipart/form-data`：`prompt_text` + `prompt_audio`，可选 `voice_id`、`name`、`description`、`tags` |
| `GET` | `/v1/voices` | 列出全部音色和 `defaultVoice` |
| `GET` | `/v1/voices/{voice_id}` | 查看单个音色 |
| `PATCH` | `/v1/voices/{voice_id}` | 修改显示名、说明、标签 |
| `PUT` | `/v1/voices/{voice_id}/prompt` | 替换参考音并重新注册 |
| `DELETE` | `/v1/voices/{voice_id}` | 删除音色；内置音色会返回 `400 builtin_voice` |
| `POST` | `/v1/voices/{voice_id}/default` | 设为默认音色 |
| `POST` | `/v1/audio/speech` | 合成语音；新增可选 `voice`（或 `voice_id`），默认使用当前默认音色 |

```bash
# 注册：3–10 秒单人干声；支持 wav/mp3/m4a；单次 1–30 秒，最大 10 MB
curl -F voice_id=pet-a -F name=宠物A -F prompt_text='今天想先看棋盘上的这一步。' \
  -F tags='宠物,旁白' -F prompt_audio=@pet-a.wav http://127.0.0.1:8765/v1/voices

curl http://127.0.0.1:8765/v1/voices

curl -H 'Content-Type: application/json' \
  -d '{"input":"红方略优。","voice":"pet-a","request_id":1,"stream":true}' \
  http://127.0.0.1:8765/v1/audio/speech
```

细节说明：

- `prompt_text` 必须和参考音严格对应，长度限制为 1–500 字。
- 音频按魔数校验，不看扩展名。
- `mp3` / `m4a` 依赖 CosyVoice 环境中已有的 `soundfile` / `torchaudio` / `librosa`；如果缺少解码器，会提示改用 `wav`。
- `voice_id` 只允许 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`，用于避免路径穿越。
- 找不到请求里的 `voice` 时返回 `404 voice_not_found`，不会静默回落默认音色。
- 流式和整段响应都带 `X-Voice-Id`；即使走默认音色，也能确认实际使用了哪个音色。
- `GET /v1/health` 里的 `voice` 保留为默认音色，并新增 `defaultVoice` 和 `voiceCount`。Health 接口常用于轮询，因此不返回完整音色列表。
- 合成、注册、删除共用一把推理锁。注册是同步的（提取嵌入需要几百毫秒到几秒），桌面宠物不需要额外任务队列。
- 注册请求体上限约 10 MB；合成仍保持 16 KB 级别。

## 6. 说话卡壳时：常见优化点

宠物说话“卡壳”，大多数不是算力不够，而是首包等待过久，或一句话太长导致延迟变大。当前服务已默认做了这些优化，并在 stderr 中为每一句输出日志：

`voice=… chars=… chunks=… first=…ms rtf=…`

优化策略包括：

- 流式输出是默认路径：每合成一块就返回一块 PCM，播放端边收边播，不必等完整句子生成完。
- CUDA 默认启用 fp16 autocast：可通过 `QILING_COSYVOICE_FP16=0` 关闭，或 `=1` 强制打开；也支持 `--fp16` / `--fp32`。
- 启动时会预热一句：避免首次推理时把 cuDNN / cuBLAS 自动调优和显存增长计入第一句台词。
- 每句按标点切成不超过 48 字：可通过 `QILING_COSYVOICE_UTTERANCE_CHARS` 调整（最小 8）。这样首包更早返回，长句也不会越说越慢。
- 显存碎片：若未设置 `PYTORCH_CUDA_ALLOC_CONF`，会自动设置为 `expandable_segments:True`，减少 8GB 级卡上长句分配失败的概率。
- 单请求串行：使用一把推理锁，不做批处理，桌面宠物没有并发批处理需求。 

如果仍然卡住，可优先查看日志：

- `first` 很大：首包问题
- `rtf` 持续大于 1：当前显卡跟不上，建议换后端，例如 llama.cpp 的 GGUF，或在 Ampere 及更新的显卡上尝试 TensorRT

> 0.5B 模型不值得上 8-bit 量化：权重本来只有 1–2GB，量化带来的计算开销可能抵消显存收益。

## 7. 唤醒词与语音对话

可选的唤醒词与中文识别使用本机 `sherpa-onnx`。语音识别文本会发送给设置页中选择的对话模型；默认是本机 Ollama，也可以使用 DeepSeek 或自定义 OpenAI 兼容云端服务。

云端服务只接收识别文字；在追问“刚才讲了什么”时，还会附带最近几条播报正文，但不会收到麦克风音频。

安装前请审阅依赖和模型的上游许可；安装会下载模型，但不会打开麦克风。

```powershell
python scripts/setup_voice_assistant.py
ollama list
```

### 运行要求

- 唤醒词与中文识别需要 64 位 Python 3.12
- Ollama 服务和默认模型 `qwen3.5:4b` 仅在使用本机 Ollama 时需要
- 语音运行时安装在器灵自己的应用数据目录
- 如果模型下载中断，可以重新运行脚本；脚本会尝试从已下载位置续传

### 唤醒词行为

启动器灵后，在“设定”中可以：

- 选择对话模型和播报声音
- 设置 2–8 个连续汉字作为自定义唤醒词（默认是“器灵”）
- 手动启用“唤醒词监听（麦克风）”

注意：

- 唤醒词按拼音匹配，而不是直接按汉字匹配
- 程序会把近音读法一起写入关键词表，如：
  - zh/z、ch/c、sh/s
  - n/l
  - ing/in、eng/en、ang/an
- 因此“七零七零”也可能命中“麒麟麒麟”“七凌七凌”
- 如果关键词检测器漏检，本机识别出的整句转写还会再按拼音比对一次唤醒词
- 声调说错（如“七/欺/其”）仍可能唤醒
- 但整句必须就是唤醒词；句子中间出现唤醒词不会触发

### 口头请求识局重新解说

启用唤醒词后，如果识局已配对并获准 `siju.narrate_current`，可以直接对器灵说：

- “重新解说当前局面”
- “再解说一次”
- “再讲一遍这盘棋”
- “请识局重新解说当前局面”

器灵用本机确定性口令匹配识别这些请求，命中后直接走既有协议调用，不交给对话模型决定；因此每次重新解说仍受同一配对、授权和连接状态约束。语音本身不构成授权。

- 未命中口令的语音仍按普通对话处理。
- “刚才讲了什么”“再复述一遍”仍由对话模型复述最近播报，不会触发识局。
- 说“解释当前选区”暂不会触发 VS Code 选区解释；请用设定页的“解释当前选区”按钮，或在 VS Code 中执行“器灵：解释当前选区”。
- 识局未连接、未授权、当前分析不可用/过期或解说服务失败时，器灵会明确说明，不会把旧解说当成成功。
- 设定页的“请识局重新解说当前局面”按钮保留，作为语音不可用或手动重试时的备用入口。

### 第三方客户端的语音指令

客户端可在 Spirit 能力清单的 Action 中声明可选语音元数据：

```json
{
  "id": "demo.say_hello",
  "risk": "no_state_change",
  "voice": { "locale": "zh-CN", "examples": ["打个招呼", "说声你好"] }
}
```

- 只有已配对、经用户批准、无参数且 `no_state_change` 的 Action 可以声明语音口令；其他组合会被拒绝。
- 配对批准后，口令自动进入器灵目录；客户端断线时明确提示未连接，撤销授权或移除元数据后立即失效。
- 客户端可以在重连时更新例句，但新增 Action、修改风险/Schema/描述/事件仍需要重新配对。
- 多个客户端同义口令时，器灵会先按客户端名定向，仍冲突则要求澄清，不会随机执行。
- 语音口令只用于匹配，不扩大授权，也不会进入对话模型；识别结果未命中时仍按普通对话处理。
- `sdk/typescript/examples/voice-client.mjs` 是无需修改器灵代码的参考客户端。

### 语音交互细节

- 使用本机 Ollama 时，“模型名称”会读取 `ollama list` 中已安装且可对话的模型供下拉选择，也可点击“刷新已安装模型”重读
- DeepSeek 与自定义 OpenAI 兼容服务仍然需要手动填写模型名
- 云端 API 密钥保存在 Windows 凭据管理器
- 语音播报旁有“试听”按钮，可用当前选择的 Edge 在线语音、本机 CosyVoice 或 Windows 系统语音播放示例
- DeepSeek / 自定义 OpenAI 兼容服务要求 HTTPS
- 启用唤醒监听时，程序会明确说明语音识别文字将发送到所选云端服务；音频始终只在本机处理
- 检测到唤醒词后，器灵会先说“我在，请说。”，在回应播放完毕后才开始识别你的问题，避免把自己的回应识别进去

### 对话与打断

对话采用“打断优先”的全双工流程：

- 从器灵开始生成回答到播报结束，麦克风一直开着，只是不再送入唤醒词检测
- 与正在播报的文稿高度重合的识别结果会被视为扬声器回声丢弃，因此回答过程中仍可插话，包括思考阶段也能打断
- 打断判断不是等整句识别完成，而是用流式识别前几个字决定
- 例如：
  - “不对”“等一下”“停”这类纠错开头会立即停止
  - 其他内容累计四个字时立即停止
  - 累计两个字且同样读法连续保持约 0.3 秒时，会先把播报音量压到约 35% 作为过渡
  - “嗯”“对”这类应答声即使听到也不会压低或打断（至少要两个音节）

> 系统语音无法中途调音量，只会直接停止。

已停止的回答会同时取消：

- 模型生成
- CosyVoice / Edge 合成
- 已排队的音频

不会在稍后重新播出来。

停止后麦克风会继续听完这一句，并把整句当作新的问题，因此“等一下，那明天呢”不会丢掉后半句。

其他应用发来的播报（例如 VS Code 选区解释）同样可以打断：

- 说“停”“等一下”会立即停下并取消该轮请求
- 说一句 12 字以内、含“吗/什么/怎么/为什么”等疑问词，会停下并将该句当作新问题回答
- 回答本身也可以继续被打断
- 说唤醒词也能接管当前播报

但要注意：

- 只有正在念的那句本身包含唤醒词时，才会临时开放唤醒词检测；避免器灵被自己的声音叫醒
- 单纯“嗯”一声不会打断
- 如果当前句子含较多英文标识符或数字（代码类解释），本机识别器可能把器灵自己的读音听成别的话；这种情况下只接受明确的停止指令（“停”“等一下”“别说了”），普通新问题不会打断它，以免把自己的声音当成用户插话

### 最近说过的话

器灵会记住最近几条别人让它念的稿子（例如 VS Code 选区解释、识局解说等），这些内容仅存在内存中，退出即清空；不写日志，也不落盘。

只有在你问以下问题时，才会把这些正文随问题发给所选对话模型：

- “刚才讲了什么”
- “再复述一遍”

普通问题不会自动附带这些上下文。

### 语音状态管理

- 说话结束后会先静音约 0.4 秒，让尾音消散，再恢复对话，避免把自己的回答当成新问题
- 唤醒后会保持对话状态，5 分钟内可以直接追问，不必再说唤醒词
- 连续 5 分钟没有新问题，才回到只监听唤醒词的非唤醒状态
- 本机 ASR 转写和 KWS 命中结果会写入 `%APPDATA%\com.qiling.pet\voice-assistant\voice-assistant.log`，并轮换保留最多 4 个日志文件
- 隐藏宠物或关闭监听会停止语音子进程并关闭麦克风；再次显示器灵时，只要开关仍保持打开，就会自动恢复监听
- 如果不想下次启动自动恢复监听，请在退出前关闭开关

### 模型切换

对话模型设置按服务商分别保存在本机：

- Ollama
- DeepSeek
- 自定义 OpenAI 兼容服务

在服务商之间切换后，返回原服务商时会恢复各自上次保存的地址和模型。云端 API 密钥仍独立保存在 Windows 凭据管理器。

## 8. 托盘与交互

器灵常驻系统托盘：

- 左键单击托盘图标，或使用托盘菜单，可在“显示器灵 / 隐藏器灵”之间切换
- 托盘菜单中也有：
  - “设定…”
  - “退出器灵”

注意：关闭器灵窗口现在只是隐藏宠物；要真正退出，请使用托盘菜单中的“退出器灵”。

## 9. 多角色宠物与角色资源包

器灵默认显示灵泡；诗琚保留为第二内置角色。还可以安装第三方角色资源包，同一时间只有一个角色在场。

入口：

- 「设定 → 宠物角色 → 管理角色资源包…」
- 右键器灵 →「角色资源包…」
- 托盘菜单 →「角色资源包…」

资源包是自包含 ZIP（推荐扩展名 `.qilingpet`），安装后会立即注册为可选角色。两个内置角色（灵泡、诗琚）始终可用、不可卸载；卸载正在使用的资源包会自动回到灵泡。

- 资源包只包含 WebP/PNG 图片与 JSON，器灵不会执行其中的代码，也不会上传包内容。
- 安装位置：`%APPDATA%\com.qiling.pet\pet-packs\<characterId>\`
- 动画轨 id／tags 遵循[多角色动画资产规范](docs/multi-character-animation-spec.md)：`<characterId>-<action>`、`tags` 含动作与角色 id（姿势轨加 `pose`）。
- 必做动作：`idle`、`think`、`explain`、`advantage`、`disadvantage`；`pickup` 默认要求完整 lift/hover/drop，也可声明 `"pickup": "window-only"` 只保留移窗。
- 制作格式、字段表、导出与打包步骤、错误码见[角色资源包：制作与安装](docs/pet-packs.md)。

### 默认角色：灵泡

灵泡是器灵的默认角色，用 SVG 骨架而不是逐帧位图：呼吸、漂浮、随机眨眼、眼神跟随鼠标、说话嘴、拖拽拉长都由参数驱动，讲解/思考/优势/劣势各有姿态。它不进入 `design/anim/tracks.manifest.json`，也不参与 `npm run bake:anim` 或资源包格式。

诗琚是第二内置角色，继续使用原有 WebP 轨与吊起逐帧动画；两者可以在角色资源包页切换。

### 听音乐（灵泡）

灵泡会听系统正在播放的音乐，并自动切换状态。默认开启，可在「设定 → 听音乐」关掉。

- 只读取默认播放设备的输出（Windows WASAPI 回环），在本机实时分析音量、低频与节拍；不录音、不保存、不上传。
- 会先区分音乐与人声/噪声：视频里的说话、播客、短提示音不会触发摇摆；抒情慢歌即使鼓点很弱，也会靠音色特征被识别。判定带滞回，不会在边界抖动。
- 按能量自动分三档：舒缓闭眼呼吸漂浮；轻快睁眼微笑、按节拍左右摇摆（不上下跳）；激烈保持同样摇摆，只在鼓点轻弹一下。
- 边界使用滞回，不会在阈值附近来回闪；估计不出 BPM 时用 96 兜底，仍会持续摇摆。
- BPM 支持 40–200：原来 60 BPM（半拍）会被 70 的下限滤掉，现在能识别；八分音符反拍不会再把速度翻倍；≥140 BPM 时沿用原型的取向，半拍候选（65–105）有稳定起音就按半拍驱动动画。
- 音乐停止后约 2 秒内退出音乐状态；声音完全安静约 3.5 秒后停止监听。
- 「设定 → 听音乐」的监听状态会显示最近听到的是“正在跟随音乐 · BPM”“听到声音，但不是音乐”还是“等待音乐”，方便确认系统声音是否被读到。
- 关闭开关或隐藏器灵后立即停止采集；再次显示且开关仍打开时恢复。器灵自己播报时会优先显示讲解/思考等姿态，播报期间不会进入音乐状态。
- 限制：只读默认播放设备；独占模式、受版权保护的音频或非默认设备可能听不到。音乐/人声判别是规则法而不是训练好的分类模型，强节奏的语音、说唱或游戏音效仍可能误判。音乐效果目前只对灵泡生效。

> 阈值与运动参数来自设计原型 [`lingpao-groove.html`](design/characters/lingpao/sheets/lingpao-groove.html)，并用仓库里的 `design/characters/lingpao/_workshop/test-120bpm.wav` 对照原型做过能量标定（见 `src-tauri/src/music.rs` 与 `src/pet/music.ts` 的注释）。
> 原型现在也能听系统声音（「本地音乐 / 系统声音」切换）：浏览器用 `getDisplayMedia` 分享屏幕/标签页音频，仅用于设计验证，需要 Windows 的 Chrome / Edge 并手动分享；真机实现走 WASAPI，不需要分享。

## 10. 测试

```bash
npm test
cargo test --manifest-path src-tauri/Cargo.toml
python -m unittest discover -s scripts -p "test_*.py"
```
