# Spirit Protocol V1（提案）

> **状态：阶段 1 设计已通过评审；阶段 2、阶段 3 均已验收通过。** 用户于 2026-11-01 完成阶段 3 双端桌面验收并确认无问题。试点通过器灵设置页手动按钮触发 Action；唤醒词与 STT 尚未实现。
>
> 用户选择回环 WebSocket + JSON-RPC 2.0、唤醒词、本机优先 STT（云端需显式开启）、一次性配对与按客户端授权。唤醒词必须由本机检测；启用时麦克风会持续进行本地唤醒检测，但唤醒前的音频不得保存或发送。

## 1. 目标与非目标

V1 用一个可验证的双向闭环定义器灵与桌面客户端如何协作：

1. 用户通过器灵语音明确请求“重新解说当前局面”。
2. 器灵将唯一允许的试点意图映射为识局提供的 `siju.narrate_current` Action。
3. 识局使用当前有效棋局和用户既有的解说设置生成解说。
4. 识局返回新生成的解说；器灵展示/朗读。
5. 失败时返回可区分的状态，不使用旧解说伪装成成功。

V1 定义客户端身份、能力发现、双向消息、Action 结果、权限边界、错误与生命周期。它不是通用桌面自动化协议，不允许语音模型自由调用未声明的系统操作。

## 2. 提案决策摘要

| 领域 | V1 提案 | 理由 |
|---|---|---|
| 连接 | `127.0.0.1` 上的持久 WebSocket | 支持双向事件和请求，无需轮询；不开放局域网 |
| 消息格式 | WebSocket 上使用 JSON-RPC 2.0 信封 | 复用成熟的请求 ID、通知、响应与错误模型；不依赖 MCP |
| 旧接口 | 保留既有 HTTP `/v1/health`、`/v1/say`、`/v1/cancel` | 兼容当前识局；不把尚未实现的 WS 操作伪装成现有 API |
| 语音 | 用户启用后由本机唤醒词触发 | 唤醒检测留在本机；仅唤醒后进入识别流程 |
| STT | 本机优先；云端识别必须由用户显式开启并事先告知 | 减少默认音频外传；当前 CosyVoice TTS 不等于已有 STT |
| 客户端身份 | 器灵生成短时一次性配对码；用户批准客户端及其请求能力 | 本机地址或客户端自报名称都不是身份认证 |
| 凭证 | 每个已配对客户端独立令牌，保存在系统凭证库；可以撤销 | 限制单个客户端泄露的影响 |
| 试点权限 | `siju.narrate_current` 属于无棋局副作用操作；配对授权后不逐次弹确认 | 符合阶段 0 的产品决定 |

### 2.1 传输方案比较

单一 HTTP 请求是实现成本最低的方案，能够完成“请求重新解说并返回结果”，但客户端发现、持续事件、双向会话与取消需要再增加端点或轮询约定；若只做这个试点也许足够，却无法验证路线图要求的通用双向协议。

Windows Named Pipe 可以使用 Windows 用户 ACL 收紧本机访问，适合当前 Windows 版识局；代价是桌面客户端和 SDK 必须提供平台专属传输，并为其他系统另做适配器。

本提案选择回环 WebSocket + JSON-RPC 2.0，作为跨语言桌面客户端与持续双向消息的折中；它仍可只开放 `127.0.0.1`，但需要替换/扩展当前 `tiny_http` 服务，并认真处理配对、令牌、Origin 与旧版 HTTP 兼容。若首个可交付产品明确只支持 Windows，Named Pipe 是合理替代，应在评审时决定，而不是默认同时实现两种传输。

## 3. 传输与兼容

### 3.1 新协议连接

- 只监听 IPv4 回环地址 `127.0.0.1`，默认沿用 `QILING_PORT`，路径建议为 `/v1/connect`。
- 连接 URI：`ws://127.0.0.1:<QILING_PORT>/v1/connect`。
- 不支持 `0.0.0.0`、局域网或公网监听；V1 不使用 TLS，但所有连接仍须通过客户端授权。
- 新连接为受信任的桌面客户端使用。只接受已知打包应用、当前本机服务及开发端口的精确 Origin allowlist；无 Origin 的原生客户端仍须提供有效令牌。Origin 校验只是纵深防御，不能替代客户端认证。
- JSON-RPC 2.0 仅作为消息信封约定；Spirit Protocol 定义自己的能力、事件和 Action，不要求客户端实现 MCP。
- 消息最大体积建议为 64 KiB；语音音频不通过 Spirit Protocol WebSocket 传送。
- 初始实现最多保存 32 个已配对客户端、同时处理 32 条 WebSocket 连接（含未认证连接）；单会话每分钟最多接收 60 个事件通知。

WebSocket 和当前 `tiny_http` 服务器的升级/并发能力不同。实现阶段需要替换或扩展监听器，但须保留以下已实现 HTTP 路径和既有响应语义：

- `GET /v1/health`
- `POST /v1/say`
- `POST /v1/cancel`
- `GET /openapi.yaml`
- `GET /docs`

当前 `/v1/say` 等旧接口没有客户端身份认证，仍只代表旧版“本机程序驱动桌宠”能力；它们不应被视为新 Action 通道。服务拒绝带有非可信 Origin 的浏览器写请求，并要求 `/v1/say` 使用 `application/json`，但这些措施不认证本机原生客户端，因此服务仍必须只监听回环地址。旧接口迁移或移除需另行设计。

### 3.2 JSON-RPC 约定

WebSocket 文本帧承载 JSON 对象，遵循 JSON-RPC 2.0 的三种基本形态：

- 请求：`{"jsonrpc":"2.0","id":"...","method":"...","params":{...}}`
- 通知：`{"jsonrpc":"2.0","method":"...","params":{...}}`（无 `id`，不应期待响应）
- 响应：请求对应的 `result` 或 `error`，必须回显相同 `id`

连接上每个未完成请求的 `id` 必须唯一。客户端和器灵都应忽略无法关联的响应，并将畸形帧作为协议错误处理。未知方法不得被默认为成功。

## 4. 配对、身份与连接生命周期

### 4.1 配对提案

1. 用户在器灵设置中显式选择“配对客户端”；器灵生成 8 位随机 Base32 配对码（建议有效期 5 分钟，只能使用一次）。
2. 客户端通过仅允许配对流程的未认证 WebSocket 会话发送 `client.pair`，提交配对码、自报的客户端 ID/名称/版本及其请求的能力清单。客户端 ID 是标识，不是认证凭证。配对码须限速尝试并避免写入日志。
3. 器灵显示待批准客户端及其申请的能力；用户批准后，器灵为该客户端签发独立凭证。用户拒绝、配对码过期或已使用时不得签发。
4. `client.pair` 成功响应只返回一次不透明访问令牌；客户端将凭证存入系统凭证库。后续 WebSocket 连接的第一条消息必须是 `client.authenticate`，通过受保护消息体提交令牌；不得把凭证放在 URL、日志或共享配置文件中。认证前不处理其他消息。
5. 用户可在器灵设置中撤销单个客户端凭证；撤销应拒绝新连接并关闭该客户端的活动会话。
6. 已认证客户端可发送 `client.unpair` 主动撤销自己的服务器授权；器灵删除授权记录、响应确认并关闭该会话。客户端只有在确认服务器撤销成功（或服务器明确报告凭证已撤销）后，才清除本机凭证；器灵暂不可达时应显示失败并保留凭证以便重试。

配对码为 8 位随机 Base32、5 分钟失效、最多 5 次错误尝试；每个客户端 ID 只允许一份授权记录，达到 32 个客户端上限时拒绝新配对。

配对会话仅可提交配对消息；批准后关闭该未认证会话，客户端以新连接完成认证和初始化。配对审批是客户端接入授权，不等于每次 Action 都要确认。`siju.narrate_current` 在用户批准识局客户端及此能力后不逐次确认。事件订阅也属于授权清单，不能只因客户端声明就自动开放。未来改变棋局或设置的 Action 不包含在此授权决定内：默认每次执行前征求确认；高影响/不可逆操作默认拒绝，除非另有明确设计和授权。

服务器主动撤销客户端后，客户端应停止重连并清除已失效的本机凭证；UI 应显示“授权已撤销，请重新配对”，而不是继续提供普通解除配对操作。

### 4.2 初始化和注册

认证后的客户端在每条新连接上发送 `client.initialize` 请求，其中包含：

- `protocolVersion`（V1 为 `"1"`）
- `client`（稳定 ID、显示名、版本）
- `capabilities.actions`（客户端提供的 Action ID、参数/结果 Schema、风险级别）
- `capabilities.events`（客户端可发布和订阅的事件类型）

器灵返回 `sessionId`、协商的协议版本、器灵版本、器灵自身可用能力，以及本次获准的客户端能力。服务器不得仅凭客户端声明授予权限：实际可调用范围是“客户端声明能力 ∩ 用户批准能力 ∩ 协议支持能力”。

版本不兼容时，返回 `version_unsupported` 并关闭会话；不能静默降级到未知语义。客户端断线即视为离线；重连后重新初始化。V1 不承诺跨断线恢复未完成 Action。

## 5. 能力、事件与 Action

### 5.1 能力命名与风险

- ID 使用稳定、带命名空间的形式，例如 `siju.narrate_current`。
- 能力声明包含描述、输入/输出 JSON Schema 和风险级别。
- V1 风险级别为 `no_state_change`、`state_change`、`sensitive`。
- 客户端只执行当前连接已声明且用户已批准的 Action。未知、未批准或参数不匹配的 Action 必须拒绝。
- 语音意图层只允许将明确匹配的请求映射到已登记能力；不将任意转录文本拼成方法名或参数。

### 5.2 事件

`event.publish` 是单向通知。事件至少包含 `eventId`、带命名空间的 `eventType`、UTC `occurredAt` 和受该事件 Schema 约束的 `payload`。连接初始化时双方分别声明可发布/可订阅的事件；未订阅事件不得被转发。

事件只承载完成订阅所需的最小数据。识局可以发布 `siju.analysis.status`（例如 `ready`、`unavailable`），VS Code 客户端可以发布 `vscode.editor.status`；状态事件不应包含棋局、选区或文件内容。事件不能隐式执行 Action。

### 5.3 试点 Action

识局声明：

```json
{
  "id": "siju.narrate_current",
  "risk": "no_state_change",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "outputSchema": {
    "type": "object",
    "required": ["text", "mood"],
    "properties": {
      "text": { "type": "string", "maxLength": 400 },
      "mood": { "type": "string", "enum": ["neutral", "up", "down"] }
    },
    "additionalProperties": false
  },
  "supportsCancellation": false
}
```

器灵以 `action.invoke` 请求执行此能力，参数为空。识局在处理时读取当前局面，并复用现有解说模式/模型设置；必须验证分析数据仍属于当前局面。成功结果只返回新解说文本和 mood，不返回 FEN、棋盘、候选着法、密钥或原始提示词。文本超过器灵现有 400 Unicode 码点上限时应返回明确错误，不得静默截断。

### 5.4 第二客户端：VS Code 选区解释（阶段 5）

当前实现仅接受下面这个受限 VS Code 客户端配置；配对申请会将客户端 ID、Action 风险和事件类型展示给用户：

```json
{
  "id": "vscode.explain_selection",
  "risk": "sensitive",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "outputSchema": {
    "type": "object",
    "required": ["text", "mood"],
    "properties": {
      "text": { "type": "string", "maxLength": 400 },
      "mood": { "type": "string", "enum": ["neutral", "up", "down"] }
    },
    "additionalProperties": false
  },
  "supportsCancellation": false
}
```

此 Action 是敏感读取：用户首次批准 VS Code 客户端及其选区解释能力；之后每次由用户点击器灵设置中的“解释当前选区”明确触发，不再重复弹窗。VS Code Connector 只读取活动编辑器选区（最多 8,000 Unicode 码点），不读取整个文件、不修改文件、不执行命令、不记录选区。首次使用时用户在 VS Code 中选择模型，Connector 会在 VS Code 本机记住选择；用户可通过“器灵：选择解释模型”命令更换。无选区、过长、没有可用模型、用户取消、超时或断线均以明确错误结束。模型提供方可能在本机或云端运行；用户应只选择自己已配置并允许处理该内容的模型。此 V1 连接器不绕过 VS Code 的模型访问/确认机制。

VS Code 发布 `vscode.editor.status`，仅表达当前是否有可解释选区，不包含选区文本。用户批准配对授予该客户端能力资格；用户每次点击“解释当前选区”触发单次读取，随时可撤销配对授权。

## 6. 语音请求流程

1. 用户主动启用唤醒词功能。启用期间器灵的本机检测器持续监听唤醒词；唤醒前音频仅用于瞬时本地检测，不写盘、不上传，也不保留为可回放录音。界面应清晰显示监听状态，并提供立即关闭入口。
2. 检测到唤醒词后，器灵先语音回应“我在，请说。”；回应播放完成后再采集本次命令并进行 STT，避免将器灵自己的回应录入问题。默认本机识别；若本机 STT 不可用，告知用户且不调用 Action。用户可另行显式开启云端 STT；开启前说明发送的音频/文本、接收方及保留方式。云端识别不得用于唤醒词检测。
3. 意图匹配器只识别试点意图“重新解说当前局面”。不能可靠识别、发现多个候选或识别到其他意图时，不调用任何客户端 Action；提示用户重说或说明暂不支持。
4. 命中唯一意图后，器灵检查识局在线、能力已登记且用户已批准，然后发送 `action.invoke`。
5. 识局返回成功后，器灵显示/朗读这次请求返回的新文本。不能复用先前 `/v1/say` 的旧文本冒充结果。

V1 包含用户显式启用的本机唤醒词检测；它不是云端常驻监听或录音。V1 不包含自由对话或让 LLM 自主规划任意操作。语音识别本身不构成针对未来有副作用 Action 的授权。

## 7. 请求关联、超时、取消与错误

- JSON-RPC `id` 用于关联每个请求/响应，不作为授权凭证。
- `action.invoke.params.timeoutMs` 建议缺省 60,000 ms、允许范围 1,000–120,000 ms；双方使用单调时钟执行超时，超时后不可报告成功。
- `$/cancelRequest` 通知携带正在执行的 JSON-RPC `id`。仅当客户端声明支持取消时才保证尽力取消；取消不支持时须忽略或返回明确状态，不能伪称已取消。
- 断线、超时、取消后的迟到响应必须丢弃，不得覆盖较新的会话结果。
- 不自动重放断线前未完成的请求。未来有副作用能力时，不得仅因超时就假设执行未发生；需由该能力定义幂等键/查询结果语义。
- 内部日志可记录会话 ID、Action ID、请求 ID、状态和耗时；不得记录配对码、访问令牌、音频、FEN、棋盘、完整着法、转录或解说正文。

建议应用错误码：

| `data.code` | 含义 | 可重试 |
|---|---|---|
| `pairing_required` / `pairing_expired` | 未配对或配对码失效 | 用户重新配对 |
| `not_authorized` | 客户端或能力未获授权 | 否，需用户授权 |
| `version_unsupported` | 无共同协议版本 | 否，升级客户端 |
| `action_not_found` | 当前客户端未提供该 Action | 连接状态变化后可重试 |
| `invalid_params` | Action 参数不符合声明 Schema | 修正请求后可重试 |
| `client_unavailable` | 识局未连接 | 是 |
| `state_unavailable` | 当前局面/有效分析不可用 | 状态变化后可重试 |
| `state_stale` | 分析结果已不属于当前局面 | 刷新分析后可重试 |
| `summarizer_unavailable` | 当前模式/模型不可用或失败 | 视错误详情 |
| `busy` | 客户端当前不能开始另一个解说 | 是 |
| `deadline_exceeded` | 请求超过期限 | 视 Action 状态，禁止无条件重放有副作用 Action |
| `cancelled` | 请求在完成前取消 | 用户再次明确发起 |
| `internal_error` | 无法分类的内部错误 | 视错误详情 |

JSON-RPC 标准错误码用于信封/方法层错误；以上稳定字符串放在错误对象的 `data.code` 中。用户展示的中文说明由器灵本地化，不直接信任客户端返回的任意错误文本。

## 8. 示例消息

首次配对请求（只有用户在器灵设置中生成有效配对码后才允许）：

```json
{"jsonrpc":"2.0","id":"pair-1","method":"client.pair","params":{"pairingCode":"ABCDEFGH","client":{"id":"com.siju.app","name":"识局","version":"0.1.0"},"requestedCapabilities":{"actions":[{"id":"siju.narrate_current","risk":"no_state_change","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object","required":["text","mood"],"properties":{"text":{"type":"string","maxLength":400},"mood":{"type":"string","enum":["neutral","up","down"]}},"additionalProperties":false},"supportsCancellation":false}],"events":{"publishes":["siju.analysis.status"],"subscribes":[]}}}}
```

配对成功时的一次性凭证响应（示例值不可用）：

```json
{"jsonrpc":"2.0","id":"pair-1","result":{"clientId":"com.siju.app","accessToken":"example-only-not-a-credential-0123456789"}}
```

客户端重连后的首条认证消息：

```json
{"jsonrpc":"2.0","id":"auth-1","method":"client.authenticate","params":{"accessToken":"example-only-not-a-credential-0123456789"}}
```

认证成功后，客户端才发送初始化请求。

客户端初始化：

```json
{"jsonrpc":"2.0","id":"init-1","method":"client.initialize","params":{"protocolVersion":"1","client":{"id":"com.siju.app","name":"识局","version":"0.1.0"},"capabilities":{"actions":[{"id":"siju.narrate_current","risk":"no_state_change","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object","required":["text","mood"],"properties":{"text":{"type":"string","maxLength":400},"mood":{"type":"string","enum":["neutral","up","down"]}},"additionalProperties":false},"supportsCancellation":false}],"events":{"publishes":["siju.analysis.status"],"subscribes":[]}}}}
```

器灵请求重新解说：

```json
{"jsonrpc":"2.0","id":"action-42","method":"action.invoke","params":{"action":"siju.narrate_current","arguments":{},"timeoutMs":60000}}
```

成功响应：

```json
{"jsonrpc":"2.0","id":"action-42","result":{"text":"红方略优。","mood":"up"}}
```

当前局面不可用：

```json
{"jsonrpc":"2.0","id":"action-42","error":{"code":-32000,"message":"Action failed","data":{"code":"state_unavailable","retryable":false}}}
```

识局发布状态事件：

```json
{"jsonrpc":"2.0","method":"event.publish","params":{"eventId":"evt-7","eventType":"siju.analysis.status","occurredAt":"2026-11-01T00:00:00Z","payload":{"status":"ready"}}}
```

## 9. 兼容、OpenAPI 与契约工件

- `docs/openapi.yaml` 继续作为**已实现 HTTP API** 的权威文档；它不声明提案中的 WebSocket 路径或 Action 已经上线。
- 本文件描述双向协议提案；`docs/spirit-protocol-v1.schema.json` 提供消息信封及试点数据结构的可机读 Schema 和样例。
- 后续阶段应以 Schema 样例建立契约测试，确保器灵和识局的消息结构一致；不能只依靠文档字符串测试。
- 旧 HTTP API 在迁移期保持兼容。移除、改变其身份模型或改变行为，必须另有版本策略与迁移说明。

## 10. 阶段 1 评审结论

以下决策已由用户确认，作为 V1 实现基线：

- WebSocket + JSON-RPC 2.0；客户端在连接后的首条消息中认证，不在 WebSocket Upgrade 自定义头中传令牌。
- 用户启用后以本机唤醒词触发；麦克风仅进行本地检测，监听状态须可见且可立即关闭。
- 本机优先 STT；云端识别须显式开启。具体 STT 引擎和模型不在本规格指定。
- 一次性配对、首次能力授权、客户端系统凭证库存储及按客户端撤销。
- `siju.narrate_current` 是唯一配对授权后免逐次确认的 V1 Action。
- Action 默认超时 60 秒；消息体上限 64 KiB；采用本文列出的错误码范围。

阶段 1 设计已通过评审；阶段 2 和阶段 3 均已通过用户桌面验收。阶段 3 的状态事件和 `siju.narrate_current` Action 已实现并完成自动化及桌面验证。唤醒词和 STT 属于后续语音实现阶段，不应描述为已可用。
