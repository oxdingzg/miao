# Phase 3 T5：流式状态、打断、审批与提问

状态：设计 + 实现（2026-10-27）。前置：T4（PR #1528）、T3（PR #1527）。

## 1. 范围

T5 让运行中的 Session 可被看见、可被叫停，并让引擎的两种阻塞请求
（`approval` 与 `question`）在 TUI 里得到回答：

- **状态条**：标题栏显示 `working` / `idle`，运行中附 `Esc interrupt`；有排队输入时
  显示条数。数据来自 snapshot 的 `active_run` 与 `pending`，不依赖本地推断。
- **增量刷新**：订阅事件里 `run.started`、`run.finished`、`run.cancel_requested`、
  `approval.resolved`、`question.resolved` 都触发一次去抖投影，这样运行开始/结束和
  面板消失都不再等下一条 `message.committed`。
- **打断**：`Esc` 在 `active_run` 非空时发 `cancel{session_id}`，否则回 home。
  取消是异步的：界面立即显示 `cancelling`，由随后的 `run.finished` 恢复。
- **审批面板**：`1` 允许本次（`approve` + `decision:"allow"`），`2` 始终允许
  （`approve_persistent`），`3` 拒绝（`decision:"deny"`）。请求体回显 snapshot
  里的 `request_id`、`input_hash`、`policy_revision` 与 `matcher`。
- **提问面板**：`↑/↓`（或 `j/k`）移动、`Space` 切换多选、`Enter` 提交答案、`Esc`
  拒绝（`reject_question`）。多个问题时按顺序回答，凑齐后一次 `answer_question`。
- **面板渲染**：画在 transcript 与 composer 之间，最多 12 行；同一时刻只处理队列里
  的第一个请求（引擎串行等待）。

不做：`@agent`/命令面（T8）、markdown/工具详情渲染（T9）、队列输入的显式提升
（引擎按 delivery 语义处理）、审批规则编辑。

## 2. 引擎契约（来自 `crates/miao-engine`）

- `snapshot.active_run: Option<String>`；`snapshot.pending: [{input_id,delivery,
  admitted_seq,preview,truncated}]`。
- `snapshot.approvals: [Approval]`，`Approval` 至少含
  `request_id, tool, resource, input, input_hash, policy_revision, matcher,
  expires_at_ms`。
- `snapshot.questions: [question.requested.data]`，即
  `{question_id, input_hash, input:{questions:[{question,header,options:[{label,
  description}],multiSelect,custom}], timeout_ms}}`。
- `approve` 的 `response`：`{request_id, input_hash, policy_revision,
  decision:"allow"|"deny", matcher?}`；`approve_persistent` 同形。
- `answer_question` 的 `answer`：`{question_id, input_hash, answers: Vec<Vec<String>>}`
  （每个问题一组标签）。
- `reject_question` 的 `rejection`：`{question_id, input_hash}`。
- 解析对未知字段保持宽容，缺字段的面板请求直接跳过而不是让整个 snapshot 失败。

## 3. 模型

`session.rs` 新增：

- `SessionState { active_run: Option<String>, pending: usize, approvals:
  Vec<ApprovalView>, questions: Vec<QuestionView> }`，`SessionState::from_snapshot`。
- `ApprovalView { request_id, tool, resource, input, input_hash, policy_revision,
  matcher: Option<Value>, expires_at_ms }`，以及 `response(decision) -> Value`。
- `QuestionView { question_id, input_hash, questions: Vec<QuestionViewItem> }`；
  `QuestionViewItem { question, header, options: Vec<Choice>, multi_select }`。

`App` 持有 `state: SessionState`；`AppEvent::SessionOpened` 带上它。

## 4. 渲染与键位

- `Shell` 在 transcript 和 composer 之间插入一个面板区；高度由 `app.panel()` 决定
  （0 表示无面板）。
- 面板打开时，除滚动键外的普通输入不进入编辑器：审批/提问是阻塞决策，误触键盘
  不能变成给模型的文本。
- 状态条复用 `TitlePane` 的右侧文案：`· working · Esc interrupt` / `· idle`。

## 5. 验证

- 单测：snapshot → `SessionState`（缺字段、未知字段、多个请求）；审批响应 JSON 与
  提问答案 JSON 逐字段断言；`Esc` 在 `active_run` 时发 `Cancel` 而不是回 home；
  面板键位（移动/切换/提交）只改面板状态。
- pty 冒烟：假引擎快照带一个审批请求，断言面板渲染出工具名与选项；按 `1` 后引擎
  收到 `approve` 帧（`MIAO_TUI_FAKE_ACTION_LOG`），面板随后消失（快照改为无审批）。
- `run.finished` 之后状态条回到 `idle`。
