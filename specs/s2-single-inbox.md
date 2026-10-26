# S2：单一 durable inbox 设计

状态：设计稿，2026-10-26。前置阅读：`specs/rust-phase-2.md` §2（目标不变量）、§4（切片 S2 的验收）。

## 1. 目的

`specs/rust-phase-2.md` §1 的测绘结论是今天有两套 durable inbox：TS 的 `session_input`
与引擎的 `engine_input`。两套 inbox 各自决定 steer/queue 的提升顺序，所以"同一段 prompt
脚本在两个 placement 上产生同样的提升顺序"无法保证。

S2 把那两套收成一套：**所有 Session 的 prompt 准入都写引擎的 `engine_input`**，
TS 侧 `session_input` 停止写入、只保留事件投影，直到 S4 把表降级掉。

S2 的验收（spec §4）：

- native 与 TS Session 的 steer/queue 提升顺序在重放中一致；
- `session_input` 没有新行。

## 2. 现状

### TS 侧

- 准入：`packages/core/src/session/input.ts:63` 的 `admit`，对 native placement 直接
  拒绝（`input.ts:73` 的 `SessionEnginePlacement.requireTypeScript`），并在事件提交时再
  校验一次（`:87`）。
- 存储：`session_input` 表（`packages/core/src/session/sql.ts:155`），带
  `(session_id, admitted_seq)` 与 `(session_id, promoted_seq)` 两个唯一索引（`:177-178`），
  所以"同一 Session 的准入顺序"与"提升顺序"在 TS 侧是表约束。
- 投影：`projectAdmitted` / `projectPrompted`（`input.ts:112`、`:161`）把
  `PromptAdmitted` / `Prompted` 事件投影进表，并对重复投影做对账（同一 id 的
  prompt/delivery/promoted_seq 必须一致，否则 `LifecycleConflict`）。
- 读取：`pending`（`:42`）与 `hasPending`（`:196`）给 runner 与 TUI 用。
- 生产调用点共 5 处：`session/heal.ts`、`session/peer-tools.ts`、`session/runner/llm.ts`、
  `session/placement.ts`、`session/delegation.ts`（另有 `session.ts` 一处）。

### 引擎侧

- 准入：`crates/miao-engine/src/runtime.rs:599` 的 `Runtime::admit`（`:606` 的 `admit_with`）
  落到 `store.rs:434` 的 `Store::admit`，写事务在 `admit_input`（`store.rs:2557`）。
- 幂等与对账：`admit_input` 按 `input_id` 查已有行（`store.rs:2585`），已取消的准入视为
  冲突（`store.rs:2612`），命令与 agent 引用不一致也视为冲突；同 id 同 prompt 同 delivery
  的重复准入返回同一张收据。
- 提升：`promote_tx`（`store.rs:2396`）先取全部 `steer` 行（按 `admitted_seq`），
  `queue` 只在 Session 即将 idle 时取一行（`store.rs:2403`）。
- 交付词汇已经明确：steer 在当前 drain 继续时于下一个安全边界提升；queue 等 Session 否则
  会 idle 时提升一条，然后再判断是否继续。提升任何新的用户输入都重置所选 agent 的
  provider-turn 配额，一批 steer 只重置一次。

## 3. 设计

### 3.1 准入属主 = placement 属主

`input.ts` 的三处 `requireTypeScript`（`:73`、`:87`、`input.ts:245`/`:256`）换成
"准入必须走该 Session 的 placement 属主"。S2 期间 placement 仍有两种，所以产品侧需要一个
统一入口：`SessionAdmission.admit(location, sessionID, input)`，对两种 placement 都调用
引擎的 `promptProduct`（native 现状已在用）。

即：S2 不改 placement 路由（S3 才收口），改的是"谁写 inbox"。TS Session 的执行仍留在 TS，
但它的输入先写进引擎的 `engine_input`，由 TS runner 通过投影读取待提升输入。

**已定（2026-10-26，S3/S4 落地后）**：选择 (2)。引擎发事件、产品投影进 `session_input`，
TS runner 的读取路径不变；遗留在 TS 侧的会话用 `miao session migrate-all`（S4）迁到引擎后即走引擎 inbox。
理由有两条，都是实现时验证过的：S3 之后新会话默认就是 native，`session_input` 对新会话本来就不再增长；
而要把遗留 TS 会话的准入改到引擎，必须先有它的引擎存储，那正是 S4 的迁移，不能让 S2 先造一条影子路径。

原选项（保留原文以便对照）：TS runner 目前从 `session_input` 读 pending（`input.ts:42`）。
S2 有两个选择：

1. TS runner 改读引擎 inbox（新增一个只读 RPC，把 `engine_input` 的 pending 投影出来）；
2. 引擎把 `admitted`/`promoted` 事件回放给产品，产品继续投影到 `session_input`（只读），
   TS runner 保持读 `session_input`。

本文推荐 (2)：它把"唯一写入者"做实，同时让 TS runner 的读取路径在 S2 完全不变，
回滚只需要把写入者换回去。(1) 会把改动面同时扩到 runner 的读取循环，风险更大。

### 3.2 投影写入者

`projectAdmitted` / `projectPrompted` 已经是幂等且带对账的（§2），S2 只是把它们变成
`session_input` 的唯一写入者：

- 准入事件由引擎产出（`input.admitted`），产品投影；
- 提升事件由引擎产出（`prompted`），产品投影 `promoted_seq`；
- 其它写 `session_input` 的代码路径删除，并用测试钉住：投影之外的调用会让测试失败
  （`SessionInput` 模块集中导出写入口，其它模块只能调投影）。

### 3.3 提升顺序的唯一权威

提升顺序由引擎的 `admitted_seq` 决定（`promote_tx`）。TS 侧不再参与顺序判定：
`session_input` 的 `(session_id, admitted_seq)` 唯一索引退化为投影断言。

重放一致性测试（S2 的唯一硬验收）：

1. 用同一段脚本（steer、queue、tool 调用、interrupt）驱动一个 native Session 与一个
   TS Session；
2. 断言两侧的"提升序列"（哪些 message id、以什么顺序变成可见 user message）逐项相等；
3. 断言 `session_input` 的行数在 TS Session 上不再增长（只由投影写）。

### 3.4 回滚

一个环境变量把准入切回 TS；`session_input` 在两种模式下都是投影，所以切回去不需要数据迁移。
S4 才删除旧路径。

## 4. 不做

- 不改 placement 路由（S3）。
- 不合并存储文件（S4）。
- 不删除 `session_input` 表（S4）；S2 只让它变成只读投影。
- 不动 steer/queue 的语义本身：S2 只统一"谁是唯一写入者"。

## 5. 风险

| 风险 | 处理 |
|---|---|
| 双写窗口内同一 prompt 被写两次 | 引擎 `admit_input` 已按 id 对账；产品投影对账（`matchesProjection`）保持 |
| TS Session 的执行进程与引擎进程不同，事件到达有延迟 | 投影以事件 seq 为准，TUI 读取不变；测试覆盖乱序重放 |
| TS runner 读 pending 的时机与引擎提升时机冲突 | 由 §3.1 的 (2) 保持读取路径不变，先观察一个发布周期 |
| 回滚后引擎侧残留 pending 行 | 回滚前先 drain；测试覆盖"切回 TS 后引擎 inbox 为空" |
