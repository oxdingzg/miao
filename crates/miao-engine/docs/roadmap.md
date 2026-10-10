# Rust engine 统一 Roadmap

状态快照：**2026-10-10**；核对基线：`f98fd8a09`（含 #589）。

## 1. 目标与文档职责

**在真实任务完成质量提高的同时，减少 token 消耗、端到端耗时和人工纠正。**

Rust 是实现载体。成功由正确完成任务的效率衡量：更准确地获取信息、更可靠地编辑、更少无效轮次、更有效地管理上下文，并用可执行验证完成任务闭环。

参考吸收开源 agent 与成熟 coding agent 的机制，结合 miao 的任务与模型独立验证。既有 TS 实现是行为参考和评测基线；能力对等用于迁移验收，不能代替任务质量与效率验收。保留必要能力，允许重新设计内部实现、工具交互和客户端体验；明确接受的替代需记录依据。

本文是 Rust engine 的**目标、当前进度、剩余工作、执行优先级与阶段门禁的统一入口**。详细协议、架构契约和测试证据留在专门文档中：

| 文档 | 职责 |
|---|---|
| [inventory.md](inventory.md) | 能力族与实现/测试证据；不是效率收益证明 |
| [scenarios.md](scenarios.md)、[accuracy.md](accuracy.md) | 确定性场景、结果契约、故障与差分验证 |
| [measurements.md](measurements.md)、[live-eval.md](live-eval.md) | 带条件的资源测量与真实任务结果 |
| [handler-migration.md](handler-migration.md)、[client-contract.md](client-contract.md) | 产品接口接入范围 |
| [event-bridge.md](event-bridge.md)、[facade-mapping.md](facade-mapping.md) | 事件和工具映射设计；实际覆盖以代码为准 |
| [rollback-verification.md](rollback-verification.md) | 本地 preview 的实际回退证据 |
| [session-blackbox.md](../../../docs/session-blackbox.md) | 录制、回放与跨引擎比较的能力和边界 |
| [ADR 索引](README.md) | ownership、durability、authority、provider、扩展与迁移决策 |

本文更新进度，不自动改写 ADR 的架构决策。架构变更需同时更新对应 ADR。早期 README、可行性研究和 ADR 的背景段落可能保留旧快照；当前工作状态以本文和可追溯代码证据为准。

## 2. 完成状态的含义

- **已完成（契约范围）**：代码已合入，有对应可执行验证；不推断真实任务收益。
- **部分完成**：已有基础，但列出的功能或验收缺口仍存在。
- **待做**：目标已明确，未发现完整实现与验收证据。
- **候选实验**：待通过独立 A/B 决定是否采纳，不是默认实现承诺。

每个优化必须分别记录：实现 commit/PR、行为验证、真实任务收益、发布状态。CI 成功不等于质量提升，Actions artifact 不等于正式 Release，headless 验证不等于产品体验验收。

## 3. 已完成的引擎基础

以下是当前可复用的基础，不应反复从零建设。能力范围见 inventory 和对应测试。

| 基础 | 状态与证据 | 对目标的意义及边界 |
|---|---|---|
| durable admission、exact retry、steer/queue、执行监督 | 已完成；`src/store.rs`、`src/runtime.rs`，retry/supervision/lost-wake 场景 | 降低重复执行和不可解释挂起；崩溃后不自动重做未知副作用 |
| read/list/glob/grep、条件 write/edit、事务 patch | 已完成；`src/tools.rs`、`src/file_mutation.rs`、`src/patch.rs`，accuracy/differential | 提供正确编辑基础；不等于锚定编辑或自动 stale 恢复已完成 |
| bash/PTY、后台 job、三平台 sandbox | 已完成对应范围；process/bash/jobs 与 Windows 场景 | 外部执行、取消和输出有界；完整交互 terminal 产品 API 仍需接入 |
| subagent、全局限额与独立取消 | 已完成基础；`src/subagent.rs`、`tests/subagent.rs` | 可隔离任务上下文；不能据此宣称委派减少总 token |
| LSP diagnostics/definition/references、图片输入 | 已完成核心；lsp/media 场景 | 精确信息获取基础；read 预热、编辑后诊断闭环和其他媒体仍需评估 |
| Context Epoch、skills/references、state/todo/goal | 已完成对应范围；context/state 场景 | 稳定上下文与按需读取基础；不等于已实现完整缓存优化 |
| 显式 compaction、recall、fork、revert/unrevert | 已完成；`src/history.rs`、checkpoint/rewind/recovery 场景 | caller 提供摘要；自动摘要策略与质量评测尚未完成 |
| 多 provider、只读凭据、安全 fallback 与共享 retry 预算 | 已完成基础；provider/routing/credential 场景 | 降低失败成本；purpose-role 路由与收益尚需验证 |
| MCP、hooks、扩展 worker 协议宿主 | 已完成基础；mcp/hooks/worker 场景 | 可扩展工具入口；现有 TS 插件和工作流实际兼容仍需接线 |
| cursor/replay、snapshot/export、stdio/HTTP/ACP | 已完成核心协议范围；http/acp/two-engines 场景 | 慢客户端隔离与重连基础；ACP 部分方法仍仅返回空结果 |
| usage 汇总、doctor、产物 manifest、本地安装 | 已完成对应范围；run-usage/install 场景与 engine workflow | 可测量与可交付基础；成本口径、正式更新通道尚未完整闭合 |

### 已有测量，不应夸大的结论

- 小任务 live-eval 已有两轮：6 类任务 × 8 次，Rust 48/48、TS 47/48；另 3 类任务 × 3 次，均 9/9，Rust p50 22 s、TS p50 26 s。仅支持该模型和小任务范围内的观察。
- 单平台 release binary 18.4 MiB；warm readiness p50 8.3 ms、首次 642 ms；ready 时 engine RSS 10 MiB。不能外推长会话、完整进程树或其他平台。
- preview 回退已实际演练；正式产品发布通道仍需验收。
- #589 的 blackbox 支持 TS 语义边界严格回放、Rust provider 回放；Rust 原生工具结果替代和公共产品历史归一化仍缺。
- **尚无充分证据证明代表性任务集上“更高质量 + 更少 token + 更短耗时”已同时达成。**

## 4. 主线 A：任务质量与效率优化

排序原则：先建立可重复的结果测量，再优先减少错误与废轮、冗余上下文和串行等待。候选机制按实测收益选择。

| ID | 工作项 | 当前状态 | 下一交付与验收 |
|---|---|---|---|
| A1 | 真实任务评测与效率基线 | 部分完成：小任务 live-eval、usage、blackbox、资源快照已有 | 建立固定任务集、完整 attempt 成本和阶段耗时报告；先补基线再定数值预算 |
| A2 | 编辑首试成功率与低 token 编辑 | 部分完成：条件写、精确 edit、patch 与差分已有；锚定/stale 恢复待做 | 评估快照换基恢复、短锚编辑；测首次成功、返工轮次、输出 token、错位和误修改，模型可见语法独立 A/B |
| A3 | 精准检索与最小必要读取 | 部分完成：有界 grep/glob/read 与 LSP core 已有 | 符号级定位、范围读取、去重与相关性评估；repo map 为候选，计入构建/更新成本；测定位准确率、读取 token 与搜索轮次 |
| A4 | 上下文选择、可恢复输出归档与自动压缩 | 部分完成：Epoch、显式 compact、recall 与输出上限已有 | 旧工具结果按需归档/回读、预算感知选择、自动摘要；保留目标、未完成项、验证结果与 opaque state；测长任务质量及压缩/回读总成本 |
| A5 | 缓存稳定性与 provider cache 策略 | 部分完成：稳定 Epoch 基础已有；显式策略待做 | 稳定 tools/system 序列化、动态上下文布局、cache lineage；按 provider 测 billed input/cache read/write、TTFT；预填/增量传输是候选 |
| A6 | 有界并行与冲突感知调度 | 部分完成：工具 RwLock、跨 Session 并发与限额已有；同轮工具仍逐个等待 | 先让独立读取有界并行，再评估路径级资源声明；审批/执行/取消/结算保持可解释，未知外部工具保守处理；测实际重叠、关键路径与冲突 |
| A7 | 更短的执行→诊断→修复→验证闭环 | 部分完成：LSP、bash、job、goal/hook 基础已有 | 评估 read 后 LSP 预热、编辑后诊断、任务级验证条件与完成检查；诊断延迟/噪声计入成本；禁止以修改检查文件制造成功 |
| A8 | 防无效循环与失败预算 | 部分完成：重复调用止损、安全 fallback、共享 retry 预算已有 | 分类空完成/无进展/可重试失败，按新信息决定继续或收尾；测废轮与正常任务误终止率，不放宽已有硬预算 |
| A9 | purpose-role 模型选择 | 部分完成：主/备用模型 routing 已有，完整角色路由待做 | 先评估摘要/检索/验证等辅助任务的小快模型；能力兼容与升级路径明确；汇总所有模型/失败 attempt 成本，验证质量不降 |
| A10 | 有净收益的委派与批量工作流 | 部分完成：subagent 与 worker 基础已有 | 最小任务包、结构化结果、引用回读、独立验证和批量工具边界；测父+子总 token、墙钟时间、合并返工；按任务选择委派 |

**实现某机制不代表该项效率验收完成。** 工具 RwLock 不等于同轮并行；显式 compaction 不等于自动上下文管理；模型 fallback 不等于角色路由；具备 worker transport 不等于现有插件已可用。

## 5. 主线 B：可用产品与交付

此主线让优化在真实产品里可用，并保住可靠性。可与主线 A 并行推进最小接入，但不以机械补齐旧接口取代 A 的任务收益工作。

| ID | 工作项 | 当前状态 | 完成条件 |
|---|---|---|---|
| B1 | 产品执行 facade 与生命周期 | 部分完成：`packages/miao/src/engine/{client,session,event,bridge}.ts` 与 `ClientEvents` 已有；产品 session handler 仍走 TS core | Location/engine ownership、启动/关闭、配置映射接通；session/message/permission/question/fs/lsp 及 runtime/mcp 执行部分走实际 engine |
| B2 | 产品事件、历史与实时交互 | 部分完成：prompt/完整文本/tool/approval 等已桥接；progress 未接完整产品链路 | text/reasoning/tool-input 增量、usage/error/retry、question 答复、状态/压缩/回滚、snapshot/history/replay 一致；exact input ID、queue 与附件贯通 |
| B3 | 扩展、凭据与协议补完 | 部分完成：worker/MCP/只读凭据/ACP 基础已有 | 实际插件/工作流兼容；产品拥有唯一 refresh writer；ACP authenticate/resume/close 的实际语义及 config/usage 补齐；新增 provider/MCP/LSP 按任务需求排优先级 |
| B4 | 产品级验收与跨引擎比较 | 部分完成：双 Rust sidecar 测试与 blackbox 已有 | 实际客户端 attach 两引擎；审批/取消/重连/长会话通过；补工具结果替代与公共历史归一化，明确有意行为差异 |
| B5 | 安装、正式更新与回退 | 部分完成：Actions artifacts/checksum manifest、本地 installer/preview 回退已有 | 正式 engine 分发、版本/通道/升级、发布通道回退；平台 confinement 与产品支持范围逐项验证 |
| B6 | 默认切换与旧 core 退役 | 待做 | 全部切换门禁通过；既有 Session 显式迁移或保留可读路径；单 Session 单权威，无双写，最终消除第二套执行 core |

独立 credential broker、更多 provider、完整媒体/LSP/MCP surface、终端复用 API、host 服务迁移和全 Rust shell 依据实际任务与维护收益决策。全 Rust 单二进制是既有迁移设计的终态方向；是否和何时迁 shell，应更新 ADR 并用体验/启动/维护数据裁决。

## 6. 阶段门禁与当前执行顺序

### R0 — 可比较、可解释的任务基线（部分完成；下一优先）

完成 A1：固定任务、初始 workspace/commit、模型/配置、oracle、重复运行和报告口径。任务涵盖小修复、多文件改动、陌生仓库定位、测试驱动修复、长会话、工具失败与中断恢复。结果包含失败任务，不能只挑成功运行。

### R1 — 更少错误与废轮（部分完成）

优先 A2/A3/A7/A8：编辑、定位、验证和止损。逐机制开启/关闭做消融，证明收益来自何处；新编辑语法和提醒文案需独立实验。验收包括正确率、误修改、返工、无效轮次与人工纠正。

### R2 — 更少上下文与更短关键路径（部分完成）

推进 A4/A5/A6，再按数据选择 A9/A10。自动摘要、缓存、并行、委派的额外成本全部计入；长任务完成质量不能因压缩或小模型退化。

### R3 — 产品可用且结果可重现（部分完成）

完成 B1–B4：先打通一条实际客户端任务路径，再扩大能力覆盖。使用产品事件/历史验收和 replay 定位回归；固定录制验证行为，live eval 验证真实质量，两者相互补充。

### R4 — 发布并默认切换（待验收）

完成 B5/B6；须同时满足：

1. 代表性任务的质量至少不低于固定基线，有可解释的质量/效率提升证据。
2. token/成本与端到端耗时报告完整；差异按任务类型给出，不能宣称所有任务都更省更快。
3. 用户所需能力已验收，替代体验明确接受；取消/恢复/审批/慢客户端不退化。
4. Session 与 credential ownership 单一；实际产品安装/升级/回退通过。
5. 支持平台的实际执行与 confinement 已验证；公开版本/产物/验收 commit 可追溯。

旧 M0–M4 标签继续用于基础建设历史：M0/M1 核心门槛已达成，M2 引擎侧已达成但客户端仍缺，M3 基础覆盖已有而角色/扩展产品收益未完整验证，M4 交付部分完成。**这些标签不能替代 R0–R4 的任务效率门禁。**

当前优先队列：**A1 → A2/A3/A7/A8 → A4/A5/A6 → 数据驱动选择 A9/A10**。B1/B2 的最小可用路径并行推进，B3–B6 按实际依赖收尾；不预设各优化收益和完成日期。

## 7. 统一测量与采纳规则

| 维度 | 必须报告 |
|---|---|
| 质量 | oracle 成功率、首次编辑成功、无关内容保留、返工、人工纠正；无法自动判定的任务标明人工标准 |
| token/成本 | 所有主/子代理及辅助模型的 input/output/reasoning/cache read/write、重试、摘要和失败成本；缺失 usage 标 unknown，不用字符估算冒充账单 |
| 时间 | admission→首语义输出、完成验证的总耗时、provider/tool/approval/排队/摘要各阶段；重复运行给 p50/p95 与样本数 |
| 资源 | engine 与完整进程树 RSS、冷/热启动、FD、长会话曲线；平台/并发/配置一致 |
| 可靠性 | unknown 副作用不重跑、exact retry、取消结算、replay handoff、慢客户端与跨 engine 隔离 |

TS 是迁移基线；机制收益首先与同模型、同任务、同环境下的 Rust 对照组比较。模型路由实验单独报告模型/价格变化，避免把更强模型的效果归因于 runtime。计费 token、实际上下文体积、费用与缓存命中分开报告。

任务集、初始文件与验证器固定，运行采用隔离 workspace 和新 DB；禁止改变验证器或省略必要验证来缩短耗时。长任务包括中途 steer、压缩后恢复和目标完成检查。重复次数、方差与失败分布公开，样本不足不设硬收益承诺。

每个采纳项记录：**问题 → 参考机制 → 本地实现证据 → A/B/消融结果 → 是否默认启用**。无净收益的机制保留为候选或撤销；具体外部取证与本机环境信息保留在私有研究资料，公开文档只记录可验证机制和必要的代码许可/来源声明。

## 8. 维护规则

- 每个相关 PR 更新本文对应 A/B ID 的状态、实现链接与剩余验收；新增机制先写目标和 oracle。
- 只有功能契约通过才能标基础完成，只有 live task 证据足够才能标收益验证完成；发布独立记录。
- 进度变化同步 inventory 和文档入口，避免 README 继续把已实现能力列为未完成。
- 保留单一 durable authority、受监督任务、审批绑定、明确 unknown recovery 和安全 fallback 等 ADR 不变量。
- 本文的状态快照随证据更新；历史测试和测量保留日期、条件和 commit，不覆盖为当前结论。
