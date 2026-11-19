# Domain Docs

**布局结论：single-context** —— 一个仓库共用一份根目录的 `GLOSSARY.md`，架构决定放在 `docs/adr/`。

工程类技能在探索代码库前如何消费本仓库的领域文档。

## 探索前先读这些

- 根目录 **`GLOSSARY.md`** —— 本仓库唯一的术语表 / 通用语言。
- （仅多上下文仓库）根目录 **`GLOSSARY-MAP.md`**，它指向每个上下文各自的 `GLOSSARY.md`；读与当前任务相关的那几份。
- **`docs/adr/`** —— 读与即将改动的区域相关的 ADR。多上下文仓库还要看 `src/<context>/docs/adr/` 下的上下文级决定。

这些文件不存在时 **静默跳过**：不要提示缺失，也不要一上来就建议创建。`/domain-modeling`（经由 `/grill-with-docs` 与 `/improve-codebase-architecture`）会在术语或决定真正被确定时惰性创建它们。

## 文件结构

Single-context（本仓库）：

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context（根目录出现 `GLOSSARY-MAP.md` 时）：

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← 系统级决定
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← 上下文级决定
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

本仓库当前不创建 `GLOSSARY-MAP.md`，也不创建各子项目的 `GLOSSARY.md`；留到第一次真正写下词条时再建。

## 使用术语表的词汇

当输出中出现领域概念（issue 标题、重构提案、假设、测试名），使用 `GLOSSARY.md` 中定义的术语。不要漂移到术语表明确回避的同义词。

需要的概念还不在术语表里，这本身是个信号——要么你在发明项目不用的语言（重新考虑），要么是真的缺一条（记下来交给 `/domain-modeling`）。

## 标记 ADR 冲突

如果输出与既有 ADR 矛盾，明确指出来，不要静默覆盖：

> _这与 ADR-0007（event-sourced orders）矛盾——但值得重开，因为……_
