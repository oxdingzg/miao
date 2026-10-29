# AGT-01：子代理状态、内联历史与父子导航

状态：设计待审阅；无代码改动。本文界定父会话如何观察一个在跑/已完成的子代理：它的活状态、
它内联进父转写的进度、以及父子会话间的导航。是 AGT-03（净收益委派与报告）的观察面下游：
AGT-03 说子交回什么，本文说父在界面上如何看见与进入。源码基线为 main `e76435ad96`，2026-10-28。

## 1. 问题

委派一个子代理后，父（和用户）要看清"那个子在干什么、干到哪、结果在哪"。今天父子关系只以
一个 `parent_id` 外键存在，没有统一的观察面：子的活状态不显式呈现，子的历史无法内联预览，父
子会话之间不能一键往返。AGT-01 要给出这三件事的产品契约。

## 2. 现状盘点（as-is，锚定实现）

- **父子关系**：`SessionTable.parent_id`（`session/sql.ts:33`）+ `session_parent_idx`（`:76`）。
  子会话知道自己父，但没有反向的"父看子"产品面。
- **列表过滤**：`list-sessions` 工具带 `parentID` 过滤（`tool/list-sessions.ts:13`），可按父列出
  子——这是唯一现有的"父看子"入口，且是模型侧工具，不是用户界面。
- **委派进度**：AGT-03 的 `report` 中间便签 + `childProgress` 失败汇总，都是**父模型**读的文本，
  不是用户可见的子状态显示。
- **无内联子历史**：父转写里没有子会话的进度内联视图；要看子只能整会话切换。
- **无父子导航**：TUI 没有"进入此子会话 / 返回父会话"的导航。

即：**父子关系已落库、可被模型按父过滤，但用户可见的活状态、内联历史、父子导航三者皆无。**

## 3. 三件事的产品契约

1. **子状态（state）**：父转写里每个委派调用渲染一行活状态——排队/运行中(含已运行时长)/完成
   (含子报告摘要)/失败(含 `childProgress` 的 N 次调用)。数据源是子会话的 drain 状态事件
   （`session.next.status` 的 busy/idle/phase，见 `v2/session.md:128`）与委派任务表。
2. **内联历史（inline history）**：父可在该委派调用上展开一个只读折叠视图，内联子会话的最近
   N 条（工具调用 + 结论），不必整会话切换。数据源是子会话 `SessionHistory`，按父的预算有界。
3. **父子导航（navigation）**：一个动作进入子会话（沿用现有会话切换），并保留"返回父"的栈。
   进入子后可继续在子里工作；返回父时父的转写回到原位。子删除后导航降级为只读内联历史。

## 4. 现状缺口

- **G1｜无子活状态面**：父/用户看不出委派子在跑还是已完成，只有父模型收到的文本报告。
- **G2｜无内联子历史**：要看子的进度只能整会话切换，打断父的上下文。
- **G3｜无父子导航栈**：父子会话间不能一键往返，返回父要靠会话列表重找。

## 5. 目标契约（提案，不在本文实施）

- **C1｜子状态行**：委派调用在父转写渲染活状态，源自私有 drain 状态事件 + 任务表，复用
  `session.next.status` 词表，不新增事件类型。
- **C2｜内联只读子历史**：折叠视图内联子最近 N 条，按父预算有界、只读、可展开；子删除则保留
  已内联的快照。
- **C3｜父子导航栈**：进入子复用现有会话切换，维护一个返回栈；子删除则导航降级为 C2 只读。

## 6. 与相邻工作的边界

- **AGT-03 报告**：属主子交回什么（结构化报告/净收益）；本文属主父如何看见与进入，不重叠。
- **AGT-02 取消/预算**：子的取消传播与预算继承归 AGT-02；本文只读其状态。
- **HIS-01 列表/排序**：会话列表的排序置顶归 HIS-01；本文只用父子过滤与导航。
- **TUI-02/07 视图**：子状态行/内联视图的 TUI 实现归 TUI 域；本文定义需要哪些字段与导航语义。
- **RUN 状态词表**：C1 复用 `session.next.status`，不另起事件。

## 7. 验收方向（后续）

设计对齐，不带验收。落地时以最小改动验证：委派子在父转写显示活状态并随子完成而更新（C1）、
父可内联展开子最近历史且有界只读（C2）、进入子再一键返回父（C3）。真实隔离覆盖随 SEC-04。

## 8. Rust 面（引擎侧）

C1 需要的数据必须由引擎回答：TS 侧 `parent_id` 只是产品库的一列，引擎库的父子事实在
`engine_lineage(session_id, parent_session_id, message_seq)`，子的执行状态在 `engine_run`。
TS 迁移到 Rust 引擎后，父看子的观测面若仍留在 TS，就得读两份库，所以这里先补引擎侧只读面。

**命令 `session_children { session_id }`**（S1 已实现）：

```
{ session_id, truncated, children: [{
    session_id, title, parent_message_seq, message_count,
    created_at_ms, updated_at_ms, archived_at_ms, pinned_at_ms,
    status, run }] }
```

- 数据源：`engine_lineage` 边 + `engine_session` 目录行 + `engine_message` 计数 + 子的最新
  `engine_run`；不新造事件类型，也不复制 TS 的 `session.next.status` 状态机。
- `status` 只区分 `busy`（子有 running run）/ `idle`，与 C1 复用的 busy/idle 词表一致；子怎么结束
  的由 `run.state` 回答（`completed`/`failed`/`cancelled`/`interrupted`），两者分开是因为
  "跑完了"和"从没跑过"在产品上要显示成不同的一行。
- `run` 为 `{id, state, started_at_ms}` 或 null；`started_at_ms` 取该 run 的 `run.started` 事件本地
  时间，让父界面能自己算已经跑了多久，无需回放事件。
- 排序按子创建时间，最多 200 条，`truncated` 说明是否截断；归档的子仍在列表里（归档是目录偏好，
  不是撤回委派）。无子回答空列表；未知 Session 报 `invalid_request`。

**仍归产品侧（未实现）**：C1 的 TUI 渲染行、C2 的内联只读历史（需要一个按父预算有界的子历史页，
可与 `history` 的游标化一起做）、C3 的父子导航栈。引擎侧后续可补 `session_children` 的分页
（若 200 条不够）与子历史的有界页，TUI 域再按 §6 的边界接。

**验证（S1）**：`tests/children.rs` 4 条（空列表与未知 Session、fork 边界/归档仍可见、running→busy
与结束后 `run.state`、截断计数）全部对真实 sqlite 运行；`tests/stdio.rs` 增加一条 wire 用例
（admit-only 的父边界为 0、子的空列表、未知 Session 报错）；`--lib`、`cargo test` 全量、clippy
`-D warnings`、`cargo fmt --check` 均干净。
