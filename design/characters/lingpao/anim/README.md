# 灵泡 · 动画说明

灵泡是**参数化 SVG 角色**，不是逐帧位图角色，因此这里没有 `track_struct.json`、`tracks/` 或 `preview/` 动画交付物。

运行时实现：

| 文件 | 作用 |
| --- | --- |
| `src/pet/lingpao.ts` | 五态 / 说话 / 拎起 / 音乐档位 → 姿态参数（眼、嘴、道具、倾斜） |
| `src/pet/SvgSprite.tsx` | 内联 SVG 骨架与运行期动画（眨眼、眼神跟随、三档律动） |
| `src/pet/lingpao.css` | 待机漂浮、呼吸、说话嘴、拎起、音符与道具动画 |
| `src/pet/music.ts` | 三档滞回阈值、节拍时钟、运动分层 |
| `src-tauri/src/music.rs` | 系统音频回环（WASAPI）与分析、事件 |

设计源与原型仍在：

- `../sheets/state-preview.html`：12 个状态样张
- `../sheets/lingpao-groove.html`：听音乐三档原型（**运行时阈值与运动参数的来源**）
- `../sheets/lingpao-idle.svg`：待机定稿

灵泡**不进** `design/anim/tracks.manifest.json`、不参与 `npm run bake:anim`、也不进 `.qilingpet` 资源包格式。资源包页面用 `public/pet/lingpao/thumb.svg` 作为缩略图。

改动画时：

1. 先改设计样张，确认三档动作与表情；
2. 再同步 `src/pet/lingpao.ts` / `SvgSprite.tsx` / `lingpao.css`；
3. 跑 `npm test`，并用 `?character=lingpao&music=calm|groove|intense` 在浏览器预览逐档核对。