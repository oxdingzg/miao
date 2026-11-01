# REL-04：Rust 化完成与旧实现删除门槛

状态：设计待审阅，尚未授权删除实现或用户数据。核验基线为
`b093631182`（2026-10-28）；未来删除 PR 必须重新绑定自己的完整提交与产物。
V1→V2 退役、Rust 默认执行、Rust TUI 切换、纯 Rust 产品入口是不同的里程碑。

## 完成声明的范围

“Rust 单内核”要求每个 Session 的准入、执行、权限判定及持久化只有一个
权威；客户端、宿主工具和可选扩展不能重建第二个调度器。“完整 Rust 产品”
还要求默认 CLI、配置、账号、HTTP、后台服务等产品控制面迁移完成。
Rust TUI 通过 TS `__engine-shim` 准备产品引擎计划，并不满足后一个声明。
可选 JS worker 的存在本身不妨碍单内核，但默认功能不得依赖该 worker。

当前 TS runner、TS placement 及数据兼容读取仍存在。迁出共享价格、模型解析
或附件物化，只减少删除时的耦合，不证明其余调用方已退役。

## 门槛与必须提交的证据

| 门槛            | 通过条件                                                                                                                          | 删除 PR 所需证据                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| G1 唯一执行权威 | 新 Session、旧 Session 复用、精确重试、steer/queue、取消及并发都由 durable ownership 路由；不能靠缺 transport 回落到另一个 writer | 当前源码依赖清单、组合根检查；两种历史 placement 的迁移/拒绝测试；原生同 Session 串行与跨 Session 并发记录                  |
| G2 产品控制面   | 声明迁移的 CLI 命令、HTTP 分组、配置来源、账号、MCP/LSP、后台任务都有明确实现属主；默认启动不再暗中需要 TS 控制面                 | 冻结命令与接口清单逐项对应实现；从发布产物启动的正反例；不支持项清晰报错                                                    |
| G3 真实客户端   | Rust TUI、run、HTTP/SDK、Web/desktop、ACP 各自保留投递、审批、问答、改动与错误恢复语义                                            | 每个受支持客户端的版本、服务端 SHA、协议、操作步骤及原始结果；生成 SDK 与公共协议一致的检查                                 |
| G4 旧数据与历史 | 旧库中的文本、附件、工具结果、压缩、fork、revert、权限及导出在迁移后可读；失败不生成双 writer 或半绑定                            | 隔离副本上的迁移、故障注入、重复执行及反向恢复记录；备份标识与完整性核对；禁止以真实用户库做破坏性试验                      |
| G5 扩展与边界   | 默认启动与默认工具不依赖可选 JS 扩展；启用扩展后的取消、错误诊断和关闭有界                                                        | 移动到空目录、无源码及无外部 Bun 的产物验证；健康/损坏扩展混合与关闭回归；支持的 hook/provider/工具矩阵                     |
| G6 版本与协议   | root package.json 是版本来源，产物配对可核验；不兼容客户端/引擎在写库前明确拒绝                                                   | CLI、TUI、engine 的版本及 SHA256 清单；协议与 route schema 的有效、旧、不兼容、畸形输入测试；显式 binary 与自动发现分别核验 |
| G7 质量与资源   | 固定任务、模型参数、验证器、重复次数和预算；失败、重试、辅助调用及压缩都入报告                                                    | 逐次原始结果、成功率、全部开销/已验证成功数、墙钟时间与人工介入；未知计费保持未知；前后对照，不只摘成功样本                 |
| G8 发布与恢复   | 删除实现的 PR 已获批准并合入，精确 main SHA 的 CI 成功，受支持平台的最终产物可安装、启动及回退                                    | PR/review、main CI run、构建来源、产物校验、安装烟测、回滚命令与验证结果；实际 release/tag 链接                             |

所有要求都适用于声明支持的平台。被跳过或 non-blocking 的 Windows 检查不是
Windows 验收通过。构建与重型检查使用项目配置的构建机，机器细节不入仓库。

## 观察窗口和删除顺序

删除前须记录候选版本、开始/结束时间、受覆盖客户端与平台、观察到的失败及
修复后复验结果。窗口长度和退出条件必须作为该候选的审阅决定明确写下；当前
没有可据以声明“窗口已结束”的记录，不能从 CI 耗时或旧版本通过记录推导。

1. 迁出原生产品仍使用的共享能力，保留公共错误、服务及类型兼容入口。
2. 补齐属主路由、客户端和旧数据迁移证据；保留原始记录与已知失败。
3. 窗口通过后单独删除 TS provider loop 与 DI 绑定，再分别移除 admission 和
   placement fallback。每个 PR 重跑静态清单及有关行为测试。
4. 最后处理迁移命令、配置开关和旧表。执行器退役不自动授权删用户数据；历史
   读取、导出与 MIT 版权声明按其独立需求保留。

进程崩溃后的 provider continuation 仍可能不确定。删除或回滚不能引入自动
重发 provider 请求或重新执行工具；需要单独的 durable recovery 设计和证据。

## Bun/Node 必需依赖审计（2026-11-01，基线 `58118fc1dc`）

审计对象是**产品默认路径**：发布产物自身、默认启动、默认工具与默认会话执行。
开发/测试工具链、可选 worker、用户注册的外部程序分别记录，不与默认路径混算。

方法与来源（均可在该基线上复现）：

| 检查 | 命令/位置 | 结果 |
| --- | --- | --- |
| 产物形态 | `packages/miao/script/build.ts` 的 `compile` 块 | 单文件编译产物 `dist/<name>/bin/miao`，`target` 为 `bun-<os>`，`execArgv` 内嵌；JS 运行时**内嵌在产物里**，不要求用户另装 `bun` 或 `node` 命令 |
| 产物内容 | 同上 `files` / `define` | 树树语法 worker、Web UI、引擎模块以 `*.gen.ts` 内嵌；`MIAO_PACKAGED=true` 使沙箱以隐藏命令 `__sandbox-run` 重执行自身 |
| 外部 JS 运行时子进程 | `grep -rn 'Bun.spawn(\["bun"\|spawn(\["node"' packages/miao/src packages/core/src` | 默认路径无命中 |
| 自身重执行 | `process.execPath` 使用点（`installation/index.ts`、`cli/cmd/tui.ts`、`cli/cmd/uninstall.ts`） | 均指向编译产物自身，不是外部运行时 |
| 运行时依赖归属 | `packages/miao/package.json` 的 `dependencies` 与 `build.ts` 的 `external` | 运行时依赖（AI SDK providers 等）由构建期打包进产物；`external` 仅 `node-gyp`，默认路径不触发 |
| 可选扩展 worker | `packages/miao/src/engine/native-engine.ts:1186` | 仅在显式 `MIAO_ENGINE_WORKER=1` 时创建；缺失或握手失败只使扩展工具不可用 |

结论（只声明审计到的范围，不扩大）：

1. 产品默认路径**不需要**外部 `bun`/`node` 命令；它是单文件产物内嵌 JS 运行时。
2. 因此「用户没装 Bun」**不能**作为 Rust 化完成的证据：产品默认路径仍然执行 JS。
   这与 `rus05-runtime-boundaries.md` §3 的判定口径一致，G2/G5 不因此勾选。
3. 默认路径的可选扩展依赖是显式门控的；用户注册的 MCP/LSP/formatter/shell
   属外部程序能力，按其自身安装与诊断规则记录，不计入「JS 内核」。

仍未审计：编译产物在空目录、无源码且无外部 Bun/Node 的机器上的启动验证（G5 证据），
以及各受支持平台的独立复现记录。这两项需要真实产物与隔离环境，属于后续删除 PR 的前置证据。

## G6 证据：本地产物清点与不兼容引擎拒绝（2026-11-01）

这是**本机产物**的清点，不是一套发布产物，也不是 G6 的通过声明。它证明的是配对关系可被核验。

| 产物 | 版本 | SHA-256（前 16 位） | 引擎自报 |
| --- | --- | --- | --- |
| `~/.miao/bin/miao`（release 通道） | 0.3.23 | `c139faec33a012fb…` | — |
| `~/.local/bin/miao-preview`（本地构建） | 0.3.16 | `01cd1b8d61f8f935…` | — |
| `bench-engine/miao-engine`（基线 `58118fc1dc` 构建） | miao-engine 0.3.23 | `4d45ab6ca72141fc…` | `protocol 2`、`routes_schema 2` |
| `native-repair-preview/miao-engine`（2026-10-24） | miao-engine 0.3.1 | 未计入（早于基线） | `protocol 2`、`routes_schema 2`、`schema 21` |

注意最后一行：一个**更旧但协议相同**的引擎不会被协议守卫拒绝，因此「旧」不等于「不兼容」，两者要分开记录。

拒绝路径实测（`packages/miao/src/engine/discovery.ts`）：

- 构造一个自报 `protocol 1`、`routes_schema 1` 的引擎（脚本级替身，不写库）；
- `resolveEngine({ environment: { MIAO_ENGINE_BIN: <该替身> } })` 抛出：
  `MIAO_ENGINE_BIN=… reports protocol 1 and route schema 1 but this build requires protocol 2 and route schema 2`；
- 同一构建对基线引擎（`protocol 2`、`routes_schema 2`、0.3.23）**接受**。

即：不兼容引擎在写库前被明确拒绝，而不是静默回退。

仍未取得的 G6 证据：受支持平台上的发布产物与 CLI/TUI/engine 的**成对**校验清单、以及畸形输入（截断 JSON、缺字段）的用例记录。

## 证据记录与状态

每份候选记录至少包含：门槛 ID、完整源码 SHA、构建配置、平台、客户端/引擎
版本、产物哈希、命令/步骤、退出状态、原始日志路径或不可变链接、验证时间、
审阅结论。线上产物另附 tag/release 和安装后实际版本。日志不得包含凭据。

门槛状态使用 `not-run`、`passed`、`failed` 或 `blocked`；阻塞写明具体缺失。
延期或不支持需要明确调整产品支持范围，不能转换成 `passed`。实现、验收、
合入、发布分别记录；PR head 上通过的 CI 不能替代 squash 后 main 的发布检查。

## 基线上的已知未完成项

- 默认产品仍有 TS CLI/服务控制面；Rust TUI 使用产品引擎 shim。
- TS runner 仍有生产调用方和历史 placement。共享边界重构 #1596–#1598 仍是
  待合入 PR，不能当作基线已具备的能力。
- #1602 的编译产物 worker 启动、#1605 的诊断、#1608 的按完成任务统计，以及
  #1609 的长会话归档召回均待合入；这些切片也不单独满足整个 G5/G7。
- #1610 收紧 discovery capability 解码。`nativeEngineOptions` 的显式 binary
  分支仍直接采用覆盖值；不能把 discovery 的独立单测说成所有启动路径的握手证明。
- 当前没有本候选覆盖全部客户端、旧数据与回滚观察窗口的验收记录。
- 版本提升到 0.3.16 的源码提交不证明 0.3.16 已正式发布。

上述任一缺口仍在时，不声明完整 Rust 产品或整项 REL-04 完成。
相关实现与证据入口：
[引擎产品验收矩阵](../crates/miao-engine/docs/product-acceptance-matrix.md)、
[客户端历史验收记录](../crates/miao-engine/docs/client-acceptance-2026-10-24.json)、
[版本维护脚本](../script/set-version.ts)、
[精确 main CI 发布检查](../.github/scripts/check-release-ci.py)、
[发布工作流](../.github/workflows/release.yml)。
历史记录必须复核其版本和范围，不能直接搬作本候选的通过声明。
