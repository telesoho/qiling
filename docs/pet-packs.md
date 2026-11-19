# 角色资源包：制作与安装

> 面向角色作者。器灵通过角色资源包安装、注册并切换多个桌面角色；本文件规定包格式、动画轨要求和校验规则。
> 动画命名与状态约定以《[多角色动画资产规范](multi-character-animation-spec.md)》为准；本文件只描述**运行时安装态**的资源包。

## 1. 这是什么

- 角色资源包是一个自包含 ZIP 文件，推荐扩展名 `.qilingpet`，也接受 `.zip`。
- 安装后立即注册为可选角色：出现在「设定 → 宠物角色 → 管理角色资源包…」中；同一时间只有一个角色在场。
- 内置角色灵泡（默认）与诗琚始终可用、不可卸载；卸载正在使用的资源包会自动回到灵泡。
- 资源包只包含 WebP/PNG 图片与 JSON。器灵不会执行其中的脚本或程序，也不会把包内容上传到网络。
- 资源包是**运行时交付**：它不经过 `npm run bake:anim`。内置诗琚仍由 `design/` + bake 生成；灵泡由 `src/pet/SvgSprite.tsx` 直接绘制，两条路径并存。

安装位置：

```text
%APPDATA%\com.qiling.pet\pet-packs\
  state.json
  <characterId>\
    pet.json
    thumbnail.webp
    tracks\...
```

卸载会删除 `%APPDATA%\com.qiling.pet\pet-packs\<characterId>`。如果 Windows 上图片文件仍被占用，目录可能先移到 `.trash`，下次启动器灵时清理。

## 2. 与多角色动画规范的关系

安装器会把 `pet.json` 的 `action` **编译**成规范 §7.1 要求的运行时条目，作者不需要（也不能）手写 id/tags：

| `pet.json.tracks[]` | 编译后的运行时条目 |
| --- | --- |
| `action: "idle"` | `id: "<packId>-idle"`，`path: "tracks/idle/track_struct.json"`，`tags: ["idle", "<packId>"]` |
| `action: "think"` | `id: "<packId>-think"`，`tags: ["pose", "think", "<packId>"]` |
| `action: "explain"` | `id: "<packId>-explain"`，`tags: ["pose", "explain", "<packId>"]` |
| `action: "advantage"` | `id: "<packId>-advantage"`，`tags: ["pose", "advantage", "<packId>"]` |
| `action: "disadvantage"` | `id: "<packId>-disadvantage"`，`tags: ["pose", "disadvantage", "<packId>"]` |
| `action: "pickup"` | `id: "<packId>-pickup"`，`tags: ["pickup", "<packId>"]` |
| 其他动作（如 `water_splash`） | `id: "<packId>-<action>"`，`tags: ["<action>", "<packId>"]` |

因此：

- **不要**在 `pet.json` 里写 `id`、`path`、`tags`；写了也不会被采用。
- 运行时按「当前角色 ∩ 动作」取轨：`think` 在切换角色后永远播当前角色的 `<characterId>-think`，不会串用另一角色素材。
- 不新增全局状态 ID。`walk`、`wave`、`work`、`sleep`、`celebrate`、`error` 以及自定义性格动作可以随包注册，但当前运行时只消费下面「运行时消费表」中的动作；其余仅注册，不能写成已实现能力（规范 §9.6）。

### 2.1 运行时消费表

| 动作 | 运行时用途 |
| --- | --- |
| `idle` | 默认待机、呼吸 |
| `think` / `explain` / `advantage` / `disadvantage` | 五个说话姿势中的四个（第五个 `idle` 即待机） |
| `pickup` | 吊起/悬空/落下相位机；`window-only` 时只移窗 |
| `butterfly` / `angry` | 未声明 `idleBeats` 时的性格节拍兜底 |
| `idleBeats` 引用的自定义动作 | 性格节拍，约 20% 触发 |
| `walk` / `wave` / `work` / `sleep` / `celebrate` / `error` / 其他 | 注册但当前版本不消费 |

> `work` 的约定见规范 §9.2：不要把 `editing`/`testing`/`running` 各做一套近似轨；需要时合并到 `work` 或 `think`。

## 3. 目录结构

```text
dafeiyu.qilingpet (ZIP)
  pet.json
  thumbnail.webp                          # 可选
  tracks/
    idle/
      track_struct.json
      idle.webp
    think/
      track_struct.json
      think.webp
    explain/
    advantage/
    disadvantage/
    pickup/
      track_struct.json
      frames/
        frame001.webp
        ...
```

- 路径必须是 ASCII：`pet.json`、根目录图片、`tracks/**`；只允许字母、数字、`.`、`_`、`-`。
- 禁止绝对路径（如 `/pet/idle.webp`）、`..`、反斜杠、URL、盘符。
- 包内资源只能引用包内文件；安装时会拒绝越出包根的引用。
- `tracks/<action>/track_struct.json` 的路径由 action 决定，不能自定义。

## 4. `pet.json`

```json
{
  "schemaVersion": 1,
  "id": "dafeiyu",
  "name": "大肥鱼",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "Q 版鲸尾女孩",
  "thumbnail": "thumbnail.webp",
  "pickup": "animated",
  "idleBeats": [{ "action": "water_splash", "line": "扑通", "ms": 4000 }],
  "tracks": [
    { "action": "idle", "displayName": "大肥鱼·待机" },
    { "action": "think", "displayName": "大肥鱼·思考" },
    { "action": "explain", "displayName": "大肥鱼·讲解" },
    { "action": "advantage", "displayName": "大肥鱼·优势" },
    { "action": "disadvantage", "displayName": "大肥鱼·劣势" },
    { "action": "pickup", "displayName": "大肥鱼·吊起" },
    { "action": "water_splash", "displayName": "大肥鱼·水花" }
  ]
}
```

### 4.1 字段

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `schemaVersion` | 是 | 必须为 `1`；更高版本会被拒绝 |
| `id` | 是 | `^[a-z0-9][a-z0-9-]{1,31}$`；不能是 `lingpao` 或 `shiju`；即角色目录名与 track id 前缀 |
| `name` | 是 | 1–40 字符；显示在资源包列表与气泡标题 |
| `version` | 是 | 1–32 字符，只含字母数字与 `. + -`，首字符为字母数字 |
| `author` | 否 | ≤80 字符 |
| `description` | 否 | ≤500 字符 |
| `thumbnail` | 否 | 包根目录的 `.webp`/`.png`，≤2 MiB；缺省显示角色名首字 |
| `pickup` | 否 | `"animated"`（默认）或 `"window-only"`；见 §4.3 |
| `idleBeats` | 否 | ≤4 项；见 §4.4 |
| `tracks` | 是 | 1–32 条；`action` 唯一；见 §4.2 |

### 4.2 `tracks[]` 与必做动作

- `action`：`^[a-z][a-z0-9_]{0,23}$`；首字符为小写字母，后续允许小写字母、数字与下划线（如 `water_splash`、`tail_wag`）。不能是保留名 `pose`、`breath`，不能使用连字符（避免与 `<characterId>-<action>` 的边界歧义），也不能写成 `<characterId>-<action>` 形式。
- `displayName`（可选）：≤80 字符；缺省为 `<name>·<动作中文名>`。
- 同一 action 只能有一条轨。
- **必做**：`idle`、`think`、`explain`、`advantage`、`disadvantage`。
- **默认必做**：`pickup`；若显式声明 `"pickup": "window-only"`，可省略 pickup 轨（见 §4.3）。
- 推荐：`butterfly`/`angry` 或 `idleBeats` 引用的性格动作。
- 可选：`walk`、`wave`、`work`、`sleep`、`celebrate`、`error` 等；当前只注册不播放。

### 4.3 `pickup` 两种模式

**`"animated"`（默认）**：必须提供 `pickup` 轨，且 `track_struct.json` 含三段逐帧动画：

```json
{
  "fps": 24,
  "frameSize": { "width": 180, "height": 260 },
  "phases": {
    "lift":  { "playback": "once", "asset": { "type": "frameSequence", "dir": "frames", "from": 1, "to": 43 } },
    "hover": { "playback": "loop", "asset": { "type": "frameSequence", "dir": "frames", "from": 44, "to": 71 } },
    "drop":  { "playback": "once", "asset": { "type": "frameSequence", "dir": "frames", "from": 72, "to": 164 } }
  }
}
```

- `lift`/`drop` 必须是 `once`，`hover` 必须是 `loop`。
- 每段都是 `frameSequence`，帧文件从 1 起按 `from`/`to` 连续编号。
- 帧文件必须存在；单轨 ≤2000 帧。

**`"window-only"`**：可以没有 `pickup` 轨；若提供，允许只有 `idle` 相位。拖拽只会移动窗口，不播吊起动画。这是规范 §8.1 允许的声明式例外；想要完整体验就用 `animated`。

### 4.4 `idleBeats[]`（性格节拍）

```json
"idleBeats": [
  { "action": "water_splash", "line": "扑通", "ms": 4000 }
]
```

- 最多 4 项；`action` 必须是本包已声明的非核心动作（不能是 `idle/think/explain/advantage/disadvantage/pickup/breath/pose`），且不能重复。
- `line` 1–40 字符，用于待机气泡。
- `ms` 可选，500–60000；缺省时优先使用该动画轨的 `durationMs`，再缺省为 3000。
- 声明后，运行时约 20% 的待机节拍触发性格动作（多个 beat 均分时间），其余保持呼吸。
- 不声明时：若存在 `butterfly`/`angry` 轨，自动沿用它们的标准文案作为节拍；都不存在则只呼吸。
- 性格动作的 `track_struct.json` 的 `idle` 相位必须是 `animatedWebp`。

## 5. 包内 `track_struct.json`

沿用 [动画契约](../design/anim/spec/track_struct.json) 的子集；运行时只读这些字段：

| 字段 | 规则 |
| --- | --- |
| `fps` | 可选，1–60，默认 24 |
| `frameSize` | 可选，`width`/`height` 1–2048，默认 180×240 |
| `phases` | 必填，非空，≤16 个相位 |
| `phases.*.playback` | 可选：`loop` 或 `once`；缺省 `once` |
| `phases.*.asset.type` | `animatedWebp` 或 `frameSequence` |
| `id` / `displayName` / `interrupt` / `version` | 可留可删；运行时以编译条目为准 |

### 5.1 `animatedWebp`

```json
{
  "type": "animatedWebp",
  "src": "idle.webp",
  "fps": 24
}
```

- `src` 相对**本 track_struct.json 所在目录**解析，必须位于包内。
- 只支持 `.webp`，≤32 MiB。
- `durationMs` 可省略：安装/加载时会读取 WebP 的 ANMF 帧时长自动补齐；读不到时待机节拍回退 3000ms。
- `idle`、四个姿势、性格节拍轨的 `idle` 相位必须是 `animatedWebp`；当前 `<img>` 渲染路径不支持这些姿势用 `frameSequence`。

### 5.2 `frameSequence`

```json
{
  "type": "frameSequence",
  "dir": "frames",
  "pattern": "frame{NNN}.webp",
  "zeroPad": 3,
  "from": 1,
  "to": 43
}
```

- `dir` 相对本 JSON 所在目录，默认 `tracks`。
- `pattern` 默认 `frame{NNN}.webp`；`zeroPad` 默认 3（1–6）。
- `from`/`to` 从 1 起，`from ≤ to`，单轨 ≤2000 帧；每个帧文件都必须存在且为 `.webp`。
- `pickup` 的 lift/hover/drop 必须使用 `frameSequence`。

## 6. 从 `design/` 导出并打包

1. 在 `design/characters/<id>/anim/` 完成六个 MVP 轨（或按 §4.3 声明 window-only）。
2. 新建一个空目录作为包根，例如 `C:\work\dafeiyu-pack`。
3. 把每个动作目录复制为 `tracks/<action>/`，例如 `tracks/idle/`、`tracks/think/`。
4. 对每个 `track_struct.json`：
   - 若 `animatedWebp.src` 指向 `design/` 外的 `public/pet/*.webp`，把该 WebP 复制到对应 `tracks/<action>/` 下，并把 `src` 改成同目录相对文件名（如 `"idle.webp"`）。
   - 逐帧轨保留 `frames/`（或 `tracks/`）与 `from`/`to`，确认文件编号连续。
   - 不要直接拿 `public/pet/anim/` 下的运行时文件当包源：那些是 bake 产物，含 `/pet/...` 绝对路径；从 `design/characters/<id>/anim/` 的源 `track_struct.json` 导出。
   - 不要在包内保留源 mp4、绿幕/白底序列、rembg 中间图；这些属于 `_workshop/`。
5. 在包根写 `pet.json`（§4）。`id` 必须等于 `design/characters/` 下的角色 id；不要用内置的 `lingpao` / `shiju`。
6. （可选）放 `thumbnail.webp`。
7. 压缩为 `.qilingpet`：

```powershell
# 注意：pet.json 必须位于压缩包根目录。
# Compress-Archive 只认 .zip 目标名；先压成 zip，再改成 .qilingpet。
Compress-Archive -Path "C:\work\dafeiyu-pack\*" -DestinationPath "C:\work\dafeiyu.zip" -CompressionLevel Optimal
Move-Item "C:\work\dafeiyu.zip" "C:\work\dafeiyu.qilingpet"
```

8. 打开器灵 → 右键器灵/托盘「角色资源包…」→「安装资源包…」，选择文件。安装成功后列表出现该角色；点「使用此角色」即可。

> `Compress-Archive` 产生的 ZIP 使用标准 `/` 分隔路径，可直接安装。某些第三方工具会把路径写成反斜杠或加入 `__MACOSX`、加密条目、符号链接；这些会被拒绝。

### 6.1 最小可安装示例（window-only，只有五条基础轨）

```json
{
  "schemaVersion": 1,
  "id": "demo",
  "name": "演示角色",
  "version": "1.0.0",
  "pickup": "window-only",
  "tracks": [
    { "action": "idle" },
    { "action": "think" },
    { "action": "explain" },
    { "action": "advantage" },
    { "action": "disadvantage" }
  ]
}
```

每个 `tracks/<action>/track_struct.json` 至少包含一个 `idle` 相位，且 `animatedWebp` 指向包内 WebP。注意：没有 pickup 轨时拖拽只移动窗口。

## 7. 安装校验与限额

安装会在临时目录完成全部校验，任何失败都不会留下半安装：

- 压缩包 ≤96 MiB；解压总量 ≤256 MiB；条目 ≤10000；单文件 ≤32 MiB；缩略图 ≤2 MiB。
- 拒绝：非 ZIP、加密条目、符号链接、重复条目、绝对路径、`..`、反斜杠、非 ASCII 路径、未知顶层路径（`pet.json` 与根目录图片除外）、非法扩展名。
- 必做动作缺失 → `pack_mvp_tracks_missing`。
- pickup 声明与轨道不符 → `pack_pickup_invalid`。
- 动画轨 JSON 不合法、引用图片缺失、姿势轨没有 `animatedWebp` idle → `pack_track_invalid` / `pack_asset_missing`。
- 同 id 已安装：先返回 `pack_exists`；在页面确认「替换」后才会覆盖。
- 卸载内置灵泡或诗琚 → `pack_builtin_protected`。
- 文件被占用 → `pack_in_use`；资源包目录会先移到 `.trash`，下次启动清理。

## 8. 错误码速查

| 错误码 | 含义 |
| --- | --- |
| `pack_zip_invalid` / `pack_extract_failed` | 不是有效 ZIP，或解压失败 |
| `pack_file_unreadable` | 无法读取所选文件（不存在或无权限） |
| `pack_path_invalid` | 路径非法（绝对路径、`..`、反斜杠、非 ASCII） |
| `pack_entry_unsupported` | 含不支持的文件/目录、符号链接、加密条目或重复条目 |
| `pack_too_large` | 超过压缩包/解压/单文件限额 |
| `pack_manifest_missing` | 根目录没有 `pet.json` |
| `pack_manifest_invalid` | `pet.json` 字段非法 |
| `pack_schema_unsupported` | `schemaVersion` 不是 1 |
| `pack_id_invalid` | `id` 不合法，或与内置 `lingpao` / `shiju` 冲突 |
| `pack_mvp_tracks_missing` | 缺 `idle/think/explain/advantage/disadvantage`（或 animated pickup） |
| `pack_pickup_invalid` | pickup 轨缺少 lift/hover/drop 或类型/播放方式不对 |
| `pack_idle_beats_invalid` | `idleBeats` 引用了不存在的动作、重复或文案为空 |
| `pack_track_invalid` | `track_struct.json` 字段非法，或姿势/idle 轨缺少 `animatedWebp` idle 相位 |
| `pack_asset_missing` | 引用的图片不存在或越出包根 |
| `pack_exists` | 同 id 已安装，需要确认替换 |
| `pack_not_found` | 找不到该资源包 |
| `pack_builtin_protected` | 尝试卸载内置灵泡或诗琚 |
| `pack_in_use` | 文件被占用，稍后重试或重启器灵 |
| `pack_busy` | 另一个资源包操作正在进行 |
| `pack_io_failed` | 读写应用数据目录失败 |

## 9. 故障排查

**安装后列表里有，但宠物没换？** 点「使用此角色」；同一时间只有一个角色在场。

**只显示待机，不播思考/讲解？** 检查对应 action 的 `track_struct.json` 是否存在、`idle` 相位是否为 `animatedWebp`。缺姿势轨会回退该角色 idle 图，不会报错。

**拖起来没有吊起动画？** 要么包声明了 `"pickup": "window-only"`，要么 pickup 轨没有完整的 lift/hover/drop 三段 `frameSequence`。animated 模式会拒绝缺段。

**气泡名字不对？** 改 `pet.json.name`；重新安装（同 id 需确认替换）后生效。

**安装提示 id 冲突？** 不能使用内置 id `lingpao` / `shiju`；换一个稳定英文 id（建议与 `design/characters/<id>/` 同名）。

**安装提示路径非法？** 包内文件/引用必须是 ASCII 相对路径，不能有 `..`、反斜杠、盘符或 URL。用 `Compress-Archive` 重新打包。

**Windows 提示文件被占用？** 关闭正在占用图片的查看器/同步工具，或重启器灵；卸载会先把目录移到 `.trash`，下次启动清理。

**自定义性格动作不触发？** 确认它出现在 `tracks` 中，并在 `idleBeats` 里声明；未声明的额外动作只注册不播放。`butterfly`/`angry` 可在不声明时自动兜底。

## 10. 安全与隐私

- 安装只读取你选择的本地文件；不会联网下载资源包。
- 包内只接受 WebP/PNG 与 JSON；不会执行脚本、DLL、可执行文件或宏。
- 资源包内容不会上传；卸载只删除 `pet-packs/<id>`。
- 仍请只安装来源可信的资源包：恶意图片/畸形文件可能触发解码器问题，路径与大小校验用于降低风险而不是替代信任。

## 11. 版本兼容

- 当前 `schemaVersion` 为 `1`。器灵拒绝更高版本，不会猜测字段语义。
- 后续版本只做向后兼容的新增字段；`id`、`<characterId>-<action>`、`tags`、六轨语义与路径规则应保持稳定。
- 新增全局状态 ID 必须先更新《多角色动画资产规范》与运行时 `PET_STATES`；资源包自身不能把新动作变成全局状态。
