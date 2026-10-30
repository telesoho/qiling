# design/ — AI 与协作者目录约定

> 本文件供人和 AI 代理阅读。改 `design/` 结构、落新角色资产、或挪动画轨之前，先读完再动手。
> **目标结构**（下文「目标树」）已落地；**现状**见文末。新建文件一律按目标树落位。

## 原则

1. **交付可运行**：给程序吃的轨只含 `track_struct.json`、`tracks/`（或指向 `public/` 的 animatedWebp）、`preview/`。
2. **工坊可丢弃／可 LFS**：源片、抽帧、rembg、对比图、pipeline 脚本放 `_workshop/`，不进运行时路径。
3. **一轨一 JSON**：每个动作目录一份 `track_struct.json`；多轨用 `anim/tracks.manifest.json` 索引，不把多轨塞进同一文件。
4. **定妆与动分离**：定妆图、否决稿在角色 `sheets/`；动画在角色 `anim/`；产品级品牌视觉在 `_brand/`。
5. **运行时装在 `public/`**：已烘焙的桌宠 WebP 等放仓库根 `public/pet/`（及以后的 `public/...`）；`design/` 不替代 `public/`。
6. **契约在 `anim/spec/`**：schema／示例／folder 说明只放那里；角色目录不复制过期 example。

## 目标树

```text
design/
  AGENTS.md                 # 本文件
  _brand/                   # 产品级视觉（非单角色）
    icons/                  # 器灵图标源稿（1024 等）
    chrome/                 # 语言泡泡等壳层 UI 定稿
  characters/
    shiju/                  # 诗琚（棋灵／桌宠）
      sheets/               # 定妆、探索稿、否决稿
      ui/                   # 角色相关 UI 稿（若有）
      docs/                 # 分镜表、设定短文
      anim/
        pickup/             # 吊起：仅交付物
          track_struct.json
          tracks/
          preview/
        idle/               # 可仅 track_struct → public/pet/idle.webp
        butterfly/
        angry/
        …
      _workshop/            # 源视频、white-frames、rembg、pipeline、compare
    dafeiyu/                # 大肥鱼／小鲸娘／鲸鱼娘（对外可称鲸鱼娘）
      sheets/
      docs/
      anim/
      _workshop/
  anim/
    spec/                   # 跨角色契约
      folder.md
      track_struct.json     # 现行 schema 说明（随版本升）
      tracks.manifest.json  # manifest schema 说明
    tracks.manifest.json    # 活清单：id → characters/.../anim/.../track_struct.json
    demo-tracks.html        # 多轨演示（从仓库根静态服务）
```

## 角色目录命名

| 对外称呼 | 目录 id | 备注 |
| --- | --- | --- |
| 诗琚 | `characters/shiju/` | 红唐装圆扇定妆；桌宠五态 + 吊起 |
| 大肥鱼／小鲸娘／鲸鱼娘 | `characters/dafeiyu/` | Q 版鲸尾女孩；画风独立，不强求与诗琚统一 |

新建角色：复制 `characters/_template/`（若尚无则按上表建齐 `sheets|docs|anim|_workshop`），再在 `anim/tracks.manifest.json` 登记轨。

## 动画轨交付清单（每个 `anim/<action>/`）

必有：

- `track_struct.json` — 相位、触发、interrupt、`fit`、`assetTypes`（见 `anim/spec/`）
- 资源二选一或混用：
  - `asset.type: frameSequence` → 本目录 `tracks/frameNNN.webp`
  - `asset.type: animatedWebp` → `src` 相对本 JSON，常指向 `../../../../../public/pet/...`（以实际相对深度为准）

可选：

- `preview/all_in_one.webp` — 仅审片
- 轻量轨可无 `tracks/`，只挂 public WebP

禁止放进交付目录：

- 源 mp4、绿幕／白底未抠序列、rembg 中间 PNG、pipeline 脚本、尺寸对比图 → `_workshop/`

## 多轨清单

`design/anim/tracks.manifest.json`：

- `defaultTrack`：默认 id
- `tracks[]`：`id`、`displayName`、`path`（相对 `design/anim/` **或** 改为相对 `design/` 的稳定路径；迁移后应改为相对 `design/` 或写 `characters/...`，并同步改 demo）、`tags`
- 当前 8 条：pickup + idle/butterfly/angry + explain/think/advantage/disadvantage（后四条是五态姿势轨，仅 idle 相位）
- 演示：`design/anim/demo-tracks.html`（仓库根 `http://127.0.0.1:8765/...`）
- 运行时：`npm run bake:anim` 把设计清单烘焙到 `public/pet/anim/`（生成物、gitignore），桌宠 fetch 该运行时清单；不要手改生成目录

## 与仓库其它目录的边界

| 路径 | 职责 |
| --- | --- |
| `design/` | 设计源、契约、工坊、交付轨 |
| `public/pet/` | 运行时已烘焙桌宠动画；`public/pet/anim/` 由 `npm run bake:anim` 生成（gitignore），勿手改 |
| `src-tauri/icons/` | 应用图标导出（由 `_brand/icons` 源稿生成） |
| `assets/qiling/` | 语音等非视觉资源 |
| `docs/` | HTTP／OpenAPI，不放美术 |

## 迁移时 AI 应遵守

1. 先更新本文件与 `anim/spec/`，再搬文件。
2. 搬完后全局搜旧路径（`design/anim/诗琚-吊起`、根目录定妆文件名等），改 manifest、demo、文档。
3. 大体积 `_workshop` 建议 gitignore 或 Git LFS；不要把 white-frames／rembg 拷进 `public/`。
4. 不要删用户未确认的源片与定妆探索稿；否决稿进 `sheets/archive/` 而非直接删。
5. 中文显示名可留在 JSON `displayName`；目录优先稳定英文 id（`shiju`、`dafeiyu`）。

## 现行版本锚点（动画契约）

- `track_struct` **v0.5.0**：方案1，诗琚吊起 `frameSize` 180×260，`scale`≈0.408，帧内上升保留；`phases.*.asset` = `animatedWebp` \| `frameSequence`。
- 多轨：`tracks.manifest` + `demo-tracks.html`。

## 现状（迁移完成，2026-10-30）

已按目标树迁完：

- `_brand/icons/`、`_brand/chrome/`：器灵图标与语言泡泡定稿
- `characters/shiju/sheets|docs|anim/{pickup,idle,butterfly,angry,explain,think,advantage,disadvantage}|_workshop/pickup/`
- `characters/dafeiyu/sheets|docs|anim(.gitkeep)|_workshop/`（绿幕源 mp4）
- `anim/spec/` 未动；`anim/tracks.manifest.json` 与 `demo-tracks.html` 路径已更新
- 运行时多轨：`npm run bake:anim` 从 `anim/tracks.manifest.json` 生成 `public/pet/anim/manifest.json` + 8 条轨（含 pickup 逐帧、7 条姿势 WebP 轨）；桌宠由 `src/pet/anim.ts` 在运行时 fetch，`?track=<id>` 可在浏览器预览锁定任一轨

已知残留：

- `design/anim/诗琚-吊起/` 为空目录；被仍在跑的旧 `_serve_demo.py`（python PID 占用该路径，:8765）锁住。停掉该进程后删空目录即可。新脚本在 `characters/shiju/_workshop/pickup/_serve_demo.py`。

`public/pet/` 只保留姿势 WebP 源；`public/pet/anim/` 是生成目录，不进 git。新建文件请直接写到目标路径。
