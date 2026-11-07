# 多角色动画资产规范

> 官方规格：器灵桌宠「多角色」动画状态与资产交付约定。  
> 状态：现行产品约定（与 `src/pet/states.ts`、`src/pet/pickup.ts`、`design/anim/tracks.manifest.json` 对齐）。  
> 帧级契约与 bake 细节仍以 `design/anim/spec/`、`design/AGENTS.md` 为准；本文只规定**跨角色统一的状态 ID、分层与交付清单**。

## 1. 目的与适用范围

### 1.1 目的

- 让多个角色（诗琚 `shiju`、大肥鱼／鲸鱼娘 `dafeiyu`、后续新角色）共用**同一套状态 ID**，运行时只切换皮肤／轨资源，不改业务状态机。
- 明确每个角色「必做 / 建议 / 可选」动画轨，控制 MVP 成本，避免为近似语义重复做轨。
- 给出与现有 `PET_STATES` / `IDLE_BEATS` / pickup 相位、以及外部参考（OpenPets `allowedReactions`）的映射，便于接入与扩展。

### 1.2 适用范围

| 适用 | 不适用 |
| --- | --- |
| 桌宠可见动画轨的状态命名、分层、角色交付清单 | 改 `src/pet` 运行时逻辑（本文不替代代码） |
| `design/characters/<id>/anim/` 交付目录约定 | 帧尺寸／抠图／bake 流水线细节（见 `design/anim/spec/folder.md`） |
| 产品／美术／接入方对齐「要做哪些动作」 | Spirit Protocol 消息字段定义（见 `docs/spirit-protocol-v1.md`） |

### 1.3 角色目录锚点（现行仓库）

| 对外称呼 | 目录 id | 现行动画交付 |
| --- | --- | --- |
| 灵泡（默认） | `characters/lingpao/` | SVG 骨架，由 `src/pet/SvgSprite.tsx` 直接绘制；无位图轨、不进 manifest/bake |
| 诗琚 | `characters/shiju/` | 已有 8 轨：`pickup`、`idle`、`butterfly`、`angry`、`explain`、`think`、`advantage`、`disadvantage` |
| 大肥鱼／小鲸娘／鲸鱼娘 | `characters/dafeiyu/` | `anim/` 尚空（仅占位）；需按本文 MVP 补齐 |

---

## 2. 设计原则

1. **三层语义，一套 ID**  
   动画按「日常循环 / 任务反应（助手）/ 交互与性格点缀」分层理解，但**对外与运行时只用统一英文 `stateId` / tag**，不按角色另起一套状态名。

2. **状态 ID 全局共享，素材按角色分轨**  
   - 业务与协议只认：`idle`、`think`、`explain`、`advantage`、`disadvantage`、`pickup`（及后续扩展 ID）。  
   - 每个角色各自提供轨：`design/characters/<characterId>/anim/<action>/`。  
   - Manifest 轨 `id` 形如 `<characterId>-<action>`（例：`shiju-idle`）；**tags 必须同时含动作 tag 与角色 id**（例：`["idle","shiju"]`），以便按角色 + 状态取轨。

3. **MVP 先齐 6 轨，再点缀**  
   新角色最短可合并：`idle` + `think` + `explain` + `advantage` + `disadvantage` + `pickup`。性格节拍与 walk／wave 等后置。

4. **忙碌类外部状态合并，不拆轨**  
   OpenPets 一类细粒度「working / editing / running / testing」等，MVP **共用一条 `work`（或暂映射到 `think`）+ 气泡文案**，不为每个近义活动单独做近似动画。

5. **可选情绪可映射，不强制新 ID**  
   `celebrate` → 可用 `advantage`；`error` → 可用 `disadvantage`。有余力再补独立轨。

---

## 3. 状态分层表

约定三层（A／B／C）。「代码锚点」列标明现行仓库是否已有实现。

### A. 日常循环

角色在无任务、无强交互时的循环与位移感。

| stateId / 轨 action | 中文 | 优先级 | 代码锚点 | 说明 |
| --- | --- | --- | --- | --- |
| `idle` | 待机 | **必做** | `PET_STATES.idle`；`IDLE_BEATS.breath.track = 'idle'` | 基础循环；manifest tag `idle` |
| `breath` | 呼吸节拍 | （逻辑名） | `IDLE_BEATS.breath` | **不是独立交付轨**；复用 `idle` 轨 |
| `walk` | 走动 | 建议 | 尚无 | 桌面位移／巡游感；建议 action 目录 `walk/`，tag `walk` |
| `sleep` | 睡觉 | 可选 | 尚无 | 长时间空闲；可后补 |

### B. 任务反应（助手）

对「思考／讲解／局势好坏／忙碌」的助手姿态。与 `PET_STATES` 一一对应的是前五项。

| stateId / 轨 action | 中文 | 优先级 | 代码锚点 | 说明 |
| --- | --- | --- | --- | --- |
| `think` | 思考 | **必做** | `PET_STATES.think` | tag：`pose` + `think` |
| `explain` | 讲解 | **必做** | `PET_STATES.explain` | tag：`pose` + `explain` |
| `advantage` | 优势／积极 | **必做** | `PET_STATES.advantage`；`mood === 'up'` | tag：`pose` + `advantage`；也可承接 celebrate |
| `disadvantage` | 劣势／当心 | **必做** | `PET_STATES.disadvantage`；`mood === 'down'` | tag：`pose` + `disadvantage`；也可承接 error |
| `work` | 忙碌／干活 | 建议（可映射） | 尚无独立 ID | 建议：多忙碌态共用一轨 + 气泡；未交付前可暂映到 `think` |

### C. 交互反应与性格点缀

指针交互与角色个性短动画；**不进入 `PET_STATES` 五态枚举**，但由轨 tags / 相位机驱动。

| stateId / 轨 action | 中文 | 优先级 | 代码锚点 | 说明 |
| --- | --- | --- | --- | --- |
| `pickup` | 吊起 | **必做** | `PickupPhase`：`idle` \| `lift` \| `hover` \| `drop`（`src/pet/pickup.ts`） | 一轨多相位；现行诗琚轨 id 为 `shiju-pickup-hover`，tag `pickup` |
| `wave` | 挥手／打招呼 | 建议 | 尚无 | 建议 action `wave/`，tag `wave` |
| `butterfly` | 追蝴蝶 | 建议（性格） | `IDLE_BEATS.butterfly` | 诗琚已有；他角可换等价性格 beat，**仍用统一 tag 或登记新 tag 时写进本表** |
| `angry` | 生气 | 建议（性格） | `IDLE_BEATS.angry` | 同上；诗琚约 1% 触发 |
| `celebrate` | 庆祝 | 可选 | 尚无 | 可先映射 `advantage` |
| `error` | 出错 | 可选 | 尚无 | 可先映射 `disadvantage` |

> **性格点缀约定：** 每个角色 MVP 后「建议再做 1 条」个性 idle beat。诗琚已用 `butterfly` / `angry`；大肥鱼等可做语义不同的 beat，但须在 manifest tags 与 `IDLE_BEATS`（或后继配置）登记，**禁止**为同一语义起角色专属状态名（如 `dafeiyu-happy-idle` 当作全局 stateId）。安装态资源包用 `pet.json.idleBeats` 作为该「后继配置」（见 §7.3）。

---

## 4. 每个角色：必做 / 建议 / 可选

与上表一致，便于美术排期勾选。

### 4.1 必做（MVP，最短可合并）— 6 轨

| # | action 目录 | 对应 |
| --- | --- | --- |
| 1 | `idle/` | A 待机 |
| 2 | `think/` | B 思考 |
| 3 | `explain/` | B 讲解 |
| 4 | `advantage/` | B 优势 |
| 5 | `disadvantage/` | B 劣势 |
| 6 | `pickup/` | C 吊起（含 lift / hover / drop 相位） |

诗琚：上述 6 项均已在 `design/anim/tracks.manifest.json` 登记（另含性格轨，见下）。  
大肥鱼：上述 6 项为接入前的最短清单。

### 4.2 建议（MVP 之后优先）

| action | 说明 |
| --- | --- |
| `walk/` | 日常循环增强 |
| `wave/` | 交互打招呼 |
| **1 条**个性 idle beat | 诗琚已有 `butterfly` + `angry`；新角色至少 1 条（可先做一条） |
| `work/`（或明确映射到 `think`） | 合并 OpenPets 忙碌态 |

### 4.3 可选（有余力）

| action | 说明 |
| --- | --- |
| `sleep/` | 长闲置 |
| `celebrate/` | 否则映射 `advantage` |
| `error/` | 否则映射 `disadvantage` |
| 更多性格 beat | 须登记 tag，不另造全局状态机分支 |

---

## 5. 与现有代码对齐说明

### 5.1 `PET_STATES`（`src/pet/states.ts`）

现行五态（测试 `states.test.ts` 亦锁定此顺序与 id）：

| id | label | track（取轨用） | file（历史单文件名） |
| --- | --- | --- | --- |
| `idle` | 待机 | `idle` | `idle.webp` |
| `explain` | 讲解 | `explain` | `explain.webp` |
| `think` | 思考 | `think` | `think.webp` |
| `advantage` | 优势 | `advantage` | `advantage.webp` |
| `disadvantage` | 劣势 | `disadvantage` | `disadvantage.webp` |

多角色时：**不要改这些 id**；按角色切换带对应 tag 的轨资源即可。

### 5.2 `IDLE_BEATS`（同文件）

| beat key | track | 说明 |
| --- | --- | --- |
| `breath` | `idle` | 默认呼吸，复用 idle 轨 |
| `butterfly` | `butterfly` | 约 20%（`pickIdleBeat`：`0.01 ≤ roll < 0.21`） |
| `angry` | `angry` | 约 1%（`roll < 0.01`） |

`ms` 仅为回退时长；运行时优先轨烘焙的 `durationMs`（见 `design/anim/spec/folder.md`）。

内置角色仍使用上表；**安装态资源包**可在 `pet.json.idleBeats` 里登记自定义 beat，运行时以声明为准；未声明时若存在 `butterfly`/`angry` 轨则自动沿用，缺 beat 回退呼吸（见 §7.3）。

### 5.3 pickup（`src/pet/pickup.ts`）

- 相位：`idle` → `lift` → `hover` → `drop`（再回 idle）。  
- 完整三段（lift/hover/drop）齐全才进入吊起相位机；否则拖拽只移窗口。  
- Manifest：诗琚轨 id `shiju-pickup-hover`，tags `["pickup","shiju"]`，路径 `../characters/shiju/anim/pickup/track_struct.json`。

### 5.4 运行时取轨（现行）

据 `design/anim/spec/folder.md`：

- tag `pickup` → 吊起相位机  
- `idle` / `butterfly` / `angry` → 待机节拍  
- `pose` + `explain`｜`think`｜`advantage`｜`disadvantage` → 说话姿势  

多角色扩展时：**在现有动作 tag 上增加角色 tag**，取轨改为「当前角色 ∩ 动作」，而不是改动作名。

### 5.5 姿态与台词（已有逻辑，资产侧需知）

- `poseForLine`：`idle` / `thinking` → `idle`/`think`；说话中按 `mood` 选 `advantage` / `disadvantage` / `explain`。  
- `bubbleLine`：`explain`｜`advantage`｜`disadvantage` 可展示外部台词；其余用姿势短句。

---

## 6. 与 OpenPets `allowedReactions` 映射

OpenPets 反应名为**外部参考**，不是器灵运行时 API。接入或对照时按此表映射；**忙碌类合并**，避免为 editing／testing 等各做一套近似动画。

| OpenPets reaction | 映射到器灵 | 层级 | 备注 |
| --- | --- | --- | --- |
| `idle` | `idle` | A | 直接对应 |
| `thinking` | `think` | B | 直接对应 |
| `waiting` | `idle` 或 `think` | A／B | 短等待偏 idle；长时间思考偏 think |
| `waving` | `wave`（建议）／暂 `idle` | C | 无 wave 轨时先 idle |
| `success` | `advantage` | B | 积极反馈 |
| `celebrating` | `celebrate`（可选）或 `advantage` | C／B | 可选独立轨 |
| `error` | `error`（可选）或 `disadvantage` | C／B | 可选独立轨 |
| `working` | `work`（建议）或 `think` | B | **合并** |
| `editing` | 同上 `work`／`think` | B | **不要**单独做轨 |
| `running` | 同上 | B | **不要**单独做轨 |
| `testing` | 同上 | B | **不要**单独做轨 |

气泡文案区分忙碌子场景（「编译中」「跑测试」等），动画共用一轨即可。

---

## 7. 文件／目录命名约定

### 7.1 已落地（以仓库为准，必须遵守）

```text
design/characters/<characterId>/anim/<action>/
  track_struct.json          # 必有
  tracks/frameNNN.webp       # frameSequence 时
  preview/all_in_one.webp    # 可选，仅审片

design/anim/tracks.manifest.json   # 活清单：登记全部角色轨
design/anim/spec/                  # 契约与示例（跨角色）
public/pet/anim/                   # bake 生成物（gitignore），勿手改
```

| 项 | 现行约定 | 示例 |
| --- | --- | --- |
| 角色目录 | 稳定英文 id | `shiju`、`dafeiyu` |
| 动作目录 | 英文 action = 状态／轨语义；小写字母开头，允许数字与下划线，不用连字符 | `idle`、`pickup`、`water_splash` |
| Manifest 轨 id | `<characterId>-<action>`；pickup 诗琚为历史名 `shiju-pickup-hover` | `shiju-idle`、`dafeiyu-think` |
| tags | 动作 tag + 角色 id；姿势轨另加 `pose` | `["pose","explain","shiju"]` |
| path | 相对 `design/anim/` | `../characters/shiju/anim/idle/track_struct.json` |
| displayName | 可用中文 | `诗琚·待机` |
| 帧文件 | `frame` + 零填充 + `.webp`，`zeroPad: 3` | `frame001.webp` |

工坊源片、绿幕、rembg 中间结果 → `characters/<id>/_workshop/`，**不得**放进交付 `anim/<action>/`。

细节见：`design/AGENTS.md`、`design/anim/spec/folder.md`（画布、fit、bake、`animatedWebp` vs `frameSequence`）。

### 7.2 建议（仓库尚无统一处，新角色按此执行并标「建议」）

1. **新 pickup 轨 id** 建议用 `<characterId>-pickup`（与 `shiju-idle` 对称）。诗琚保留 `shiju-pickup-hover` 作为历史 id，**不必强行改名**以免破坏 bake／测试；新角色不要再发明第三种命名。  
2. **性格 beat 目录名** 用稳定英文语义（`butterfly`、`angry`、或新角色的 `water_splash`、`tail_wag` 等），并在本文 §3 与 manifest tags 登记；action 允许小写字母、数字与下划线，不使用连字符；禁止只用中文目录名。  
3. **角色专属 public 源 WebP**（若不用 tracks 逐帧）建议：`public/pet/<characterId>/<action>.webp`，由该角色 `track_struct` 的 `animatedWebp.src` 相对引用。现行诗琚多姿势仍指向 `public/pet/*.webp` 根下文件——迁移时可逐步收拢，**非阻塞 MVP**。  
4. **多角色默认轨**：`tracks.manifest.json` 的 `defaultTrack` 可为当前默认角色的 pickup 或 idle；切换角色时由运行时按角色 tag 重选，不靠改 action 名。

### 7.3 安装态资源包（`.qilingpet`）

内置角色走 `design/` + `npm run bake:anim`；安装态角色走自包含资源包，两者在运行时遵守同一套 stateId／tag／轨 id 约定。包格式、校验与制作步骤见 **[角色资源包：制作与安装](pet-packs.md)**。

- **编译而非手写**：`pet.json.tracks[].action` 在安装时编译为 §7.1 的条目：`id = <characterId>-<action>`，`tags = [action, characterId]`（姿势动作加 `pose`），`path = tracks/<action>/track_struct.json`。作者不写 id/tags/path。`action` 允许小写字母、数字与下划线，不使用连字符。
- **必做动作**：`idle`、`think`、`explain`、`advantage`、`disadvantage`；`pickup` 默认必须为 animated（lift/hover/drop 三段逐帧）。允许 `"pickup": "window-only"` 声明「暂无吊起、仅移窗」的例外。
- **性格 beat**：`pet.json.idleBeats` 是 §3 所说的「后继配置」；未声明时自动沿用 `butterfly`/`angry`，缺 beat 回退呼吸。自定义动作必须先出现在 `tracks` 中。
- **运行时消费**：与 §5.4 完全一致；`walk`/`wave`/`work`/`sleep`/`celebrate`/`error` 等额外动作可注册，但当前版本不消费，不得宣称已实现（§9.6）。
- **路径**：包内 `path` 相对包根（不是 `design/anim/`）；`asset.src`、`frameSequence.dir` 仍相对该轨 `track_struct.json`。

### 7.4 内置 SVG 角色（灵泡）

灵泡是默认内置角色，用参数化 SVG 骨架渲染，不属于位图轨模型：

- `ActiveCharacter.renderer` 为 `"svg"` 或 `"webp"`；旧数据缺省按 `"webp"`。
- SVG 角色**不进** `design/anim/tracks.manifest.json`、不参与 `npm run bake:anim`、也不进资源包格式；`?track=` 预览只对位图角色生效。
- 姿态由 `src/pet/lingpao.ts` 的 `poseForRuntime` 从五态、说话、拎起、音乐档位映射；渲染与动画在 `src/pet/SvgSprite.tsx` 与 `src/pet/lingpao.css`。
- 听音乐的三档（舒缓／轻快／激烈）是**运行期视觉状态**，沿用 §3 的 `idle` stateId，不新增协议 stateId，也不改变对外 `state`／`phase`／`mood`。
- 音乐阈值的默认值、节拍时钟与运动参数以 `design/characters/lingpao/sheets/lingpao-groove.html` 为准；用户可在设定页覆盖识别阈值。运行时实现见 `src/pet/music.ts` 与 `src-tauri/src/music.rs`。
- 灵泡没有吊起逐帧轨：拖拽时用 SVG 形变（拉长 + 摆动）表达，窗口本身仍跟手移动。

---

## 8. 验收标准

### 8.1 最短可合并（单角色 MVP）

- [ ] 该角色具备 §4.1 的 **6 条轨**，且均已写入 `design/anim/tracks.manifest.json`。  
- [ ] 每条轨有合法 `track_struct.json`；`pickup` 含可用的 lift／hover／drop（或文档声明暂无吊起、仅移窗——但 MVP 目标是完整吊起）。  
- [ ] `npm run bake:anim` 后，运行时能按 tag 取到该角色的 idle／think／explain／advantage／disadvantage／pickup。  
- [ ] 五态与吊起在桌宠预览（`?pet=1`，必要时 `&track=<id>`）可手动或逻辑切换，无缺轨报错。

### 8.2 多角色回归

- [ ] **同一 stateId**（如 `explain`）在切换角色（皮肤）后，播放的是**该角色**对应轨，而不是串用另一角色素材。  
- [ ] Manifest 中两条角色轨不得共用同一 `id`；靠 tags 区分角色。  
- [ ] 未交付的建议／可选轨不得阻断五态 + pickup；缺 `wave`／`walk` 时应有明确回退（idle／think），不抛错。  
- [ ] 性格 beat：无该角色 beat 时回退 `breath`／`idle`，不强依赖诗琚的 butterfly／angry 文件。

### 8.3 文档与契约

- [ ] 新 action 若升为全局 stateId，先更新本文与 `PET_STATES`／配置，再加资产。  
- [ ] 帧级变更走 `design/anim/spec/`，不在本文复制过期 schema。

### 8.4 安装态资源包

- [ ] 安装后编译出的轨 id 为 `<characterId>-<action>`，tags 含 action + 角色 id（姿势含 `pose`），不同角色不共用 id。
- [ ] 切换角色后，同一 stateId 只播当前角色轨；资源包不得回退使用诗琚的 idle／姿势／beat 文件。
- [ ] 缺建议／可选轨不阻断；缺姿势回退该角色 idle；缺 pickup 且声明 `window-only` 时仅移窗；缺 beat 回退呼吸。
- [ ] 卸载当前角色回默认灵泡；内置角色（灵泡、诗琚）不可卸载；替换同 id 包需明确确认。
- [ ] 非法规格（缺 MVP、路径穿越、超限、pickup 不符）被拒绝且无半安装。
- [ ] `walk`／`wave`／`work` 等未消费动作只注册，不在 UI／文档冒充已实现。

---

## 9. 不要做清单

1. **不要**为每个角色发明另一套状态名（如诗琚 `explain`、大肥鱼 `lecture`）。  
2. **不要**为 OpenPets 的 `editing`／`testing`／`running`／`working` 各做一套近义动画；合并为 `work`（或暂用 `think`）+ 气泡。  
3. **不要**把性格 beat 的目录／中文名当成全局 `PET_STATES` id。  
4. **不要**在角色 `anim/<action>/` 交付目录塞源视频、绿幕未抠序列、rembg 中间物（放 `_workshop/`）。  
5. **不要**手改 `public/pet/anim/` 生成物；改设计源后重新 bake。  
6. **不要**在未扩展状态机前，把 `celebrate`／`error`／`sleep`／`walk`／`wave` 写成「已实现 API」；未落地前只在资产与映射表中规划。  
7. **不要**让多角色切换依赖改 `PET_STATES` 数组内容；只切换带角色 tag 的轨。

---

## 10. 参考索引（仓库内）

| 资源 | 路径 |
| --- | --- |
| 五态与 idle 节拍 | `src/pet/states.ts` |
| 吊起相位机 | `src/pet/pickup.ts` |
| 设计清单 | `design/anim/tracks.manifest.json` |
| 目录约定 | `design/AGENTS.md` |
| 帧／bake 契约 | `design/anim/spec/folder.md` |
| 角色资源包格式与安装 | `docs/pet-packs.md` |
| 资源包注册表与协议 | `src-tauri/src/pet_pack.rs` |
| 运行时角色加载 | `src/pet/packs.ts` |
| 开发计划（提及 OpenPets 等为调研线索） | `docs/development-plan.md` |

---

## 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-11-03 | 初版：多角色共享 stateId、三层清单、与 PET_STATES／IDLE_BEATS／pickup／OpenPets 映射、目录约定与验收。 |
| 2026-11-03 | 增补 §7.3 安装态资源包（编译映射、pickup 例外、idleBeats）与 §8.4 资源包验收；§5.2 补 beat 后继配置。 |