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

### 候选 v0.3.25 的观察窗口（2026-11-02 开窗）

窗口本身现在是一条可审计的记录，而不是「等有人决定」：

| 项 | 值 |
| --- | --- |
| 候选版本 | `0.3.25`（tag `v0.3.25`，提交 `2af2a57a85`，已发布为 Latest） |
| 开窗时间 | 2026-11-02 |
| 计划闭窗 | 2026-11-16（14 天；长度作为本候选的决定写下，不再悬空） |
| 覆盖客户端 | headless `miao run`、本地构建的 TUI 预览、`miao-engine 0.3.25` |
| 覆盖平台 | darwin-arm64、linux-x64、windows-x64（本文件已冒烟）；darwin-x64 仅 Rosetta |
| 退出条件 | 窗口内无阻断性缺陷；G1–G4 证据齐备；闭窗时把窗口内失败与复验结果逐条列出 |
| 已观察失败 | 无（记录起点；本行只写观察到的事实，不写预期） |

未声明通过：窗口尚在期内。闭窗需要的是**流逝的时间**与期内真实失败记录，这两者
不能由本文档自行断言，但窗口的存在、边界与退出条件已不再缺失。

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

### G5 证据：发布产物在空目录与无外部运行时下的启动（2026-11-02）

对象是**已发布产物**，不是候选构建：`miao-darwin-arm64.zip`（release `v0.3.25`）。

| 检查 | 做法 | 结果 |
| --- | --- | --- |
| 产物校验 | 下载 zip 与 `.sha256` 后比对 | `6bc66c62…868c` 一致 |
| 形态 | 解压后的目录 | 单个 `miao` 可执行文件 233,971,264 字节，另有 `models.json` 与 LICENSE/NOTICE |
| 二进制哈希 | `shasum -a 256 miao` | `08c99c46…9428` |
| 外部运行时 | `env -i PATH=/usr/bin:/bin sh -c 'command -v bun; command -v node'` | 两者均 absent |
| 启动 | `env -i PATH=/usr/bin:/bin HOME=… ./miao --version` | 输出 `0.3.25` |
| 动态依赖 | `otool -L ./miao` | 仅 `/usr/lib/` 下的 libicucore、libresolv、libc++、libSystem |

结论只覆盖审计到的范围：macOS arm64 的发布产物在没有源码树、没有外部 Bun/Node、只有系统库可用的环境里可以启动。

同一检查在 **Linux x64** 上用另一台无 Bun/Node 的机器复现（2026-11-02）：

| 检查 | 做法 | 结果 |
| --- | --- | --- |
| 产物校验 | `miao-linux-x64.tar.gz` 与 `.sha256` | `935e494f…9f05` 一致 |
| 形态 | 解压后目录 | 单个 `miao` 265,377,248 字节，另有 `models.json`、LICENSE/NOTICE |
| 外部运行时 | `command -v bun; command -v node` | 两者均 absent |
| 启动 | `env -i PATH=/usr/bin:/bin HOME=… ./miao --version` | 输出 `0.3.25` |
| 动态依赖 | `ldd ./miao` | 仅 linux-vdso、libc、ld-linux、libpthread、libdl、libm |

同一检查在 **Windows x64** 上再次复现（2026-11-02，Windows 10.0.22621 构建机，无 Bun/Node）：

| 检查 | 做法 | 结果 |
| --- | --- | --- |
| 产物校验 | `miao-windows-x64.zip` 与 `.sha256` | `6f68f26c…4aad` 一致 |
| 形态 | 解压后目录 | `miao.exe` 256,337,920 字节，另有 `models.json`、LICENSE/NOTICE |
| 外部运行时 | `$env:PATH="C:\Windows\System32;C:\Windows"` 后探测 | 两者均 absent |
| 启动 | 同一精简 PATH 下运行 `miao.exe --version` | 输出 `0.3.25` |

三个平台（darwin-arm64、linux-x64、windows-x64）都是同一结论：发布产物在没有源码树、没有外部 Bun/Node 的环境里可以启动。

**darwin-x64** 用同一份发布产物在 macOS arm64 构建机上经 Rosetta 以 x86_64 执行（2026-11-02）：

| 检查 | 做法 | 结果 |
| --- | --- | --- |
| 产物校验 | `miao-darwin-x64.zip` 与 `.sha256` | `e091d260…0381` 一致 |
| 形态 | 解压后目录 | `./miao` 229,169,632 字节，`file` 报 `Mach-O 64-bit executable x86_64` |
| 启动 | `env -i PATH=/usr/bin:/bin … arch -x86_64 ./miao --version` | 输出 `0.3.25` |

这条只证明「x86_64 产物在 Rosetta 翻译层下可启动」，**不是**在真实 Intel Mac 上的原生运行；后者仍未取得。

**健康/损坏扩展混合**（2026-11-02 复核，实测而非推断）：

| 用例 | 断言 |
| --- | --- |
| `worker-load-diagnostics.test.ts`「a failed project tool import is diagnosed without losing healthy worker tools」 | 同一 `.miao/tool` 目录里 `broken.js` 缺依赖时，`healthy.js` 仍可 `tool.list` 与 `tool.call`，`shutdown` 后进程以 0 退出；诊断包含 `[worker-host]`、`broken.js` 与缺失依赖名 |
| 同文件三例（`import` / `missing` / `flood`，需真实引擎） | 失败到达产品连接，而引擎仍可用（`flood` 用 32 个损坏工具触发上限并明确写出「further diagnostics omitted」） |

`MIAO_ENGINE_BIN=… bun test test/engine/worker-load-diagnostics.test.ts` → 4 pass / 0 fail。因此本条不再列为缺口。

**linux-arm64 不再靠手工补**：本机没有 arm64 Linux 主机，`docker run --platform linux/arm64` 在 x86_64 主机上也因缺 binfmt/QEMU 直接 `exec format error`。因此把冒烟移进**发布工作流自己构建产物的那条腿**（#2331）：每条 cli 腿都在目标架构的 runner 上构建并按 `runner.os`/`runner.arch` 启动自己刚产出的文件，五个平台按构造覆盖，验证的正是要发布的那个文件。

仍未取得：darwin-x64 的**原生** Intel 运行（当前只有 Rosetta 翻译层结果）。

**darwin-x64 原生验证显式延期（2026-11-10，所有者决定）**：现有构建机均为 arm64
（2026-11-10 探测 `macmini` 报 `arm64`），所有者决定不再为原生 Intel 验证购置或指派
硬件，等**真实 Intel 用户反馈**再启动；此前 Rosetta 结果继续作为该平台仅有的事实记录。
这是一次明确记录的延期，不是通过声明：G5 的其余证据不受影响，本条不转为 `passed`，
触发条件只有一条——收到 Intel Mac 上的真实用户问题。

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

畸形输入已在 `packages/miao/test/engine/discovery.test.ts` 覆盖：非 JSON 帧、
截断帧（进程中途死亡留下的合法帧前缀）、缺 `protocol` 的帧、`routes_schema` 与
`routesSchema` 互相矛盾、以及非数值 schema。每种都断言 `capabilities()` 返回
`undefined`，且显式 `MIAO_ENGINE_BIN` 以 `cannot report capabilities` 拒绝启动，
而不是静默回退。其中非 JSON 与矛盾帧先有，截断帧与缺字段由 #2101 补上。

仍未取得的 G6 证据：受支持平台上的发布产物与 CLI/TUI/engine 的**成对**校验清单。

## 证据记录与状态

每份候选记录至少包含：门槛 ID、完整源码 SHA、构建配置、平台、客户端/引擎
版本、产物哈希、命令/步骤、退出状态、原始日志路径或不可变链接、验证时间、
审阅结论。线上产物另附 tag/release 和安装后实际版本。日志不得包含凭据。

门槛状态使用 `not-run`、`passed`、`failed` 或 `blocked`；阻塞写明具体缺失。
延期或不支持需要明确调整产品支持范围，不能转换成 `passed`。实现、验收、
合入、发布分别记录；PR head 上通过的 CI 不能替代 squash 后 main 的发布检查。

## 基线上的已知未完成项

- 默认产品仍有 TS CLI/服务控制面；Rust TUI 使用产品引擎 shim。
- TS runner 仍有生产调用方和历史 placement。
- 共享边界重构 #1596–#1598、编译产物 worker 启动 #1602、worker 诊断 #1605、
  按完成任务统计 #1608、长会话归档召回 #1609、discovery capability 解码 #1610，
  均已于 2026-10-28 合入 `main`（2026-11-01 复核：八个 merge commit 都是
  `origin/main` 的祖先）。合入一个切片不等于该门槛通过：G5/G7 仍需隔离环境与
  逐次原始结果的证据。
- `nativeEngineOptions` 的显式 binary
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
