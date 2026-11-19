# 器灵（qiling）— AI 代理入口

- 产品／协议：见根目录 `README.md`、`docs/openapi.yaml`
- **美术与 `design/` 目录规划**：必读 [`design/AGENTS.md`](design/AGENTS.md)
- 动画契约：`design/anim/spec/`（`track_struct.json`、`folder.md`、`tracks.manifest.json`）
- 运行时桌宠资源：`public/pet/`
- 改 design 结构或落新角色资产前，按 `design/AGENTS.md` 的目标树落位，不要往 `design/` 根目录继续堆文件

## Agent skills

### Issue tracker

GitHub Issues（`telesoho/qiling`，用 `gh` CLI 操作）。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五角色标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

single-context — 一个仓库共用一份根目录的 `GLOSSARY.md`，架构决定放 `docs/adr/`。See `docs/agents/domain.md`.
