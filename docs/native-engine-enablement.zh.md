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
- **产品 agent 从创建即生效**：新原生会话会把产品解析后的 agent manifest（instructions、ordered permissions、steps/model）写入引擎，模型/权限/工具面与 TS 会话按同一 agent 运行。
- **工具面**：引擎自带目录（`read_file`/`read_image`/`list_files`/`glob`/`grep`/`write_file`/`edit_file`/`apply_patch`/`bash`、`start_job`/`job_status`/`cancel_job`、`task`、`todowrite`、`goal`、`question`、`recall`、`session_state`、`schedule_wakeup`/cron、`lsp_*`、`monitor`、webfetch/websearch、knowledge、skill、session 终端），工具名到产品渲染 id 的映射见 `crates/miao-engine/docs/facade-mapping.md`。
- **扩展面**：MCP（stdio/HTTP、resources/prompts、OAuth、`list_changed` 刷新、`tool_search` 发现）、生命周期 hooks、ADR-12 worker（`.miao/tool`、`.opencode/tool`、`MIAO_CONFIG_DIR` 下的自定义工具文件）、会话级终端（Unix）、LSP（由产品配置自动生成 manifest）。
- **模型与路由**：host manifest 生成的路由（Anthropic、OpenAI Chat/Responses、订阅 Responses、Gemini、Bedrock SigV4 或 bearer、Copilot 风格、Azure/Vertex 等声明式路由）、会话级模型绑定与变体、purpose role、prompt cache 与 Responses cache/WebSocket 契约。
- **上下文**：ambient context（instructions/skills/references 映射为 host manifest）、自动压缩与工具输出裁剪（产品生成路由时自动派生 `context_limits`；显式路由需单独配置，见 §3）、recall、context epoch。
- **观测**：per-run usage 聚合、per-turn 计费 cache 谱系（read/write/nonCached/hitRatio）与 TTFT（写入 `engine_timing` 侧表，不进可重放 payload）。
- **协议面**：stdio、loopback HTTP（含 SSE）、ACP stdio adapter。

引擎侧另有做过消融测量的机制（同轮声明式读并行 A6、行窗口读取与锚定编辑/漂移控制 A2/A3、`--verify-command` 完成检查、按 handle 可恢复的输出裁剪、编辑后诊断与读预热 A7）。这些是引擎实现；TS 侧存在部分对应物（read 的 offset/limit、edit 快照、编辑后 LSP 诊断、`packages/core/src/session/prune.ts`），不要把它们当作纯 RS 增量。

## 3. 相对 TypeScript 的缺口

| 缺口             | 现状                                                                                                                                                                                                                                                                                                                                                                 | 证据                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 产品级工具       | 引擎侧反向桥与 TS 宿主清单/应答均已接通（`crates/miao-engine/src/product.rs`、`tools.rs`、`packages/miao/src/engine/product-tools.ts`、`#1153`）；原生会话可以拿到 `send_message`、`list_sessions`、`read_session_context`、`push_notification`。插件提供的工具通过 `plugin_tools` / `plugin_tool` 暴露，`tool.execute.before/after` 在插件工具调用上生效；原生内置工具的插件 hooks 由 #1180 反向派发（before/after）。worktree 由 #1178、delegation `workflow` 由 #1192/#1193（call 上下文 + `product_tool.cancel`）、delegation `report` 由 #1194 相继进入产品工具桥 | `#1153`、`packages/miao/src/engine/plugin-tools.ts`、`packages/miao/test/engine/plugin-tools.test.ts` |
| 插件面收窄       | 插件 `tool.execute.before/after` 已由 #1180 反向派发到宿主（marker + `hook_tool`，登记序、fail-closed、日志 `hook_tool.completed`；`definition` 族延后）；仍缺：`tool.definition` 钩子、插件自带非标准 AI SDK provider 的路由映射 | `crates/miao-engine/tests/plugin_hooks.rs`、`packages/miao/src/engine/plugin-hooks.ts`、`crates/miao-engine/docs/product-acceptance-matrix.md`（G6） |
| 自动压缩默认不同 | 产品生成路由与显式 provider/endpoint/credential 路由都会从 `compaction` 配置派生 `context_limits`（默认 `auto: true`、阈值 0.9，#1195），原生会话因此默认自动压缩；显式 `engine.context_limits` 仍然优先。目录解析不到模型（worker 上下文、插件未启动）时引擎默认保持关闭 | `packages/miao/src/engine/product-routes.ts`、`packages/core/src/session/compaction.ts`、`packages/schema/src/config.ts`、`crates/miao-engine/src/main.rs` |
| 计费与展示       | 原生会话的 pricing 仍按 0 处理到价格解析落地；完整 cache/TTFT 展示矩阵与 per-model usage 汇总未闭环                                                                                                                                                                                                                                                                  | `crates/miao-engine/docs/product-acceptance-matrix.md`                                                       |
| Windows          | 终端工具已广告且有 CI 覆盖（Pseudoconsole 启动/输入/resize/退出/会话隔离、嵌套 cwd 与写限制）；AppContainer 无法与 ConPTY 结合时回退到非受限控制台，并在 `sandbox_profile` 报 `windows_unconfined`；升级/回滚验收未完成                                                                                                                                              | `crates/miao-engine/tests/terminal.rs`（`#[cfg(windows)]`）、`crates/miao-engine/src/terminal.rs`            |
| 凭据所有权       | 引擎只读凭据库，TS broker（或独立 credential daemon）是唯一刷新写者；过期时引擎以明确错误失败，不会自己刷新                                                                                                                                                                                                                                                          | `crates/miao-engine/docs/facade-mapping.md`（ADR-09）                                                        |
| 客户端覆盖       | TUI 已实测（审批、取消、流式渲染、重放）；app（web/desktop）的 transcript retype 仍在进行；第三方 ACP 编辑器 UI、慢客户端积压边界、真实客户端重连未验收                                                                                                                                                                                                              | 路线图 §1.2、`crates/miao-engine/docs/product-acceptance-matrix.md`                                          |
| 实账号验收       | Gemini/Anthropic 实账号的日常会话验收受阻于凭据，尚未关闭                                                                                                                                                                                                                                                                                                            | 路线图 §6、§9.4                                                                                              |
| 存储与降级       | 原生会话落在引擎自己的存储；跨版本数据降级兼容性未验收，回滚按“重装上一版本”处理                                                                                                                                                                                                                                                                                     | `switch-plan.md`（G4）、路线图“回滚”一节                                                                     |

## 4. 效率证据现状

| 维度         | 现有证据                                                                                                                                            | 能否宣称“不低于 TS”                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 任务质量     | 真模型小任务两轮 sweep：6 类 × 8 次 → RS 48/48、TS 47/48；3 类 × 3 次 → 双方 9/9                                                                    | **不能**。样本小、任务短、只有目标可程序化判定的修复类任务；第 4–5 轮（`2026-10-21-openai-sol-suite-v6`、`2026-10-21-glm53flash-suite-v6`，各 15 类 × 3 次 × 双臂）Rust 45/45 与 42/45、TS 39/45 与 38/45，质量面继续持平偏好；R4.1（代表性任务质量不低于基线）仍是 acceptance pending |
| 延迟         | 同一轮 sweep：RS p50 22 s / p95 27 s，TS p50 26 s / p95 29 s；引擎自身 warm ready p50 8.3 ms、冷启动 642 ms、ready RSS 10 MiB                       | 仅在上述小任务上略低；引擎自身数字不等于端到端                                                                      |
| token / 成本 | 见 §5：15 类任务 × 3 次 × 双引擎的实测，逐类别的计费输入/缓存/输出与费用；此前的测量文档本身未记录 cost/context，switch-plan 的 G5 也仍卡在预算决策 | 部分：§5 与五轮 sweep（deepseek ×2、go 网关、gpt-6.1-sol、glm-5.3-flash，各 90 次）方向一致——原生计费成本 0.45×–0.60×；跨 4 个模型、n=45/臂，但任务域仍窄，R4.2 正式验收仍 pending                                   |

两类结构性风险会直接影响 token 与效果，方向无法先验假设：

- **提示与工具 schema 字节不同**。facade 只映射工具名，输入 schema 与描述是引擎自己的，因此系统提示与工具目录的字节和 TS 不同；文档记录的一次措辞改写带来 **+35–44% 计费 input**（#829，已回退）。这既影响计费，也会改变模型行为，说明“措辞等价”不能默认为真。
- **压缩/裁剪默认**。产品生成路由与显式路由都会自动派生 `context_limits`（#1195）；显式 `engine.context_limits` 仍然优先。
- 引擎内部的正面消融（A2 多行编辑载体 −21% turns / −22% input tokens；A7 类型载体 −4% turns / −5% input tokens）只在各自 carrier 上成立，未在代表性任务集上验证，也不能直接外推成全任务更省。

**结论**：功能上可以把主链路做到不缺；质量在现有的小样本上不低于，且已按任务类别补了一轮计费 token/成本对比（见 §5）。但这不是产品级评测：样本小、单一模型、只有目标可程序化判定的任务，`stream-interruption` 一类在当前路由下测不了。要更强结论仍需路线图 §7 的维度（主/子/辅助模型 + 重试 + 摘要 + 失败尝试）与更多任务类别。

## 5. 实测对比（2026-10-20 更正后）

原始数据、manifest、复现命令与对比脚本在 [experiments/2026-10-19-native-engine-suite-v6](experiments/2026-10-19-native-engine-suite-v6/README.zh.md)：冻结任务集 suite v6（15 类）× 3 次 × 双引擎 = **90 次真实模型运行**，两臂同一 `main` 提交 `83f7c4f9`，顺序执行，同一模型 `deepseek-v4-flash`。

计费口径：`inputTokens` 含缓存命中，计费输入 = `inputTokens − cacheReadTokens`；单价取 catalog 列表价（输入 $0.15/M、输出 $0.60/M、缓存读 $0.003/M、缓存写 $0），金额用产品自己的 `SessionRunnerCost.ofTurn` 计算。

| 引擎 | 通过        | turns        | 计费输入 | 缓存输入  | 命中率 | 输出   | 总费用       | p50   | p95    |
| ---- | ----------- | ------------ | -------- | --------- | ------ | ------ | ------------ | ----- | ------ |
| TS   | 39/45 86.7% | 231 (5.13/r) | 604,321  | 2,859,904 | 82.6%  | 23,375 | $0.11325     | 7.6 s | 37.8 s |
| RS   | 41/45 91.1% | 334 (7.42/r) | 111,035  | 2,163,453 | 95.1%  | 62,040 | **$0.06037** | 9.0 s | 40.2 s |

**谁更省**：RS 总费用低 **46.7%**（比值 0.533），成功率略高，p50/p95 慢 1.4 s / 2.4 s。钱花在相反方向：

| 计费项             | TS      | RS      | 差额     |
| ------------------ | ------- | ------- | -------- |
| 计费输入 × $0.15/M | $0.0906 | $0.0167 | −$0.0739 |
| 缓存读 × $0.003/M  | $0.0086 | $0.0065 | −$0.0021 |
| 输出 × $0.60/M     | $0.0140 | $0.0372 | +$0.0232 |

15 类里 14 类 RS 更省（0.055–0.847）；唯一例外 `long-session` 为 **1.27×**（RS rep0 以 `tool.error` 收尾）。**去掉该类：TS $0.10003、RS $0.04356，RS 便宜 56.5%。盈亏平衡：输出价 ≥ 输入价的 13.1 倍才翻转**（该模型 4.0 倍）。

**第二个模型**：网关 `opencode-go/deepseek-v4.1-flash` 在同一 suite 上给出比值 **0.527**（便宜 47.3%）、去掉 `long-session` 后 **0.459**、盈亏平衡 **16.6×**（[记录](experiments/2026-10-19-opencode-go-suite-v6/README.zh.md)）。两轮方向一致，幅度 46.7%–47.3%。

**更正（2026-10-20）**：早先的采集把多输入任务的重放历史重复累加，`long-session` 的原生费用被高估 3–4 倍，曾给出 21.5%/31.0% 与 6.32×/8.56×。harness 已按 committed seq 去重（#1142），实验目录的 `raw/` 已替换、虚高样本留在 `correction/`。本节的数字是更正后的。

两点行为差异：`permission-denial` TS 0/3（缺 `permission.denied`）对 RS 3/3；`stream-interruption` 两臂均 0/3，属协议原因不可比。

证据边界：单一模型（输出/输入 = 4）、n=3/类、短任务、单机顺序执行，两臂合计约 $0.17；不构成产品级或跨模型结论。

## 6. 现在开启的最小建议

1. 确认自动压缩：产品生成路由时已自动派生 `context_limits`；使用显式路由时手动设置，否则长会话没有自动压缩。
2. 决定 `engine.prompt_cache` 与 Responses cache/WebSocket 契约，只声明已验证的部署能力。
3. 保持 `engine.tool_disclosure: full`；`compact` 是 opt-in，且文档明确不保证总成本更低。
4. 确认凭据仍由产品 broker 刷新；引擎只读取。
5. 验证产品工具桥覆盖当前工作流；worktree（#1178）、delegation `workflow`（#1192/#1193）、delegation `report`（#1194）都已进入桥。插件 `before/after` hooks 已随 #1180 对原生工具生效。
6. 用 `miao-engine --capabilities` 与 `miao-engine doctor` 固定所用二进制版本；原生会话的存储独立于 TS 存储，回滚按“重装上一版本”处理。
