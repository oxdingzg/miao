# 开源编程代理：工作流与实现差异

[English](agent-comparison.en.md)

Codex CLI、Gemini CLI、Qwen Code、opencode、Kimi Code、DeepSeek Harness、oh-my-pi 和 miao
都能围绕模型完成读代码、改文件、执行命令等工作。真正影响体验的，往往是**工具如何调度、
长命令如何处理、上下文怎样控制，以及失败后如何继续**，而不只是支持多少模型或工具。

本页由 miao 项目维护，也列出 miao 的限制。**核对日期：2026-10-07。** 比较对象是脚注注明的
源码快照，不是八个正式发布包的横向实测；部分代码来自开发分支或 nightly。表中的“支持”不等于
默认开启，“本次未见”只限所查路径，不能据此断言产品永远没有该能力。我们没有在同一任务集上
测过全部项目，因此不做总分、排行榜，也不宣称谁一定更快或更省钱。

## 先看你更在意什么

这是试用入口，不是推荐排名；许多场景会有多个合适的选择。

| 项目 | 值得关注的工作流 | 试用时重点确认 |
|---|---|---|
| Codex CLI[^codex] | 交互命令、批量补丁、多代理协作，以及与 Responses 后端协同的缓存与传输 | 增量请求、预热等收益依赖后端支持；Code Mode 有实验开关 |
| Gemini CLI[^gemini] | Gemini 模型工作流、后台命令、上下文管理与模型可用性路由 | 新上下文流水线与部分分类路由仍属实验；小模型调用也计入成本 |
| Qwen Code[^qwen] | 多供应商兼容、缓存共享压缩、按需工具与容量故障切备用模型 | 热压缩有模型和窗口条件；备用模型需配置；推测执行默认关闭 |
| opencode[^opencode] | 多供应商、终端与图形客户端、MCP/LSP，以及可扩展的编程工作流 | 快照并存 V1 发布路径与 V2 新核，不能把不同路径的能力拼成一个默认配置 |
| Kimi Code[^kimi] | 按文件访问冲突调度工具、批量子代理、限流下调整并发，以及 worktree 任务编队 | swarm、Tower 与动态工具加载有各自配置；本表核对的是 `MoonshotAI/kimi-code` 仓库 |
| DeepSeek Harness[^dsh] | 按 profile 组合运行时、脚本化工具调用、可继续子代理与用户路径性能预算 | 项目明确标为实验性开发预览；选择的 profile 决定实际工具与隔离范围 |
| oh-my-pi（omp）[^omp] | 哈希锚定编辑、原生搜索/文本工具、按角色选模型和结构化子代理报告 | 编辑格式会按模型切换；投机执行、checkpoint 与记忆等能力有开关 |
| miao[^miao] | 运行中补要求、持久化输入、后台协作、逐轮费用/缓存可见性，以及 mtty 集成 | pre-1.0；需核对构建来源；没有崩溃后自动续跑，OS 沙箱需显式开启 |

## 多个工具，是一起跑还是排队跑？

“模型一次提出多个调用”不代表它们一定并行。调度器还要处理文件冲突、权限和取消。

| 项目 | 轮内工具调度 | 对使用者的意义与限制 |
|---|---|---|
| Codex CLI | 可并行工具共享读锁，其他工具独占写锁 | 安全分类决定是否重叠；不是所有 shell 或写操作都并发 |
| Gemini CLI | 连续可并行调用组成一批；特定工具与 `wait_for_previous` 建立串行边界 | 独立调用可重叠，有依赖的调用仍应明确等待 |
| Qwen Code | Code Mode 内可并行调用工具，并设并发上限；原生工具调度是另一条路径 | 要区分脚本内并行与普通工具调用，不能把二者当成完全相同的能力 |
| opencode | V1 通过 AI SDK 结算；V2 以 fiber 提前执行已记录调用，继续前汇合 | 实现依运行路径而异；MCP Code Mode 又有独立的并发上限 |
| Kimi Code | 工具声明读/写路径，调度器按资源冲突决定并发或排队 | 不冲突的文件工作可以重叠；依赖访问声明的准确性 |
| DeepSeek Harness | 有界滚动池，独占调用设屏障，结果按模型顺序提交 | 调用完成后补充池；取消时也要结算已启动和未启动的调用 |
| oh-my-pi | `shared` / `exclusive` 分类；另有可选的流式投机执行 | 普通并行与参数尚未完整时的提前执行是两种机制；后者需要授权与丢弃处理 |
| miao | `concurrent` / `exclusive` 分类；只读工具可重叠，未声明工具默认独占 | 按工具类别而非文件路径调度；本次快照没有给所有 concurrent 调用统一加有界池 |

**批量工具脚本也不是某一家独有：**Codex 有实验性的 V8 Code Mode，Qwen 有沙箱脚本桥，
opencode 和 miao 有受限解释器，DeepSeek Harness 有 PTC / `run_code`，omp 的 eval 内核也能
回调工具。它们的工具范围、权限入口和可执行语言不同，不能只按“有/无”打勾比较。

## 长命令与子任务：等待方式不同

持久 shell 保留 `cd`、变量或函数；后台任务让主对话先继续。二者不是同一件事。

| 项目 | 长命令 | 子任务与结果取回 |
|---|---|---|
| Codex CLI | `unified_exec` 管理可持续交互的进程，保留有界输出 | 多代理工具支持派发、消息和等待聚合 |
| Gemini CLI | shell 可显式转后台，保留日志，完成行为可为注入、通知或静默 | 有子代理及结构化 `complete-task` 结果；具体工具要看所用 agent |
| Qwen Code | 普通命令按次起进程；支持 `is_background` 或运行中转后台，输出写文件，配套任务停止入口 | 顶层普通子代理默认后台，可显式 fork，完成时通知；嵌套调用和调用方持有的 worktree 有额外限制 |
| opencode | 所查 bash/shell 路径逐次起进程，不是跨调用持久 shell | 发布路径的 task 支持后台返回 job ID 与完成通知 |
| Kimi Code | bash 可转后台，配套 list/output/stop/wait 工具；所查路径每次起进程 | swarm 批量派发、恢复已有子代理，并在限流时收缩和恢复并发 |
| DeepSeek Harness | 有持久 bash 与 PTY，也有按所有者隔离的后台 job | one-shot 和 continuable 子代理、结束通知、消息续派；能力由 profile 决定 |
| oh-my-pi | 内置持久 shell；可按设置将长命令转后台，用 `wait` 取回 | worker pool、`agent://` 产物读取、schema 校验；批量提前启动是单独机制 |
| miao | 普通 bash 逐次起进程；`run_in_background`、`job_*` 和 monitor 构成后台闭环；terminal 工具提供独立 PTY | `task` 支持后台子会话、完成通知、报告读取与取消；最新源码可让只读子代理默认后台 |

miao 的只读子代理默认后台是 **v0.1.20 之后的源码行为**。后台任务属于窗口生命周期，关闭所属
miao 窗口不会留下常驻执行服务。保存会话历史与后台进程能否存活，应分别核对。

## 上下文、缓存与选模：省掉哪一种开销？

缓存减少重复前缀的处理，裁剪减少送入模型的内容，摘要把旧信息压缩成新文本；摘要自身也可能
产生模型调用。更低的压缩阈值、更小的模型或更多并发，都不自动代表更高的任务成功率。

| 项目 | 上下文与缓存路径 | 辅助模型与故障切换 |
|---|---|---|
| Codex CLI | 会话缓存 key、支持的 Responses/WebSocket 增量请求与预热，多种压缩路径，工具按需发现 | review 可指定模型，压缩有模型回退；这些不等于通用供应商轮换 |
| Gemini CLI | 历史压缩、旧工具输出遮蔽与蒸馏；新图式上下文流水线有实验 profile | 压缩/摘要用轻模型；可用性服务支持模型熔断与 fallback，部分复杂度分类实验性 |
| Qwen Code | 供应商缓存适配、工具延迟披露、具备条件才走缓存共享压缩；中文字符感知估算 | fast model 用于辅助工作；容量错误可按配置切备用，已有输出后禁止切换；受重试模式约束 |
| opencode | Anthropic 缓存断点、旧输出裁剪、摘要、全文落盘；V2 有系统上下文基线 | 标题/摘要可走小模型；发布与 V2 路径分别有重试机制，不能合并推断成统一模型降级链 |
| Kimi Code | 会话缓存 key、稳定工具声明、摘要与大输出落盘；动态工具加载依赖能力与实验开关 | swarm 可显式指定模型；本次未见按任务复杂度自动分流的通用角色路由 |
| DeepSeek Harness | 追加式系统/工具更新保留前缀、压缩；spill 可选，PTC 只回传指定输出 | 摘要可配独立模型；本次未见容量故障触发的通用备用模型链 |
| oh-my-pi | 内容摘要、按需工具、压缩；checkpoint/rewind 与图像式压缩各有开关 | 按角色配置模型，配备用链与凭据轮换；实际成本取决于启用的辅助调用 |
| miao | 稳定系统上下文基线、供应商缓存策略、统一输出预览与全文落盘、旧结果裁剪和摘要 | 标题可用轻模型，摘要可选小模型并回退；本次未见主任务的配置式备用模型链 |

大结果落盘、旧结果裁剪与摘要不是同一操作；回读方式与保留期也各有不同。
供应商计费、缓存写入价格和缓存路由都不同，本表不据此推导固定省钱比例。

## 少返工：编辑、重复调用与恢复

| 项目 | 编辑或失败处理的代表机制 | 需要区分的边界 |
|---|---|---|
| Codex CLI | 多文件 `apply_patch`、语法约束工具输入、进程/线程恢复与分叉 | 补丁能批量表达，不等于批内操作全部原子成功 |
| Gemini CLI | 路径纠错、重复调用/内容循环检测，可选 checkpoint 与工作区 restore | LLM 编辑纠错默认关闭；restore 是显式回滚，不是自动修复所有失败 |
| Qwen Code | XML 工具调用恢复、思考标签解析、上下文压缩失败熔断 | 工具调用格式恢复不等于编辑位置正确；推测执行不等于所有写入都可安全提前 |
| opencode | 模糊编辑匹配、批量 patch、read 后预热 LSP、写入后附诊断 | 这些共有能力不是 miao 独有；代际不同的路径应分别核对 |
| Kimi Code | 重复调用分级提醒与终止；恢复时补中断工具结果 | 恢复历史不代表原命令必然可以无副作用重跑 |
| DeepSeek Harness | 重复调用提醒、声明式超时、持久化 checkpoint 与恢复性能预算 | 重复提醒不一定强制终止；项目没有宣称经过安全审计 |
| oh-my-pi | 快照哈希锚定编辑、陈旧锚点恢复、可选小模型语法修复、LSP 写穿透 | 格式按模型选择；其编辑基准属于特定模型/任务，不是通用产品成功率 |
| miao | 模糊匹配失败后的快照换基恢复、条件写入、LSP 预热/诊断、同签名重复调用拒绝 | 换基要求唯一且有界的锚点；不确定则拒绝，不是“猜着改”；没有崩溃后自动执行续跑 |

**权限审批与 OS 隔离也要分开看。** Codex 有独立的沙箱策略；Gemini 有可配置的隔离运行方式；
DeepSeek Harness 明确声明开发预览与隔离限制。miao 的 OS 沙箱仅覆盖 bash，默认关闭，macOS/Linux
有后端、Windows 暂无；请求沙箱但后端不可用时默认告警后无沙箱运行，可改为拒绝。各项目的插件、
MCP 和远程执行环境还需单独核对，不能用一个“安全”勾选概括。

## miao 的位置与仍有的缺口

**比较直接的用途：**在长任务中继续补充约束，把待处理输入持久化；用后台子会话分担调查；查看
逐轮用量、费用估算和缓存状态；在 mtty 中接收代理状态与排队提示。这些机制让任务更可观察，
不等于模型本身更聪明。

**同样需要考虑的限制：**

- 尚未提供主任务自动切备用模型与凭据轮换，不能把传输重试当成模型降级。
- 工具类别级并发不等于 Kimi 的文件冲突调度，也没有统一的 concurrent 有界池。
- fork 使用新的会话缓存身份，没有共享父缓存 key 的同等路径；供应商仍可能按内容命中缓存，不能断言必然全部 miss。
- 没有 post-crash 自动续跑；重开历史需显式继续。内置 `recall` 查当前会话，不是自动沉淀的跨会话记忆。
- 当前源码仍有非会话服务迁移和接口演进工作；不把整个系统描述成已完成或零维护成本。

产品用途与方向见[为什么选择 miao](why-miao.zh.md)。

## 怎样判断对你更好用

选一个小修复、一个多文件改动、一个含长命令的任务，尽量在同一仓库、主模型、供应商配额和
权限条件下重复运行；专属后端特性另列一组，不强行抹平。保留配置、提交与任务日志，观察：

1. **完成质量：**测试是否通过，改动是否满足要求，人工纠正几次。
2. **总耗时：**区分模型等待、工具执行、重试与人工等待，而不是只看启动或某个 Rust 函数。
3. **真实用量：**包括辅助模型、缓存读写与失败尝试；不要只比较界面的费用估算。
4. **恢复行为：**断流、中断或进程退出后留下什么，继续时有没有重复副作用。

本页没有完成这组统一实验。miao 过去的 Rust/TypeScript 微基准、omp 的编辑评测和 DeepSeek Harness
的 CI 预算，各有自己的负载与测量端点，**不能排成同一张速度榜**。miao 的历史测量单独见
[原生组件基准](native-benchmarks.zh.md)；操作步骤见[使用指南](guide.zh.md)。

## 证据与版本

以下脚注链接固定到研究所用源码，不会随默认分支漂移。正文是从实现归纳的工作流说明；没有
重新跑全部项目的二进制、模型任务或安全审计。更新本页时，应同时更新快照、正文与中英文版本。

[^codex]: `openai/codex@19c4793`（2026-10-06）：[并行门](https://github.com/openai/codex/blob/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/tools/parallel.rs)、[缓存/传输/预热](https://github.com/openai/codex/blob/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/client.rs)、[持久执行](https://github.com/openai/codex/blob/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/unified_exec/mod.rs)、[多代理与 Code Mode](https://github.com/openai/codex/tree/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src/tools)、[压缩与配置](https://github.com/openai/codex/tree/19c4793964f3d70a9c916010376f96f636847a95/codex-rs/core/src)。
[^gemini]: `google-gemini/gemini-cli@ef59c53`（2026-10-06，nightly）：[调度](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts)、[上下文模块](https://github.com/google-gemini/gemini-cli/tree/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context)、[后台 shell 工具](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/tools/shellBackgroundTools.ts)、[路由](https://github.com/google-gemini/gemini-cli/tree/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/routing)、[可用性](https://github.com/google-gemini/gemini-cli/tree/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/availability)、[循环检测](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/loopDetectionService.ts)、[checkpoint 与 sandbox 文档入口](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/README.md)。
[^qwen]: `QwenLM/qwen-code@f338578`（2026-10-06）：[Code Mode 并发](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/docs/design/code-mode-concurrency.md)、[缓存共享压缩](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/services/chatCompressionService.ts)、[模型 fallback](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/core/llm-chat.ts)、[XML 恢复](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/core/xml-tool-call-fallback.ts)、[fast model 与推测执行](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/docs/users/features/followup-suggestions.md)、[缓存与工具](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/docs/users/features/context-cost.md)、[后台 shell](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/tools/shell.ts)、[后台子代理](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/tools/agent/agent.ts)、[任务停止](https://github.com/QwenLM/qwen-code/blob/f338578520eb765f8605d57dc07af94897345e1d/packages/core/src/tools/task-stop.ts)。
[^opencode]: `anomalyco/opencode@ecc4916`（2026-10-06）：[V2 runner](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/core/src/session/runner/llm.ts)、[发布路径 task](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/tool/task.ts)、[V1 工具、LSP 与 shell](https://github.com/anomalyco/opencode/tree/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src)、[V2 输出治理](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/core/src/tool-output-store.ts)、[缓存策略](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/llm/src/cache-policy.ts)、[Code Mode](https://github.com/anomalyco/opencode/tree/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/codemode)。
[^kimi]: `MoonshotAI/kimi-code@21406fb`（2026-09-30）：[冲突调度](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts)、[swarm 批调度](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/features/swarm/session/agentRunBatch.ts)、[工具与后台任务](https://github.com/MoonshotAI/kimi-code/tree/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools)、[输出落盘](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts)、[重复调用处理](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts)、[缓存与工具声明](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/kosong/src/message.ts)。
[^dsh]: `deepseek-ai/deepseek-harness@5badb15`（2026-10-03）：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md)、[持久 shell](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/shell/tool-bash-persistent/README.md)、[子代理](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/subagent/tool-subagent/README.md)、[压缩](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/compaction/compaction-basic/README.md)、[spill](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/spill/spill-policy/README.md)、[PTC](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/ptc-runtime/README.md)、[guard](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/guard/README.md)、[性能方法](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/benchmarks/AGENTS.md)、[安全边界](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/SAFETY.md)。
[^omp]: `can1357/oh-my-pi@add251b`（2026-10-07）：[工具调度](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/agent/src/agent-loop.ts)、[哈希锚点恢复](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/crates/pi-edit/src/modes/hashline/recovery.rs)、[模型角色](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/coding-agent/src/config/model-roles.ts)、[报告读取](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/coding-agent/src/internal-urls/agent-protocol.ts)、[编辑与 LSP](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/packages/coding-agent/src/edit/index.ts)、[功能、默认开关与自报评测](https://github.com/can1357/oh-my-pi/blob/add251b8cd607ee327b5155711fc4a5021bd0ded/README.md)。
[^miao]: `oxdingzg/miao@4b01a140e`（2026-10-07）：[调度/子代理/重复调用](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/packages/core/src/session/runner/llm.ts)、[输出治理](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/packages/core/src/tool-output-store.ts)、[压缩](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/packages/core/src/session/compaction.ts)、[编辑恢复](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/docs/edit-recovery.md)、[后台与生命周期](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/docs/runtime.md)、[权限与沙箱](https://github.com/oxdingzg/miao/blob/4b01a140edcef2d0e5f20a62603c7aaf0aa77bdc/SECURITY.zh.md)。
