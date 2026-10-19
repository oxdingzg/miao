# 开启原生引擎：启用范围、缺口与效率证据

[English](native-engine-enablement.en.md)

本文回答三个问题：把会话放到原生（Rust）引擎后，**哪些能力被启用**、**相对 TypeScript 运行时缺什么**、以及**性能、token 消耗与任务效果有没有「不低于 TS」的证据**。

代码入口与文档证据都指向当前 `main`；进度状态以 [路线图](roadmap.md) 与其 §9 启用门槛为准（英文版另见 `crates/miao-engine/docs/` 下的 `inventory.md`、`live-eval.md`、`switch-plan.md`、`product-acceptance-matrix.md`）。

## 1. 开启条件

原生会话由两个开关共同决定，缺一不可：

| 开关                     | 作用                                                                                                                                                                                                                      | 入口                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 引擎可发现               | 组装 native transport，`/api` 才能把会话路由到引擎。显式 `MIAO_ENGINE_BIN` 优先，否则按安装目录自动发现；`--capabilities` 必须报 `protocol >= 2`，显式指定的旧引擎直接启动失败，自动发现的旧引擎被忽略（TS 会话照常运行） | `packages/miao/src/engine/discovery.ts`、`packages/miao/src/server/server.ts` |
| `MIAO_ENGINE_STORAGE`    | 新会话才落成 `engine: "rust"` 并分配引擎存储；没有它，即使 transport 已组装，新会话仍由 TS 创建                                                                                                                           | `packages/server/src/handlers/session.ts`                                     |
| 可选 `engine.*` 全局配置 | 模型/endpoint、role、prompt cache、Responses 契约、MCP/LSP/hooks 配置路径、`context_limits` 等；环境变量逐键覆盖配置                                                                                                      | `packages/schema/src/config.ts`、`packages/miao/src/engine/native-engine.ts`  |

绑定是 **per-Session 且不可变**的：placement 目录是路由唯一权威，跨引擎/跨存储/跨 Location 的接管被拒绝，老 TS 会话继续由 TS 拥有（`packages/core/src/session/engine-placement.ts`、`projector.ts`、`routing.ts`）。已有会话想换引擎只能走**离线迁移**（冻结、transfer bundle、导入后接管），没有 live 热切（`packages/core/src/session/migration.ts`、`transfer-bundle.ts`）。

## 2. 开启后启用的能力

- **Session core 全在 RS**：durable admission、exact retry、steer/queue、resume、fork、revert/unrevert、compaction、recovery、取消级联（进程组清理）、`tool.started`/`tool.progress` 增量进度。
- **工具面**：引擎自带目录（`read_file`/`read_image`/`list_files`/`glob`/`grep`/`write_file`/`edit_file`/`apply_patch`/`bash`、`start_job`/`job_status`/`cancel_job`、`task`、`todowrite`、`goal`、`question`、`recall`、`session_state`、`schedule_wakeup`/cron、`lsp_*`、`monitor`、webfetch/websearch、knowledge、skill、session 终端），工具名到产品渲染 id 的映射见 `crates/miao-engine/docs/facade-mapping.md`。
- **扩展面**：MCP（stdio/HTTP、resources/prompts、OAuth、`list_changed` 刷新、`tool_search` 发现）、生命周期 hooks、ADR-12 worker（`.miao/tool`、`.opencode/tool`、`MIAO_CONFIG_DIR` 下的自定义工具文件）、会话级终端（Unix）、LSP（由产品配置自动生成 manifest）。
- **模型与路由**：host manifest 生成的路由（Anthropic、OpenAI Chat/Responses、订阅 Responses、Gemini、Bedrock SigV4 或 bearer、Copilot 风格、Azure/Vertex 等声明式路由）、会话级模型绑定与变体、purpose role、prompt cache 与 Responses cache/WebSocket 契约。
- **上下文**：ambient context（instructions/skills/references 映射为 host manifest）、自动压缩与工具输出裁剪（**需要 `engine.context_limits`**，见 §3）、recall、context epoch。
- **观测**：per-run usage 聚合、per-turn 计费 cache 谱系（read/write/nonCached/hitRatio）与 TTFT（写入 `engine_timing` 侧表，不进可重放 payload）。
- **协议面**：stdio、loopback HTTP（含 SSE）、ACP stdio adapter。

引擎侧另有做过消融测量的机制（同轮声明式读并行 A6、行窗口读取与锚定编辑/漂移控制 A2/A3、`--verify-command` 完成检查、按 handle 可恢复的输出裁剪、编辑后诊断与读预热 A7）。这些是引擎实现；TS 侧存在部分对应物（read 的 offset/limit、edit 快照、编辑后 LSP 诊断、`packages/core/src/session/prune.ts`），不要把它们当作纯 RS 增量。

## 3. 相对 TypeScript 的缺口

| 缺口             | 现状                                                                                                                                                                                                                                                                                                                                                                 | 证据                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 产品级工具       | `send_message`、`list_sessions`、`read_session_context`、delegation `report`、`workflow`、worktree、`push_notification` 由 TS runner 注册（`packages/core/src/session/runner/llm.ts`）。引擎侧反向桥已写入（`crates/miao-engine/src/product.rs`、`tools.rs`、`--product-tools`），但 TS 宿主不写该清单、也不应答 `product_tool` 请求，因此原生会话目前拿不到这批工具 | `54357739c0`（#1027，标注 draft）                                                                            |
| 插件面收窄       | 原生会话只覆盖自定义工具文件、hooks manifest、MCP；插件 `tool.definition`/`before`/`after` 钩子不生效，插件自带的非标准 AI SDK provider 不会映射成路由                                                                                                                                                                                                               | `crates/miao-engine/docs/product-acceptance-matrix.md`（G6）、`packages/miao/src/engine/product-routes.ts`   |
| 自动压缩默认不同 | TS 侧 `auto: true`、阈值 0.9；RS 的自动触发由 `engine.context_limits` 决定，**不配置就是关**，长会话更容易撞窗口                                                                                                                                                                                                                                                     | `packages/core/src/session/compaction.ts`、`packages/schema/src/config.ts`、`crates/miao-engine/src/main.rs` |
| 计费与展示       | 原生会话的 pricing 仍按 0 处理到价格解析落地；完整 cache/TTFT 展示矩阵与 per-model usage 汇总未闭环                                                                                                                                                                                                                                                                  | `crates/miao-engine/docs/product-acceptance-matrix.md`                                                       |
| Windows          | 原生终端工具不开放；ConPTY 无法与容器结合时回退到非受限控制台；三平台的 confinement/升级回滚验收未完成                                                                                                                                                                                                                                                               | 同上、`crates/miao-engine/docs/inventory.md`                                                                 |
| 凭据所有权       | 引擎只读凭据库，TS broker（或独立 credential daemon）是唯一刷新写者；过期时引擎以明确错误失败，不会自己刷新                                                                                                                                                                                                                                                          | `crates/miao-engine/docs/facade-mapping.md`（ADR-09）                                                        |
| 客户端覆盖       | TUI 已实测（审批、取消、流式渲染、重放）；app（web/desktop）的 transcript retype 仍在进行；第三方 ACP 编辑器 UI、慢客户端积压边界、真实客户端重连未验收                                                                                                                                                                                                              | 路线图 §1.2、`crates/miao-engine/docs/product-acceptance-matrix.md`                                          |
| 实账号验收       | Gemini/Anthropic 实账号的日常会话验收受阻于凭据，尚未关闭                                                                                                                                                                                                                                                                                                            | 路线图 §6、§9.4                                                                                              |
| 存储与降级       | 原生会话落在引擎自己的存储；跨版本数据降级兼容性未验收，回滚按“重装上一版本”处理                                                                                                                                                                                                                                                                                     | `switch-plan.md`（G4）、路线图“回滚”一节                                                                     |

## 4. 效率证据现状

| 维度         | 现有证据                                                                                                                                            | 能否宣称“不低于 TS”                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 任务质量     | 真模型小任务两轮 sweep：6 类 × 8 次 → RS 48/48、TS 47/48；3 类 × 3 次 → 双方 9/9                                                                    | **不能**。样本小、任务短、只有目标可程序化判定的修复类任务；R4.1（代表性任务质量不低于基线）仍是 acceptance pending |
| 延迟         | 同一轮 sweep：RS p50 22 s / p95 27 s，TS p50 26 s / p95 29 s；引擎自身 warm ready p50 8.3 ms、冷启动 642 ms、ready RSS 10 MiB                       | 仅在上述小任务上略低；引擎自身数字不等于端到端                                                                      |
| token / 成本 | 见 §5：15 类任务 × 3 次 × 双引擎的实测，逐类别的计费输入/缓存/输出与费用；此前的测量文档本身未记录 cost/context，switch-plan 的 G5 也仍卡在预算决策 | 部分：§5 给出方向与盈亏平衡点，但只有单一模型与 n=3，尚不足以作为 R4.2 的验收证据                                   |

两类结构性风险会直接影响 token 与效果，方向无法先验假设：

- **提示与工具 schema 字节不同**。facade 只映射工具名，输入 schema 与描述是引擎自己的，因此系统提示与工具目录的字节和 TS 不同；文档记录的一次措辞改写带来 **+35–44% 计费 input**（#829，已回退）。这既影响计费，也会改变模型行为，说明“措辞等价”不能默认为真。
- **压缩/裁剪默认不同**。TS 默认开启自动压缩，RS 需要显式 `engine.context_limits`，否则长会话可能既更贵（上下文膨胀）也更早失败。
- 引擎内部的正面消融（A2 多行编辑载体 −21% turns / −22% input tokens；A7 类型载体 −4% turns / −5% input tokens）只在各自 carrier 上成立，未在代表性任务集上验证，也不能直接外推成全任务更省。

**结论**：功能上可以把主链路做到不缺；质量在现有的小样本上不低于，且已按任务类别补了一轮计费 token/成本对比（见 §5）。但这不是产品级评测：样本小、单一模型、只有目标可程序化判定的任务，`stream-interruption` 一类在当前路由下测不了。要更强结论仍需路线图 §7 的维度（主/子/辅助模型 + 重试 + 摘要 + 失败尝试）与更多任务类别。

## 5. 实测对比（2026-10-19）

在冻结任务集（suite v6：15 类）上各跑 **3 次 × 双引擎 = 90 次真实模型运行**，顺序执行以免 provider 竞争，两侧同一模型 `deepseek-v4-flash`（TS：`--model deepseek/deepseek-v4-flash`；RS：`--provider openai-chat --endpoint https://api.deepseek.com/chat/completions`）。跑法即 `packages/miao/src/engine/baseline-sweep-cli.ts`，结果文件是每次运行的 evidence/sample。

计费口径：`inputTokens` 是含缓存命中的总量，计费输入 = `inputTokens − cacheReadTokens`；单价取 catalog 列表价（输入 $0.15/M、输出 $0.60/M、缓存读 $0.003/M、缓存写 $0），金额用产品自己的 `SessionRunnerCost.ofTurn` 计算，与手算逐项一致。

| 引擎 | 通过        | turns        | 计费输入 | 缓存输入  | 命中率 | 输出    | 总费用      | p50    | p95    |
| ---- | ----------- | ------------ | -------- | --------- | ------ | ------- | ----------- | ------ | ------ |
| TS   | 39/45 86.7% | 246 (5.5/r)  | 621,657  | 3,157,376 | 83.5%  | 25,979  | **$0.1183** | 8.0 s  | 37.2 s |
| RS   | 42/45 93.3% | 500 (11.1/r) | 140,807  | 3,421,693 | 96.0%  | 121,389 | **$0.1042** | 10.0 s | 50.7 s |

**谁更省**：RS 总费用低 **11.9%**，成功率也更高。钱花在完全相反的方向：

| 计费项             | TS      | RS      | 差额         |
| ------------------ | ------- | ------- | ------------ |
| 计费输入 × $0.15/M | $0.0932 | $0.0211 | **−$0.0721** |
| 缓存读 × $0.003/M  | $0.0095 | $0.0103 | +$0.0008     |
| 输出 × $0.60/M     | $0.0156 | $0.0728 | +$0.0572     |

RS 输入侧省 4.4 倍（每 turn 首发 ~4.9k vs TS ~14k，命中率 96% vs 83.5%），输出侧贵 4.7 倍（每 turn 输出 243 tokens vs 106，turn 数又是 2 倍）。因为输出/输入单价是 4:1，而省下的输入量与多花的输出量之比约 5:1，输入侧仍然赢。**盈亏平衡点：输出价 ≥ 输入价的 5.04 倍时结论翻转**（缓存读 = 输入价/50 的前提下解得）。

按任务类别（$ = RS/TS）：

| 类别            | ratio | 类别              | ratio | 类别                | ratio    |
| --------------- | ----- | ----------------- | ----- | ------------------- | -------- |
| multi-read      | 0.11  | test-repair       | 0.50  | rename-symbol       | 0.57     |
| tool-error      | 0.12  | create-module     | 0.55  | multi-file          | 0.57     |
| read-only       | 0.21  | docs-sync         | 0.56  | typed-repair        | 0.58     |
| multi-line-edit | 0.36  | large-file        | 0.39  | long-session        | **4.28** |
| small-edit      | 0.44  | permission-denial | 0.43  | stream-interruption | 0.07     |

14 个类别里 RS 是 TS 的 0.07–0.58 倍；唯一的例外是 `long-session`：RS 在该类跑 82 turns/run（TS 17），成本是 TS 的 **4.28 倍**，延迟 53.8 s vs 39.4 s。**去掉这一类：TS $0.1039 vs RS $0.0423 —— RS 便宜 59%**。整体 11.9% 这个数字是被这一类拖下来的。

同时观察到的两类行为差异：

- `permission-denial`：TS 0/3（运行继续、只留下 `tool.error`，缺少任务判据要求的 `permission.denied`），RS 3/3（两种凭据都有）。
- `stream-interruption`：双方 0/3，但原因与协议相关而非引擎能力：断流代理是为 Responses/SSE 设计的，在 `openai-chat` 路由下 TS 被 SIGINT 掉后没有 `provider.interrupted`，RS 直接收到 provider HTTP 418。该类在当前路由下不可比。

证据边界：单一模型（deepseek-v4-flash，输出/输入 = 4）、n=3/类、只有目标可程序化判定的短任务、单机顺序执行；绝对金额很小（两侧合计 ~$0.22），百分比差异对价格表与任务组合敏感。这组数字成立的前提是两个 harness 缺陷已修复（TS 腿因 `undefined` 观测崩在 receipt 指纹；多输入任务只保留最后一个输入的 provider 交互），两者均已合入。

## 6. 现在开启的最小建议

1. 设 `engine.context_limits`，对齐 TS 的自动压缩行为（否则长会话没有自动压缩）。
2. 决定 `engine.prompt_cache` 与 Responses cache/WebSocket 契约，只声明已验证的部署能力。
3. 保持 `engine.tool_disclosure: full`；`compact` 是 opt-in，且文档明确不保证总成本更低。
4. 确认凭据仍由产品 broker 刷新；引擎只读取。
5. 接受产品级工具暂缺，或先把产品工具反向桥的宿主侧接通。
6. 用 `miao-engine --capabilities` 与 `miao-engine doctor` 固定所用二进制版本；原生会话的存储独立于 TS 存储，回滚按“重装上一版本”处理。
