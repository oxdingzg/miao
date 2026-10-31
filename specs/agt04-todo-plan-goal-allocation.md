# AGT-04：Todo、计划与持久 Goal 的分工

状态：设计待审阅；无代码改动。本文盘点三套并存的"任务状态"机制的真实实现，界定各自的
单一属主、生命周期、耐久性与相互引用，指出当前实现的越界与缺口，并给出目标契约，供后续
委派（AGT-02/03）与自动续跑工作对齐。源码基线为 main `7cac644215`，2026-10-28。

## 1. 问题

会话里同时存在四种"接下来做什么"的表达：**计划（Plan）**、**待办（Todo）**、**持久目标
（Goal）**、**委派（Delegation）**。它们概念相邻，却由不同模块属主、有不同耐久性与不同续跑
作用。没有一份文档界定边界，模型与实现都会把同一份状态写进多处，或在切换时丢失。AGT-04
要回答：这三者各 owns 什么、谁是续跑的开关、谁是续跑的燃料、切换时谁必须被转写。

## 2. 现状盘点（as-is，锚定实现）

### 2.1 三套机制

| 机制 | 属主 | 耐久性 | 基数 | 语义 |
| --- | --- | --- | --- | --- |
| Plan | `plan` agent（`tool/plan-approval.ts:43`） | 会话转写文本，**不落结构化存储** | — | 只读设计/调研模式。`plan_enter` 经用户批准把 `build` 切到 `plan`；`plan_exit` 切回 `build`（`plan-approval.ts:43,57`）。切换对本会话耐久。产物是 plan agent 转写里的一段文本。 |
| Todo | `SessionTodo`（`session/todo.ts:1`） | `TodoTable`，跨压缩耐久 | 多条 | 细粒度任务图：`id`、`depends_on`、`status`、`priority`。`SessionTodo.runnable(list)` 求就绪前沿。注入上下文；8 轮未同步触发陈旧提醒（`todo.ts` `STALE_AFTER_TURNS=8`、`STALE_REMIND_EVERY_TURNS=4`）。工具 `todowrite`（`tool/todowrite.ts:1`）。 |
| Goal | `SessionGoal`（`session/goal.ts:1`） | synthetic 消息 metadata，**跨压缩耐久** | 一条 | 单一持久目标：`objective`、`status(active/paused/blocked/done)`、`autonomous`、`evidence`、`budget`。`done`/`blocked` 必须带 `evidence`（`tool/goal.ts` `validate`）。`current()` 取最新一条（`session/goal.ts:28`）。 |

### 2.2 委派（正交第四维）

`SessionDelegation`（`session/delegation.ts:1`）属主"由谁做"：派生子会话，带 `budget`（数字），
失败时用 `childProgress`（`delegation.ts:27`）报告子代理已完成的进度供父代理决定重做多少。
它与上面三者正交：一个 Todo 项可被委派给子会话，Goal 与 Plan 不下放。

### 2.3 自动续跑闭环（Goal 开关 + Todo 燃料）

续跑逻辑在 `session/runner/llm.ts:2127-2165`：

- **开关**：默认 todo 驱动——有 runnable Todo 就续跑，无需 Goal（`llm.ts:2136-2141`）。
  停车开关：配置 `loop.enabled: false` 整体禁用；已记录的 Goal 非 `active`
  （paused/blocked/done）抑制续跑。配置 `loop.enabled: true` 可覆盖
  `max_iterations` 与 `continue_prompt`。
- **燃料**：`SessionTodo.runnable(list)` 求就绪前沿，`list.length > 0 && open.length > 0` 才继续（`llm.ts:2141`）。
- **边界**：`DEFAULT_LOOP_MAX_ITERATIONS = 25`、`LOOP_STALL_LIMIT = 2`（按 todo 判定签名是否停滞）、
  后台任务在跑则 `waiting-background-job` 挂起（`llm.ts:235-237`、`2141-2160`）。
- **提示**：`DEFAULT_LOOP_PROMPT`（`llm.ts:237`）指示模型按 `depends_on` 就绪顺序取任务、
  外部等待标 `waiting`、需决策标 `blocked`、全部完成且验证后回 DONE 停止。

即：**Todo 是续跑的默认开关、燃料与进度账本；Goal 从主开关降级为停车判据**，
二者在 loop 处耦合。rust engine（`crates/miao-engine/src/runtime.rs`）同语义：
默认 `max_provider_turns = null`（显式配置才是轮数缰绳），续跑条件为
"有 runnable todo 且无非 active Goal"，停滞保护相同。

## 3. 分工代数（目标属主边界）

每条状态只有一个属主，任何一处都不镜像另一处的内容。

1. **Goal owns「是否继续、以什么边界继续」**：结果 + 自主授权 + 预算 + 停止判据。每会话一条，跨压缩耐久。它是续跑主开关，不记录"做到哪一步"。
2. **Todo owns「此刻什么就绪、依赖如何」**：可运行前沿 + 进度账本。多条，跨压缩耐久。它是续跑燃料，不承载"要不要继续"。
3. **Plan owns「提交前的方法」**：只读模式下的设计/调研。它是**模式，不是存储状态**；产物是文本，必须在 `plan_exit` 前转写进 Todo（若改变了结果则同时进 Goal）才能存活。
4. **Delegation owns「谁做其中一个有界切片」**：子会话 + 预算 + 恢复。与三者正交。

### 3.1 引用方向

- 根是 Goal；Todo 是当前 Goal 方法的分解；Plan 产出播种 Todo。
- Goal 不引用具体 Todo（粗粒度），但 Todo 隐式服务于 active Goal。
- 方向单向：Plan → Todo →（服务于）Goal。禁止反向把 Todo 列表回灌成 Goal 文本。

### 3.2 生命周期耦合

- Goal status 门控 loop；Todo runnable 喂养 loop。
- 停止判据优先级见 §5 C4。`goal.done`（带 evidence）或全部 Todo 完成且验证（回 DONE）或超预算或到迭代上限或停滞。
- 耐久性：Goal、Todo 跨压缩存活；**Plan 不存活**，故 `plan_exit` 是一次必须完成转写的边界。

## 4. 现状缺口（越界与不一致，锚定代码）

- **G1｜Plan→Todo 无转写契约**：`plan_exit` 只切 agent（`plan-approval.ts:43`），不产出结构化计划，也不要求把方案落成 Todo。切回 build 后若遇压缩，方案文本即丢失。
- **G2｜Todo 无"归属当前 Goal"不变式**：loop 同时读 goal 与 todo，但改 Goal 后没有任何机制要求重设/取消旧 Todo。陈旧 Goal + 新 Todo（或反之）会分叉。
- **G3｜两套预算语义不统一**：`Goal.budget` 是自由字符串（`session/goal.ts` Info），仅信息性；`Delegation.budget` 是数字并被强制。loop 只查会话级 `exceeded(current)`，`Goal.budget` 未被机器校验（迭代/令牌）。
- **G4｜两套进度信号无仲裁**：Todo 陈旧提醒（8 轮，`todo.ts`）与 loop 停滞（todo 签名 2 次，`llm.ts`）与预算超限（`exceeded`）三条轴各自触发，冲突时无既定优先级。
- **G5｜`paused`/`blocked` 语义未定义**：loop 条件只认 `active`（`llm.ts:2128`），paused/blocked/done 均停止续跑，但未定义暂停期间 Todo 是否保留、唤醒如何恢复。

## 5. 目标契约（提案，不在本文实施）

- **C1｜Plan 是执行前模式**：plan agent 不写 Todo；方案在 `plan_exit` 时（由 harness 或模型一次性）转写为 Todo 图，若结果与进入前不同则同时更新 Goal。`plan_exit` 应产出一个结构化计划工件或校验 Todo 已就位，否则给出未转写告警。
- **C2｜改 Goal 必重设 Todo**：Goal.objective 变化时，旧来源的 Todo 须被重定范围或取消，不允许跨 Goal 的孤儿 Todo。可在 `goal` 工具写入时校验/提示。
- **C3｜统一预算**：`Goal.budget` 从字符串改为结构化边界（iterations / tokens / wallclock），由 loop 机器校验；Delegation 预算保持每子会话。二者单位与属主分离，不互相镜像。
- **C4｜停止仲裁顺序**：`goal.done` > 预算超限 > 迭代上限 > 停滞 > `waiting-background-job`。Todo 陈旧提醒是**提醒**（不停车），与停止判据正交。
- **C5｜`paused`/`blocked` 语义**：暂停保留 Todo、不自动续跑、由用户提示或唤醒恢复；`blocked` 必须带 evidence（已有），恢复时从就绪前沿继续。

## 6. 与相邻工作的边界

- **AGT-02 委派边界/预算继承**：本文只界定 Goal/Todo/Plan 分工；Delegation 的预算继承与取消归 AGT-02。C3 的 Goal 结构化预算是其前置。
- **AGT-03 结构化委派报告**：子会话 `childProgress` 如何汇成父报告归 AGT-03。
- **AGT-05 跨会话回执**：Goal/Todo 是否跨会话（父→子）传递不属本文。
- **RUN-07 问答、SEC-03 取消结算**：loop 的挂起/唤醒依赖这些底层机制，本文只声明依赖不重定义。

## 7. 验收方向（后续）

本文是设计对齐，不带验收。落地时以最小改动验证：改 Goal 后无孤儿 Todo（C2）、`plan_exit` 产生
转写校验（C1）、预算超限先于停滞停止（C4）。真实隔离覆盖随 SEC-04。
