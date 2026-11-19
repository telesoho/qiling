# Issue tracker: GitHub

本仓库的 issue 与 PRD 都放在 GitHub Issues。所有操作使用 `gh` CLI。

- 仓库：`telesoho/qiling`（在 clone 内运行时，`gh` 会自动从 `git remote -v` 推断）

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，并把标签一起读出来。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`
- **打 / 摘标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

## Pull request 作为 triage 入口

**PRs as a request surface: no.**（若改成 `yes`，外部 PR 会和 issue 走同一套标签与状态，`/triage` 会读取这个开关。）

当设为 `yes` 时：

- **读取 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的条目（去掉 `OWNER` / `MEMBER` / `COLLABORATOR`）。
- **评论 / 标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label` / `--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，`#42` 可能是任一；先 `gh pr view 42`，失败再回退到 `gh issue view 42`。

## 技能说「publish to the issue tracker」

创建一个 GitHub issue。

## 技能说「fetch the relevant ticket」

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个 issue，其 ticket 是它的 child issue。

- **Map**：单个 issue，标签 `wayfinder:map`，正文承载 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：用 GitHub sub-issue 挂到 map（`gh api` 调 sub-issues 端点）。sub-issue 不可用时，把 child 加进 map 正文的 task list，并在 child 正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research` / `prototype` / `grilling` / `task`）。认领后 assign 给驱动的 dev。
- **Blocking**：用 GitHub 原生 issue dependencies（UI 可见的规范表示）。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞方的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number` 也不是 `node_id`）。GitHub 用 `issue_dependencies_summary.blocked_by` 报告（只算 open 阻塞方，即实时闸门）。dependencies 不可用时退回在 child 正文顶部写 `Blocked by: #<n>, #<n>`。全部阻塞方关闭即解除。
- **Frontier 查询**：列出 map 下 open 的 child，剔除仍有 open blocker（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有 open issue）或有 assignee 的；按 map 顺序取第一个。
- **Claim**：`gh issue edit <n> --add-assignee @me` —— 本会话的第一次写操作。
- **Resolve**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（gist + 链接）追加到 map 的 Decisions-so-far。
