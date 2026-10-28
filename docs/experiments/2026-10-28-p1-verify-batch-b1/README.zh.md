# P1 核验批次 B1（CTX-04 / CTX-06 / CTX-07）

适用版本：HEAD `95d8a5f1b4`（2026-10-28），仓库 `/Users/dingzg/workspace/code/github/miao`。本批次只核对引擎侧（`crates/miao-engine`）实现与测试证据，不做验收勾选操作。

## 汇总表

| 编号 | 主题 | 结论 | 要点 |
| --- | --- | --- | --- |
| CTX-04 | 读取触发的嵌套指令发现 | **需补工作** | 读工具内无 AGENTS/目录指令发现与 durable 准入；现有能力仅限启动期上下文组装 |
| CTX-06 | 文件版本约束与知识失效 | **可勾**（附小缺口） | sources+revision 绑定、stale 可见、旧版本不混用均有代码与测试证据 |
| CTX-07 | 稳定前缀/增量历史/工具发现 | **可勾**（附缺口） | 顺序稳定与前缀亲和有代码+测试；费用量化评估记录未核 |

依据文档 `crates/miao-engine/docs/source-bound-knowledge.md` 与 `crates/miao-engine/docs/revision-bound-observations.md` 均存在（三项共用）。

---

## CTX-04 读取触发的嵌套指令发现 —— 需补工作

### 逐条核对

1. **成功读取文件后识别适用目录指令** —— 未实现。`read_file` 处理器位于 crates/miao-engine/src/tools.rs:1937（分支入口），成功读取后的全部后续动作只有：LSP fire-and-forget warm（crates/miao-engine/src/tools.rs:1978 附近，注释明言"a read must never wait on a language server"）与 edit-rebase snapshot 注册（crates/miao-engine/src/tools.rs:2016-2025，只记录模型实际看到的文本）。整个读路径内没有任何 AGENTS.md/目录指令扫描。
2. **下一个安全 provider 边界 durable 准入** —— 未实现。未发现读取触发的指令准入路径。`context_trigger.rs` 实为压缩/剪枝模块：`maybe_compact`（crates/miao-engine/src/context_trigger.rs:162）、`prune_history`（crates/miao-engine/src/context_trigger.rs:543），与指令发现无关。
3. **记录来源及优先级、同一文件不重复注入、跨项目不泄漏** —— 仅启动期组装具备：来源去重用 `BTreeSet`（crates/miao-engine/src/context.rs:385-386，`validate` 上限 16 个来源，context.rs:377-399）；优先级顺序为 host 全局/祖先指令先于 workspace，workspace 相对来源按配置顺序（context.rs:444-477 注释与实现）。但这些只作用于启动期 `assemble_for_agent`（context.rs:437 起），不覆盖"读取后"场景。

### 现有可复用基础

- 启动期 AGENTS.md 根来源（context.rs:459-460）与来源排序/去重约束（context.rs:385-399、444-477）可直接作为读取触发发现的落点。
- 嵌套发现机制已有一例：`SKILL.md` 嵌套发现（context.rs:19 注释、`discover_skills` context.rs:266、组装调用 context.rs:519），但发生在启动期组装，不是读取触发。

### 测试证据

- crates/miao-engine/tests/tools.rs:6 `read_is_bounded_and_cannot_escape_workspace` —— 仅覆盖读边界，无读后指令发现测试。

### 结论与缺口

**需补工作**。三项验收在引擎侧均无对应实现；建议在设计上复用启动期来源校验/去重/优先级代码与 knowledge 的 sources+sha256 模型，把发现时机挂到 read_file 成功路径并走既有 durable 准入边界。

---

## CTX-06 文件版本约束与知识失效 —— 可勾（附小缺口）

### 逐条核对

1. **观察与文件 revision 绑定，文件变化后过期标记可见** —— 有。
   - Note 结构绑定 sources[{path, sha256}]（crates/miao-engine/src/knowledge.rs:21,31）、revision（knowledge.rs:26）、expires_at_ms（knowledge.rs:35）。
   - 写入前强制读取当前文件并回填 `current_sha256`/stale 信息（crates/miao-engine/src/tools.rs:1553-1567）；读取态分为 current/expired/stale（tools.rs:580 附近）。
   - `get` 默认只在 `state=="current"` 或显式 `include_stale` 时返回 body（crates/miao-engine/src/tools.rs:670-683）→ 过期标记可见且旧内容不静默混用；preference/constraint 默认 7 天过期（tools.rs:715）。
   - load 侧拒绝 revision==0 或 revision 大于 document.revision 的脏数据（knowledge.rs:213-215）；save 用 expected_sha256 乐观并发（knowledge.rs:225-250）。
2. **编辑、诊断和缓存不能混用旧版本** —— 有（证据偏间接处见缺口）。
   - edit_file/write_file 结果核对 `source.sha256 == value.sha256` 并写 `matches_applied_revision`，不匹配则不视为已应用（crates/miao-engine/src/tools.rs:1580-1585）。
   - edit-rebase snapshot 只登记模型实际看到过的完整文本（tools.rs:2016-2025）。
3. **复用知识能回溯来源，长期任务测试覆盖外部改文件** —— 有。
   - repo_fact/file_index 强制要求非空 sources 且 derivation 非空（knowledge.rs:139-150）；sources_valid 校验 ≤8 个来源、64 位 hex sha256、路径安全（knowledge.rs:105-122）。
   - 测试：crates/miao-engine/tests/knowledge.rs:150 `indexed_sources_survive_sessions_and_become_stale_until_explicitly_refreshed`（外部改文件 → stale 直到显式刷新，即"长期任务+外部改文件"场景）；:192 `preferences_require_explicit_review_and_external_edits_are_not_silently_overwritten`；:223 `readonly_and_source_denials_are_preserved_by_knowledge_operations`；:55 读取批次内可用。

### 结论与缺口

**可勾**。缺口（不阻塞勾选，建议补强）：第 2 条中"诊断（LSP）"侧的版本一致性只有 fire-and-forget warm 与间接断言，没有像编辑那样的显式 revision 门测试；`tests/knowledge.rs` 未覆盖"跨项目不泄漏"矩阵（该语义主要属 CTX-04 条目）。

---

## CTX-07 稳定前缀/增量历史/工具发现 —— 可勾（附缺口）

### 逐条核对

1. **MCP 目录与系统上下文顺序稳定** —— 有代码证据，测试缺口见下。
   - MCP 工具表为 `RwLock<BTreeMap<String, Tool>>`（crates/miao-engine/src/mcp.rs:147、168、391）→ 按工具名确定性排序。
   - 内建工具定义是固定字面顺序，条件扩展按固定段追加（crates/miao-engine/src/tools.rs:1712 起 `definitions()`）；系统上下文的工具清单按 `definitions()` 顺序拼入（crates/miao-engine/src/context.rs:449-457）。
   - 列表输出另按名排序（tools.rs:2056）。
2. **动态信息不无故破坏可缓存前缀** —— 有。
   - 路由共享要求"exact completed wire prefix"（crates/miao-engine/src/cache_affinity.rs:1）；`select` 将 route_hash、parameters_hash（含 permission_hash，cache_affinity.rs:76-78）与完整前缀 history_hash 全部匹配才给出父路由提示（cache_affinity.rs:55-110）。
   - 测试：crates/miao-engine/tests/cache_affinity.rs:111（重试/工具/运行时重启后亲和保持）、:175（并发会话隔离不泄漏）、:244（fork 血统重启后保留提示且不并入无关会话）。
3. **按模型协议评估增量传输或 prefill，计入缓存写入及连接维护成本** —— 机制在，量化评估记录未核。
   - Responses 协议投影保留 history 与 implicit tail（crates/miao-engine/src/responses_cache.rs:96 `project`，测试 tests/responses_cache.rs:183）；跨协议/跨认证合同在网络前拒绝（tests/responses_cache.rs:106）；真实 wire 合同测试（tests/responses_cache.rs:41）。
   - 连接维护：首事件 deadline/timeout 机制（crates/miao-engine/src/first_event.rs:40-93），测试 tests/first_event.rs:166（native 进程约束头静默与 ping）、:309（关闭 deadline 时保留外部中断）。
   - 缺口：body 要求的"计入缓存写入及连接维护成本"的费用/耗时量化评估（如 docs/experiments/engine-cost-benchmark.md 的对应记录）本批次未读取核对，不能算已验收。

### 结论与缺口

**可勾附缺口**：第 1、2 条证据充分；第 3 条机制存在但成本量化证据缺失。另建议补一条"工具定义顺序稳定性"专项测试（现靠 BTreeMap/固定字面顺序的结构保证，无行为断言）。

---

## 文末清单

### 可立即勾选

- CTX-06 全部三条：观察与 revision 绑定 + 过期可见（knowledge.rs:21-35、tools.rs:580/670-683/715）、旧版本不混用（tools.rs:1553-1567、1580-1585、2016-2025）、来源回溯 + 外部改文件测试（knowledge.rs:105-150、tests/knowledge.rs:150/192/223）。
- CTX-07 第 1、2 条：MCP/系统上下文顺序稳定（mcp.rs:147、tools.rs:1712、context.rs:449-457）；可缓存前缀保护（cache_affinity.rs:55-110，tests/cache_affinity.rs:111/175/244）。

### 需补工作

- **CTX-04（整项）**：read_file 成功路径的目录指令发现（目前 tools.rs:1937-2025 无任何此类逻辑）；发现结果的 durable 准入边界；读取场景下的来源/优先级记录、去重与跨项目隔离。可复用 context.rs 启动期来源模型与 knowledge 的 sources+sha256 模型。
- **CTX-07 第 3 条**：缓存写入与连接维护成本的量化评估记录（离线/真实客户端数据），以及工具定义顺序稳定性专项测试。
