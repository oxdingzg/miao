# RUN-05：provider 续跑歧义的恢复设计

状态：设计待审阅；无代码改动。本文界定"一个 provider turn 在部分耐久发布之后中断"这一
歧义态的恢复决策：何时可安全续跑、何时必须诚实截断、何时只能放弃，以及让该决策成为
已提交日志的纯函数所需的耐久标记。是 `specs/v2/session.md` §恢复的续篇，补上它明列为
未完成的切片。源码基线为 main `7cac644215`，2026-10-28。

## 1. 问题：什么叫"续跑歧义"

一个 provider turn 通过 `llm.stream(request)` 派发后，可能在流式输出中途死亡（进程崩溃、
drain 丢失、连接断）。此时三件事可能已经发生，且我们**无法向无状态 provider 追问**：

1. 请求是否已到达、令牌是否已计费（计费歧义）；
2. 多少助手输出已写进耐久事件日志（发布歧义）——日志是我们唯一可信的真相；
3. 已派发的工具是否已完成副作用（副作用歧义，归 RUN-04）。

"歧义"专指第 2 项：**turn 已发布部分内容、又没走到干净边界**。恢复必须在"不重复已提交
内容"与"不丢弃已付费进度"之间抉择，且不能重放副作用。

## 2. 现状盘点（as-is，锚定实现）

已存在、且不在本文范围的恢复：

- **in-turn 重试（发布前）**：`runner/provider-retry.ts` 只在"未发布任何耐久内容"时重试
  （`provider-retry.ts:13` 注释：一旦 text/reasoning/tool call 可见，重放即重复）。首字节前
  的瞬时失败在此闭环。
- **输出上限续跑（干净边界）**：`MAX_OUTPUT_CONTINUATIONS = 2`（`llm.ts:189`）在模型撞
  输出 token 上限时续跑——这是一个**已知、干净**的切点，不歧义。
- **工具中断恢复（RUN-04，已 Done）**：组装请求前，把上一进程投影为 `running` 的本地工具
  以 `Tool execution interrupted` 耐久失败，`abandoned side effects are never silently
  replayed`（`v2/session.md:50`）。流在工具调用完成前死亡时用 `INTERRUPTED_TOOL_CALL`
  （`llm.ts:232`）诚实丢弃已准备的工具。
- **溢出恢复**：provider 在耐久输出前以 context overflow 拒绝时做一次压缩，第二次溢出或
  耐久输出后溢出即普通终止失败，`recovery never loops or replays partial side effects`
  （`v2/session.md:120`）。
- **状态词表**：`session.next.status` 有 busy/idle 与 phase（含 `retrying`）、`attempt`
  计一次 turn 内的重试（`v2/session.md:128-142`）。

**显式缺口**：

- `v2/session.md:103`：future work 明列 "Add durable post-crash continuation recovery for
  promoted or provider-dispatched work"。
- `llm.ts:157`：注释 "Durable continuation recovery across drains remains a separate
  future slice with an explicit retry policy."
- `llm.ts:122`：TODO "- [ ] Mark busy, retrying, idle, interrupted, or terminal-failure
  status durably"——恢复赖以决策的**耐久 turn 相位标记本身尚未落地**。

即：工具半边已有恢复（RUN-04），**助手流半边的跨 drain 部分发布恢复是空白**（本文）。

## 3. 恢复原则：让决策成为已提交日志的纯函数

崩溃后没有进程内存可用，唯一真相是耐久事件日志。恢复 = 读最后一个耐久助手消息状态 +
工具结算状态，据此决定，绝不依赖"我记得派发过"。三条原则：

1. **绝不重复已提交内容**：已写入日志的助手前缀 / 已结算的工具，恢复永不重放。
2. **绝不静默重放副作用**：沿用 RUN-04 与溢出恢复的既定铁律。
3. **诚实截断优于猜测续跑**：无状态 provider 无法从半流恢复；与其冒险重派发，不如把
   已提交前缀标记为被截断，让历史诚实。

## 4. 恢复决策树（resume as a function of the journal）

对崩溃前在飞的那个 turn，按日志末态分支：

- **A｜本 turn 无任何耐久助手输出**：turn 从未提交。等价首字节前，安全地整轮重派发。
  这是 in-turn 重试的跨进程推广，无歧义。
- **B｜有助手部分输出、无已结算工具调用**（歧义核心）：provider 不能半流续。默认走**诚实
  截断**——给该部分助手消息打一个 `interrupted` 终态标记（承载已提交前缀 + 一个说明性
  终止块，镜像 `INTERRUPTED_TOOL_CALL` 的诚实），使历史成为合法、不重复的前缀。会话随后
  由外层 admission/wake 用**新一轮**继续，并在新一轮里承认被截断。禁止整轮重派发（会重复
  前缀、双重计费）。
- **C｜有已结算工具调用**：工具结算本身是续跑点。已结算的不再触碰（RUN-04 保证）；stream
  在其后死亡则该助手消息按 B 截断，后续工具结果仍在日志里，新一轮从已结算历史继续。
- **D｜工具已派发未结算**：已有恢复（`Tool execution interrupted` 耐久失败，不重放副作用，
  `v2/session.md:50`）。本文不改。

## 5. 耐久标记（补 `llm.ts:122` 的缺口）

恢复决策要成为日志的纯函数，助手消息必须能表达"这是被中断的前缀"。提案：

- 在助手消息的耐久状态里增加 `interrupted` 终态（与 completed / failed 并列），由 drain
  死亡时的清理路径写入，或由下次恢复观察到"在飞 turn 无终态"时补写。
- `interrupted` 携带：已提交的 text/reasoning 前缀 + 一个固定说明块（如
  `Provider stream ended mid-turn; the partial answer above is complete as far as it went`），
  使渲染与后续请求组装都把它当合法历史。
- 该标记让 §4 的 B 分支成为纯函数：读到 `interrupted` 即知"前缀合法、不得重派发、需新一轮
  承认"。它与 `session.next.status` 的 `retrying` 相位互补：status 是进程态（不落库），
  `interrupted` 是消息终态（落库）。

## 6. 幂等不变式

- **计费**：一轮内的重试在 provider-retry 预算内；崩溃后的新一轮是新的计费事件，诚实且
  可接受，绝不重放同一 attempt。
- **发布**：部分前缀只提交一次；决策树保证已提交前缀的 turn 永不整轮重派发。
- **工具**：已结算工具永不重执行（结算先于子执行、且耐久）；未结算按 D 耐久失败。

## 7. 与相邻工作的边界

- **RUN-04（已 Done）**：属主工具半边的副作用中断；本文属主助手流半边的发布中断，二者在
  §4 C 分支交汇且互补，不重叠。
- **provider-retry**：属主 in-turn、首字节前；本文属主跨 drain、部分发布后。
- **状态词表（v2/session.md）**：本文新增的 `interrupted` 消息终态须登记进事件/状态词表，
  并与 `session.next.failed` 区分（截断不是失败，`v2/session.md:147` "Interruption is not a
  failure"）。
- **AGT-04 分工**：本文是 Goal/Todo 之外"turn 级"的恢复，不涉及任务状态分工。

## 8. 验收方向（后续）

设计对齐，不带验收。落地时以最小改动验证：构造"部分文本已提交后杀死进程"，恢复后历史是
诚实前缀（无重复、无重派发）（§4 B）；崩溃后新一轮能承认截断并继续；已结算工具不被重放
（§6）。真实隔离覆盖随 SEC-04。
