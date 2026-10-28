# CFG-03：服务增量热重载设计

状态：设计（2026-10-28）。本文件只确定实现设计与验收映射，不构成完成声明；
代码、产品验收、收益验收与发布分别记录。前置：CFG-01（配置所有权）已把解析放进引擎。

## 1. 目的

今天改一份 `miao.json` 必须让宿主重新 spawn 引擎：运行中的 turn 被打断，MCP/LSP 连接
全部重建，队列里的输入和后台任务一起消失。CFG-03 要求配置按**服务**增量重配：只有真正
变化的哪一节重建，其余对象（用户输入、运行中任务、已有连接）保持原样；活动 turn 在安全
边界接纳变化，不半途换规则。

## 2. 现状（事实，2026-10-28）

- 配置在 `serve` 启动时一次性派生（`crates/miao-engine/src/main.rs:445-470`）：`--policy`
  文件、`--config-sources`（宿主给的源计划）、或 `--config-dir` 三选一，得到
  `permission::Config`，再编译为 `Policy`。
- `Tools`、`Provider` 也在启动时构造：`--mcp-config`、`--lsp-config`、`--formatter-config`、
  `--hooks-config`、`--skills-config`、`--references-config`、`--product-tools`、
  `--worker-config`、`--model-routes-config` 各自只读一次（`main.rs:485-751`）。
- `Runtime::Inner` 以不可变字段持有 `policy: Policy`、`tools: Tools`、
  `provider: Arc<dyn Provider>`（`runtime.rs:41-75`）。没有任何写入口。
- 引擎里没有文件监听，也没有 reload 命令；`grep -i reload crates/miao-engine/src` 只命中文案。
- host 只在 spawn 时传源计划；TS 侧 `refreshContext` 只在连接时跑一次
  （`packages/miao/src/engine/owners.ts:83`）。
- **已有热路径**：每个 provider turn 开始时，运行循环重新读取 Session 的 agent manifest
  并重新派生 policy（`runtime.rs:1471-1475`），执行期再读一份给工具调用
  （`runtime.rs:1475` 之后的 `policy`）；工作区指令文件每 turn 从磁盘重新发现
  （`context::read_sources`，`runtime.rs:1556-1571`）。也就是说 agent 变化与指令文件变化
  本来就每 turn 生效，缺的是**基底**（base policy / Tools / Provider）可变。
- 审批绑定 `policy_revision`：`approve_inner` 在 revision 不匹配时返回
  `ApprovalMismatch`（`runtime.rs:433-440`），所以换入新 policy 会让旧审批自动失效，
  这是现成的 fail-closed 语义。

## 3. 设计

### 3.1 配置代（generation）

新增 `config_reload` 命令，参数与启动时同源的 `sources` 计划（或 `config_dir`）。引擎重新
派生**纯配置**，把结果切成互不依赖的节，并对每节取内容摘要：

| 节 | 内容 | 载体 |
| --- | --- | --- |
| `policy` | `permission::Config` → `Policy` | `RwLock<Arc<Policy>>` |
| `models` | 模型目录与路由表（`--model-routes-config`） | `RwLock<Arc<Provider>>` |
| `mcp` | `--mcp-config` 的 server 列表 | `mcp::Registry::reconcile` |
| `lsp` | `--lsp-config` 的 server 列表 | `lsp::Registry::reconcile` |
| `context` | context sources / skills / references / hooks / formatter | `RwLock<Arc<...>>` per 项 |
| `tools` | product tools / worker 桥 | 沿用 `set_product_tools` 路径 |

一次 reload 产生 `ConfigGeneration { number, sections: BTreeMap<Section, String> }`，
只有摘要变化的节重建；未变化的节一个字节都不动。命令返回报告：

```json
{ "generation": 4, "changed": ["policy"], "unchanged": ["mcp","lsp","models","context"] }
```

派生失败（JSON 非法、未知键）不改变任何节：reload 返回错误并保留上一代，配置错误不会把
运行中的引擎打成不可用。

### 3.2 分节换入

- **policy**：`RwLock<Arc<Policy>>`。每 turn 开头取一次 Arc，turn 内不变。revision 本身由
  manifest 派生，换入即产生新 revision；未决审批按 §2 的既有校验失效，需要重新请求。
  **换入 policy 必须同时换入 `Tools` 的能力闸门**（writes/process/background/delegation/
  mcp/web/cron/wakeup）：闸门在 `Runtime::with_policy*` 构造时从 policy 烘进 `Tools`，
  只换 policy 会让收紧后的规则与旧闸门并存——检查通过、写入仍然放行。因此这一节不是
  "加一个 RwLock"，而是把闸门拆成可替换载体（或换入时重建 `Tools`）。
- **models**：`RwLock<Arc<dyn Provider>>`。Session 的模型绑定是持久事实，不因 reload 改变；
  下一个 turn 解析绑定时才看到新目录。绑定在新目录里不存在 → 该 turn 报错并要求重新选择，
  不静默回退。
- **mcp / lsp**：`Registry::reconcile(configs)`。按 server 名 + 配置摘要 diff：
  - 未变：复用现有 `Arc<Server>`（连接不断、不重启子进程）；
  - 新增：启动新连接；
  - 删除或变更：先取消/关闭该 server，再重建；重建失败时保留旧连接并把失败写进报告
    （`{ "failed": [{"server": "...", "error": "..."}] }`），不使整份配置回滚。
- **context / hooks**：`RwLock<Arc<Vec<_>>>`，turn 开头读快照。文件型指令本来就每 turn 读盘，
  不需要任何重建。
- **tools / worker**：沿用已有替换路径（`runtime.rs:295` 的 `with_product_tools`），按摘要
  diff 后只替换变化部分。

### 3.3 安全边界

- 一个 turn 开始时捕获 `TurnConfig { generation, policy: Arc<Policy>, tools 的相关快照 }`，
  **整个 turn 内使用同一份**。否则一个 turn 中途换规则会让前半段和后半段的权限、工具集、
  指令不一致，审批记录也无法解释。
- 边界就是现有的 settled assistant boundary（compaction 与 agent 变更使用同一处）；下一个
  provider turn 读取当前代。
- 队列中的输入不因 reload 改写或重建：delivery 记录、顺序、重试语义都与配置无关。
- 运行中的后台任务（process/worker/cron/timer）不因无关节变化而停止；只有它所属的节真的
  变化（例如 worker 配置）才按该节的语义重启。
- 审批按 §2 的 revision 校验失效：收紧立即生效，不会让旧审批沿用旧规则。

### 3.4 触发

- **显式**：`config_reload` wire 命令。宿主（TS `packages/miao`、Rust TUI）在检测到配置写入
  后调用；这是唯一保证两侧一致的入口。
- **standalone**：`serve --config-dir` 没有宿主，由引擎自己轮询源文件的 mtime（默认 2s，
  去抖后按摘要判定），走同一条换入路径。
- 不用 OS 文件监听：网络文件系统、容器挂载和编辑器原子写入的语义在各平台不一致，轮询
  mtime + 内容摘要更可预测。轮询覆盖每个 origin 命名的文件并集（policy 与 LSP 两侧，内联
  `content` 除外）；宿主若用显式 `config_reload`，轮询只是幂等的兜底。

## 4. 验收映射

| 验收条目 | 设计对应 | 验证方式 |
| --- | --- | --- |
| 模型、agent、MCP、LSP 及指令变化按服务重配 | §3.1 分节摘要 + §3.2 每节 reconcile | engine 集成测试：逐节修改源文件，断言只有该节重建，报告只列该节 |
| 活动 turn 在安全边界接纳变化 | §3.3 turn 捕获 | 测试：turn 中 reload，该 turn 的 policy/工具集不变；下一 turn 生效 |
| 无关变更不重建输入、任务与连接 | §3.1 摘要未变不重建；§3.2 复用 `Arc<Server>` | 测试：只改 policy 时 `Arc::ptr_eq` 复用 MCP/LSP server，队列输入与运行中 run 状态不变 |
| 关联 PR、验收记录与适用版本 | — | 每个实现切片单独 PR；验收记录写入本文件附录 |

另外记录质量/费用证据：一次 reload 不产生 provider 调用（`usage` 不变），不新增子进程
（`ps`/连接数不变）。

## 5. 不做

- 不重启 Runtime，不重建 Store，不改变单 Runtime / 单数据库所有权。
- 不做跨进程配置共享：一个 Runtime 只有一代当前配置。
- 不改变配置语义、优先级与 V1 迁移规则（S5 已定）。
- 不为插件提供新的配置读取 API（属于 Phase 4）。
- 不自动重放被打断的 provider/tool 调用（沿 `specs/runtime-upgrades.md` 的约束）。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| reconcile 启动失败导致工具面缺失 | 保留旧连接，报告失败；只有 policy 收紧才允许 fail closed |
| 长时间 turn 期间配置反复变化 | 只在 turn 边界取最新一代，中间变化合并，不逐次重建 |
| policy 换代让未决审批失效 | 这是期望的 fail-closed 语义；客户端收到 `ApprovalMismatch` 后重新请求 |
| 轮询在超大配置目录上的开销 | 默认 2s、只 stat 已知源文件，不做目录遍历；摘要只在 mtime 变化后计算 |
| 与 `runtime-upgrades.md`“新客户端不改运行中配置”混淆 | 该约束针对跨 release 加入者；本项是运行中 Runtime 接受自己宿主的配置更新，二者不冲突 |

## 7. 实现顺序

1. **LSP 增量重配（已实现）**：`config_reload` 命令与分节报告；`lsp::Registry::reconcile`
   按 server 名 + 配置 diff——未变的连接保留，变更/删除的在下次使用前关闭。启动来源
   （`--lsp-config` / `--config-sources` / `--config-dir`）记为 `LspOrigin`，重载重读同一来源。
   reload 自身不 spawn 子进程；派生失败不改动任何一节。
2. **policy 与工具闸门（已实现）**：见 §3.2——单独换 policy 会让收紧的规则与旧闸门并存，
   必须同时换入能力闸门。`Inner.policy` 改为 `RwLock<Arc<Policy>>`（每 turn 取一次快照，
   turn 内不变，未决审批按 revision 自动失效）；`Tools` 的八个能力闸门收进 `Gates`，放在
   共享 cell 里整体换入，web 客户端同为可换载体；启动来源记为 `PolicyOrigin`（`--policy` /
   `--config-sources` / `--config-dir` / entry 默认，`--mode` 每次重新施加），重载重读同一来源。
   启动时的不变式（process 需要数据库与凭证在工作区外、MCP 需要外部授权）在换入前重跑，
   违反则整份拒绝且不改动任何一节。换入顺序为先闸门后 policy：该方向只会比旧 policy 更严。
   standalone 轮询的观察面扩为 policy 与 LSP 两侧文件的并集。验证：`tests/config_reload_policy.rs`
   覆盖"收紧/放宽换入闸门与工具面、同内容不换代、畸形配置不改动、越界 process 被拒"；
   真实引擎以 `--config-dir` 运行、只改 `sandbox.mode` 两次，轮询各打印一次
   `configuration reloaded: ["policy"]`，generation 1→2→3 而 LSP 三台服务器始终 `unchanged`。
3. **MCP reconcile（已实现）**：`Registry` 的 `authority`/`servers`/`configs` 改为可替换载体，
   `children` 按 server 名归属（与 LSP 相同），不再有 registry 级 child 列表。每台 server 记录
   配置摘要 `fingerprint`；`Registry::reconcile` 按名字 + 摘要 diff：未变复用连接、watcher 与
   子进程，变更/新增先连接新实例再关闭旧连接（失败保留旧连接并写入 `mcp.failed`），删除则移除
   工具、通知 watcher 退出并杀子进程。列表级不变量（8 台上限、重名、authority revision）在任何
   连接被替换前校验。启动来源记为 `McpOrigin::Manifest`，`config_reload` 报告新增
   `mcp: {changed, unchanged, removed, failed}`；standalone 轮询文件并集包含 `--mcp-config`。
   验证：`tests/config_reload_mcp.rs` 4 个用例（连接计数证明未变 server 不重连、换配置只重建该
   server、失败保留旧连接仍可调用、非法清单不改动任何状态）；`cargo test` 全量通过；
   `cargo clippy --all-targets -- -D warnings` 与 `cargo fmt --check` 在构建机通过。
4. **Provider 路由替换（已实现）**：`Inner.provider` 改为 `RwLock<Arc<dyn Provider>>`，每 turn 取
   一次快照；启动时把**未路由的 base provider** 与 `--model-routes-config` 路径、工作区一并记为
   `model_routes::Origin`。`config_reload` 用同一 base 重新叠加清单，得到新目录与
   `RouteLimits`，与运行中的目录逐项比较（`model_catalog()` + 限额），只有真变化才换入；
   限额先换、目录后换，避免"新容量配旧限额"。派生失败（含文件名）整份拒绝，旧目录继续服务；
   Session 的绑定是持久事实，`session_model::select` 在新目录里找不到 route 时该 turn 显式报错，
   不静默回退。standalone 轮询文件并集加入清单路径。验证：`tests/config_reload_models.rs`
   覆盖"同内容不换代 / 增删 route 换代且目录即时可见 / 畸形清单报文件名且旧目录仍在 /
   失败后恢复原清单不推进 generation"。
5. **context / hooks / skills / references**：各自载体的换代。
6. **standalone 轮询**：`--config-dir` 模式的 mtime 观察。
7. **宿主接线**：TS 与 Rust TUI 在配置写入后调用 `config_reload`，并把报告显示为一行状态。
