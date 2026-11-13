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

按扩展名逐文件判定，一份索引同时容纳多种语言；`codegraph_status` 会按语言报告文件数。
共 41 种语法/组件格式：

| 家族 | 语言与扩展名 |
|---|---|
| JavaScript 系 | TypeScript `.ts .mts .cts`（含 `.d.ts`）、TSX `.tsx`、JavaScript `.js .mjs .cjs .jsx` |
| 单文件组件与标记 | Vue `.vue`、Svelte `.svelte`（取 `<script>`）、Astro `.astro`（取 frontmatter）、HTML `.html .htm`（取内联 `<script>`） |
| 系统语言 | Rust `.rs`、C `.c .h`、C++ `.cpp .cc .cxx .hpp .hh .hxx`、Zig `.zig`、Objective-C `.m .mm` |
| JVM 与 .NET | Java `.java`、Kotlin `.kt .kts`、Scala `.scala .sc`、C# `.cs`、F# `.fs .fsi .fsx` |
| 脚本语言 | Python `.py .pyi`、Ruby `.rb`、PHP `.php`、Lua `.lua`、Perl（未支持）、PowerShell `.ps1 .psm1`、Shell `.sh .bash .zsh .ksh` |
| 函数式 | Elixir `.ex .exs`、Erlang `.erl .hrl`、Haskell `.hs`、OCaml `.ml .mli`、Clojure（未支持） |
| 数据与科学 | Go `.go`、Julia `.jl`、R `.r`（大小写不敏感） |
| 接口与基础设施 | Protobuf `.proto`、GraphQL `.graphql .gql`、Terraform/HCL `.tf .hcl`、Solidity `.sol` |
| 其他 | Dart `.dart`、Swift `.swift`、Elm `.elm`、Nim `.nim`、GDScript `.gd`、Crystal `.cr` |

CSS/SCSS、YAML/TOML/JSON、Markdown、Dockerfile、Makefile、汇编**不索引**：它们没有函数级符号结构，
硬塞进符号图只会制造噪声（这些文件仍由 read_file/grep 等工具读取）。SCSS、Clojure、Perl 的语法
crate 依赖具体 `tree-sitter` 版本，会链接第二份 C 运行时，因此暂不引入。

单文件组件与 HTML 不是 JavaScript 文件：索引会按字节遮罩出 `<script>` 块（Astro 为 `---` 之间的
frontmatter，围栏本身也被遮掉），再用 TypeScript/JavaScript 语法解析。遮罩保持字节偏移与换行不变，
所以返回的行号与模型读到的文件完全一致，模板部分不会被当成代码。

跨文件解析按各语言的导入机制：TS/JS 相对路径与 `/index.*` 探测；Rust `use crate::/self::/super::`；
Python 点分模块；Go 包目录；Java/Kotlin/Scala/C# 的 `import a.b.Type`、C/C++/Objective-C 的
`#include`、PHP 的 `use`、Dart 的 `import`、Swift 的 `import`、Shell 的 `source`、Elixir 的
`alias/import/use`、Haskell 的 `import`、F#/OCaml 的 `open`、Julia 的 `using`、Nim 的 `import`、
Elm 的 `import`、Protobuf 的 `import`、Solidity 的 `import` 都按「末段名字 → 文件主名」匹配到工作区
文件，并回退到同目录兄弟文件（Go 包、barrel 模块）。

跨语言调用（例如 TS 经 N-API 调 Rust）不建边。未覆盖语言的文件不进索引，仍走原有
grep/glob/read/lsp 工具。

新增一门语言约 80–150 行：扩展名映射、`definition`/`callee`/`imports` 的节点分支、一条测试；节点
形态必须对着真实语法树核对——这些语法的差异很大（C 系函数名要剥两层 declarator、Swift/Kotlin/Dart
的调用名是无字段子节点、R 的定义在 `<-` 右侧、Elixir 用嵌套 `call` 表示定义、HCL 的名字在块标签里）。

代价是真实的：arm64 release 二进制从 6 种语言的 85 MB 增到 41 种格式的 **159 MB**，全新 release
构建约 1 分钟增到 2 分半左右。构建只在 CI 与发版时发生，日常增量构建不受影响；如果体积不可接受，
后续可以按语言族加编译特性开关（默认仍全量）。

## 已知边界
## 已知边界
## 已知边界

- 不跟随 `tsconfig` 的 `paths` 别名、workspace 包名导入、`build.rs` 生成代码与生成文件。
- 不做接收者类型推断，因此同名方法的调用按「同文件/唯一名」归并，可能指向同名的另一处定义。
- 未移植上游的框架感知合成器（路由、Angular/Tauri 等），因此这类间接调用不在图里。

## 实测（同一任务 A/B）

任务：追踪一次模型工具调用如何变成被执行的权限判定，指出准备调用、策略评估、能力门控三个函数并给出
`path:line`。同一二进制、同一模型（`mtty/claude-haiku-5-5`）、同一工作区快照，每臂独立数据库，
预热索引后跑三次配对：

| 指标 | 基线（关闭） | 开启索引 | 每次配对变化 |
|---|---|---|---|
| 输入 tokens | 414,572 / 476,223 / 1,638,187 | 324,676 / 280,854 / 565,171 | -22% / -41% / -66% |
| 输出 tokens | 3,538 / 3,884 / 10,095 | 2,638 / 3,363 / 3,796 | -25% / -13% / -62% |
| 轮次 | 8 / 10 / 25 | 6 / 6 / 11 | -25% / -40% / -56% |
| 工具调用 | 13 / 17 / 36 | 12 / 10 / 16 | -8% / -41% / -56% |
| 正确性（三项事实） | 3/3 | 3/3 | 持平 |
| 墙钟 | 33 / 36 / 96 s | 62 / 32 / 51 s | +88% / -11% / -47% |

三次合计的输入 tokens 为 2,528,982 对 1,170,701（-54%）。方差很大，因为模型会自行改变搜索策略：
基线单次最多用了 36 次工具调用（grep 20 / read_file 15 / glob 1）。三次配对里索引臂的输入 tokens、
轮次与工具调用都更低，正确性始终相同。

首次索引代价：冷启动一次调用解析 520 个文件用 4.5 s，随后每次调用继续推进（每次不超过 4.5 s），
约 2900 个文件在工作区里收敛完成；没有一次性长阻塞，但第一次回答可能因为「仍在构建」而不完整，
输出会明确说明。

指标口径：`miao stats --json` 取 token，`tool.planned` 事件数工具调用，答案以
`tools.rs` 的 `Tools::prepare`、`permission.rs` 的 `Policy::evaluate`、`tools.rs` 的
`Gates::derive` 三项是否带路径命中为准。
