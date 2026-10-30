# anim 交付目录

```
anim/
  <角色-动作>/                 # 例：诗琚-吊起/
    preview/
      all_in_one.webp          # 给人预览的整段动图（透明底），运行时不读
    tracks/
      frame001.webp            # 全局连续编号，与 phase asset.from/to 对齐
      frame002.webp
      …
      frame193.webp
    track_struct.json          # 相位、触发、中断、fit、规格（契约见本目录同名文件）
```

## 帧文件约定（v0.5.0）

| 项 | 值 |
| --- | --- |
| 画布 | **180 × 260**，透明底（方案1：scale 锁定 0.408，加高以容纳全序列上升） |
| 格式 | 有 alpha 的 WebP |
| 命名 | `frame` + 零填充序号 + `.webp`，`zeroPad: 3` → `frame001.webp` |
| 序号 | 从 1 起，与 `asset.from` / `to` 一致（含两端） |
| hover 首尾 | 循环段视觉无缝 |
| 预览 | `preview/all_in_one.webp` 仅审片用，勿当运行时序列 |
| 兼容 | 既有 `idle.webp` 多为 180×240；运行时按 `frameSize` 布局，idle 可居中叠放 |

源片可为 720² 透明 PNG；烘焙进 pet 画布后按上表交付。

## 相位 ↔ 帧（诗琚吊起实装 @ 24fps）

| phase | 资源 | 播放 | 触发 |
| --- | --- | --- | --- |
| idle | `animatedWebp` → `public/pet/idle.webp` | loop | 默认 / drop 结束后 fallback |
| lift | `frameSequence` 30–72 | once，末帧 hold → hover | pointerdown |
| hover | `frameSequence` 73–100 | loop，跟手 | pointermove，或 lift 末帧仍按住 |
| drop | `frameSequence` 101–193 | once，末帧 hold → idle | pointerup |

## 中断（详见 track_struct.json → interrupt）

- 抬起中松手 → 立刻 drop
- 抬起播完仍按住（无移动）→ 进 hover
- 落下中再按下 → 重播 lift
- 连点 → lift 遇 up 切 drop，结束回 idle

## 不放进本目录的

- 源视频、绿幕/白底未抠原片、rembg 对比样张 → 放旁路（如 `诗琚-吊起/white-frames/`、`rembg/`）
- 分镜表、定妆图 → 与 `anim/` 同级的 design 文档区

## 相位资源（v0.4+）

每个 `phases.<name>.asset` 二选一：

### 1. 一体化 animated WebP

```json
"asset": {
  "type": "animatedWebp",
  "src": "../../../public/pet/idle.webp",
  "fps": 24
}
```

- `src` 相对 **track_struct.json 所在目录** 解析（也可写仓库里已有的 `public/pet/*.webp`）。
- 运行时直接播该文件，不必再拆 `tracks/frameNNN.webp`。

### 2. 逐帧序列 frameSequence

```json
"asset": {
  "type": "frameSequence",
  "dir": "tracks",
  "pattern": "frame{NNN}.webp",
  "zeroPad": 3,
  "from": 30,
  "to": 72
}
```

同一 track 里可以混用：例如 idle 用 `public/pet/idle.webp`，lift/hover/drop 仍用本目录 `tracks/`。

## fit（v0.5.0 方案1）

- `scale` 锁定与站立 idle 对齐的 **0.408**（≈211/517）
- 全序列 alpha 包围盒缩放后高约 **247**，故 `frameSize.height` 抬到 **260**（含边距）
- `viewport` 固定；**帧内上升位移保留**，交给运行时跟手，不必动态 vy 跟框

预览用 `preview/all_in_one.webp` 仍仅审片，不参与相位播放。

## 多轨 / tracks.manifest

每个动作一条轨：`anim/<角色-动作>/track_struct.json`。仓库级目录在：

```
anim/
  tracks.manifest.json          # 运行时目录（id → path）
  demo-tracks.html              # 多轨切换演示
  <角色-动作>/
    track_struct.json
    …
  spec/
    tracks.manifest.json        # 契约说明（文档副本，可含 _comment）
```

- `tracks.manifest.json`：`version`、`defaultTrack`、`tracks[]`（`id` / `displayName` / `path` / `tags`）。
- `path` 相对 **`design/anim/`**（例：`诗琚-吊起/track_struct.json`）。
- 轨内 `asset.src`、`frameSequence.dir` 仍相对 **该轨的 `track_struct.json` 目录**。
- 演示：`demo-tracks.html` 先拉 manifest，再按 id 切轨、清 seq 缓存、preload、按 `frameSize` 重置画布；支持 `?track=<id>`。
- 仅含 `idle` 的轨（无 lift/hover/drop）合法；拖拽应 no-op / 保持 idle，勿抛错。
