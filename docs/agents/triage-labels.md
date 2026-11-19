# Triage Labels

技能以五个规范 triage 角色说话。本文件把角色映射到本仓库 issue tracker 里实际使用的标签字符串。

| 技能里的角色 | 本仓库的标签 | 含义 |
| ---------------------- | -------------- | ---- |
| `needs-triage`         | `needs-triage`     | 维护者需要评估这个 issue |
| `needs-info`           | `needs-info`       | 等待报告者补充信息 |
| `ready-for-agent`      | `ready-for-agent`  | 已完整规格化，可交给 AFK agent |
| `ready-for-human`      | `ready-for-human`  | 需要人类实现 |
| `wontfix`              | `wontfix`          | 不会处理 |

当技能提到某个角色（例如「apply the AFK-ready triage label」）时，使用表中对应的标签字符串。

## Wayfinder 标签

供 `/wayfinder` 使用，与 triage 五角色互不替代：

| 标签 | 用途 |
| ---- | ---- |
| `wayfinder:map` | 探索地图本体（单个 issue） |
| `wayfinder:research` | 地图下的研究票 |
| `wayfinder:prototype` | 地图下的原型票 |
| `wayfinder:grilling` | 地图下的拷问票 |
| `wayfinder:task` | 地图下的实施票 |

打标签时严格遵循技能规则；除技能明确要求的之外，不额外强制任何标签。
