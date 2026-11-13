# 内置代码索引（codegraph）

`miao` 自带一个本地代码索引：把工作区的符号、调用与导入写进一个 SQLite 文件，再把
四个只读工具交给模型。它的目的不是替代 grep，而是把「先搜再读」的多轮往返压成一次调用。

实现映射自 [CodeGraph](https://github.com/colbymchenry/codegraph)（MIT）的 schema 与
`explore` 单次回答契约；抽取器与解析器是为 `miao` 独立实现的 Rust 代码，见
`crates/miao-codegraph/`。

## 开关

索引默认关闭：工具定义本身要占 token，是否索引一个工作区属于使用者的决定。

```jsonc
// miao.jsonc
{ "codegraph": { "enabled": true } }
```

```bash
MIAO_CODEGRAPH=1 miao run "..."   # 单次运行覆盖配置，用于 A/B 对比
```

关闭时四个工具不出现在工具表里；开启但引擎没有私有 store 时同样不出现（没有地方落盘
就不假装有能力）。

## 工具

| 工具 | 作用 |
|---|---|
| `codegraph_explore` | 主入口：按查询返回目标符号的逐行源码与它们之间的调用路径，一次调用给出「已经读过」的答案，并列出没展开的部分 |
| `codegraph_node` | 读一个文件（带行号，附导入它的文件）或读一个符号（附调用者与被调用者） |
| `codegraph_callers` | 列出一个符号的调用点 |
| `codegraph_status` | 覆盖率：文件、符号、调用边、未解析引用、语言分布、库大小与刷新情况 |

## 索引

- 位置：引擎私有 store 旁的 `codegraph/<workspace-hash>.db`，一个工作区一个文件；不写仓库，也不产生工作树变更。
- 增量：按 `size + mtime` 判断，只重解析变化的文件；遍历有预算（默认 1500 文件 / 4000 ms），未完成的部分下次调用继续，输出会说明「仍在构建」。
- 抽取：tree-sitter 逐文件一次深度优先遍历，同时得到定义嵌套与调用归属。
- 解析分四层：同文件 → 经 import 到达的文件 → 全局唯一名 → 唯一限定名后缀。标准库宏/方法（`println!`、`unwrap`、`console.log` 等）在抽取阶段丢弃，不污染统计。
- 抽取器语义变化时 `extract::VERSION` 加一，索引自行丢弃重建，不会混用两代行。

## 语言

TypeScript、TSX、JavaScript、Rust、Python、Go。混合仓库可用，`codegraph_status` 会按语言报告覆盖；
跨语言调用（例如 TS 经 N-API 调 Rust）不建边。未覆盖语言的文件不进索引，仍走原有
grep/glob/read/lsp 工具。

## 已知边界

- 不跟随 `tsconfig` 的 `paths` 别名、workspace 包名导入、`build.rs` 生成代码与生成文件。
- 不做接收者类型推断，因此同名方法的调用按「同文件/唯一名」归并，可能指向同名的另一处定义。
- 未移植上游的框架感知合成器（路由、Angular/Tauri 等），因此这类间接调用不在图里。

## 实测（同一任务 A/B）

任务：追踪一次模型工具调用如何变成被执行的权限判定，指出准备调用、策略评估、能力门控三个函数并给出
`path:line`。同一二进制、同一模型（`mtty/claude-haiku-5-5`）、同一工作区快照，每臂独立数据库，跑两轮：

| 指标 | 基线（关闭） | 开启索引 | 变化 |
|---|---|---|---|
| 输入 tokens | 414,572 / 476,223 | 324,676 / 280,854 | -32%（均值） |
| 输出 tokens | 3,538 / 3,884 | 2,638 / 3,363 | -17%（均值） |
| 轮次 | 8 / 10 | 6 / 6 | -33%（均值） |
| 工具调用 | 13 / 17 | 12 / 10 | -27%（均值） |
| 正确性（三项事实） | 3/3 | 3/3 | 持平 |
| 墙钟 | 33 s / 36 s | 62 s / 32 s | 首轮含索引构建，暖索引后更快 |

指标口径：`miao stats --json` 取 token，`tool.planned` 事件数工具调用，答案以
`tools.rs` 的 `Tools::prepare`、`permission.rs` 的 `Policy::evaluate`、`tools.rs` 的
`Gates::derive` 三项是否带路径命中为准。
