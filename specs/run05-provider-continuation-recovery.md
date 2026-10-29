# RUN-05：provider 续跑歧义的恢复设计

状态：设计草案；运行时实现与验收尚未完成。本文界定"一个 provider turn 在部分耐久发布之后中断"这一
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

- **A｜没有耐久助手输出**：不能直接推出 provider 未收到请求、未计费或未执行托管动作。
  只有新协议下存在明确的 `prepared` 记录、且尚未进入 `dispatched`，才可判定该 attempt
  尚未派发。已有 `dispatched` 标记但无输出，以及缺少新标记的历史数据，都按派发结果未知
  处理；默认等待显式恢复，不把它们等同于首字节前的进程内重试。若以后允许自动重派发，
  必须由明确的恢复策略授权，并在派发前耐久扣减重试预算；供应商托管动作或未结算工具的
  副作用不确定时不自动重放。新的 attempt 仍可能再次计费。
- **B｜有助手部分输出、无已结算工具调用**（歧义核心）：provider 不能半流续。先把已经
  提交的前缀诚实标记为 `interrupted`，修复未闭合的内容块，保留原事件身份，不重新提交
  前缀。显式恢复获准后才以新一轮继续，并告知模型被截断；这不是恢复同一次供应商请求，
  也不保证供应商计费恰好一次。
- **C｜有已结算工具调用**：只使用已提交的结算结果作为继续点，不重新执行工具。助手消息
  仍按 B 处理，组装请求前重新载入历史；不得制造悬空 tool-call/result 对。
- **D｜工具已派发未结算**：沿用 RUN-04 的诚实中断和不重放副作用规则。不能因没有工具
  结果就推断工具从未执行。

上述恢复必须确认旧的本地执行已终止，并遵守 Session 的进程内串行协调。普通 advisory
wake 仍只处理合格的耐久 inbox 输入，不借恢复设计扩大成旧 provider 工作的自动扫描器。
恢复不创建耐久 drain 身份，也不把恢复伪装成新用户 prompt 来重置 agent 的轮次 allowance。

## 5. 耐久标记（补 `llm.ts:122` 的缺口）

恢复判断首先需要版本化的 provider-attempt 记录：新 attempt 先耐久写入 `prepared`，
调用 `llm.stream` 前写入 `dispatched`，并保存对应助手消息、attempt 序号与历史边界。
没有该版本化记录的旧数据属于未知状态，不可用“缺少标记”证明未派发。

恢复决定也需以 `(Session, assistant message, attempt)` 为幂等键耐久记录，绑定截断边界、
后续消息身份和已消费预算。重复观察同一边界不得再追加中断说明或重复调度继续；在“决定
已提交、后续尚未派发”等崩溃窗口中重用该决定。恢复不会补充 provider 重试预算；新一轮
仍需重新解析当前 Location 的配置、历史和权限上限，不能复用旧进程的内存权限。

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

- **计费**：一轮内重试与跨崩溃恢复的预算分别明示并耐久计数，不能因进程重启重新获得预算。
  没有供应商幂等/查询凭据时，不承诺计费恰好一次；显式恢复的新 attempt 可能再次计费。
- **发布**：部分前缀只提交一次；决策树保证已提交前缀的 turn 永不整轮重派发。
- **工具**：工具执行与副作用发生在结果结算之前；只能信任已经提交的结算结果。已结算
  工具不重执行，未结算按 D 处理，不能把“尚未结算”当作安全重试证据。

## 7. 与相邻工作的边界

- **RUN-04（已 Done）**：属主工具半边的副作用中断；本文属主助手流半边的发布中断，二者在
  §4 C 分支交汇且互补，不重叠。
- **provider-retry**：属主 in-turn、首字节前；本文属主跨 drain、部分发布后。
- **状态词表（v2/session.md）**：本文新增的 `interrupted` 消息终态须登记进事件/状态词表，
  并与 `session.next.failed` 区分（截断不是失败，`v2/session.md:147` "Interruption is not a
  failure"）。
- **AGT-04 分工**：本文是 Goal/Todo 之外"turn 级"的恢复，不涉及任务状态分工。

### 7.1 真正消费方与可见状态

| 消费方 | 读取的权威信息与允许动作 |
|---|---|
| Session 执行服务 | 从持久放置进入当前 Location，重新加载历史、预算和恢复决定；在串行协调内登记唯一后续 attempt，再调用一次 provider。 |
| 服务端显式恢复入口 | 校验客户端所见的助手消息、attempt 和历史/inbox 边界，返回可恢复、需确认或已失效；旧边界不能作用于新输入。 |
| 终端恢复界面 | 仅显示服务端投影的中断边界、预算和派发结果未知提示；用户选择继续时提交该边界，界面不重建恢复权威。 |

现有 `dialog-recovery.tsx` 只消费工具恢复记录；未来 provider 恢复须使用明确区分的报告，
不得把 provider attempt 填成一个可重试工具调用。`pending-prompts.ts` 和 `prompt-send.ts`
只处理 prompt admission 的本地显示/传输回执；重发相同 prompt ID 与恢复 provider 工作是
两件事，不能根据 sending/failed 状态触发 provider 重派发。

投影中的 `interrupted` 表示该 turn 没有耐久完成证明，未必意味着供应商没有完成或计费。
恢复入口应给出这个事实及剩余预算；并发到达的新输入使旧恢复边界失效时，客户端刷新报告，
而不是换一个 prompt ID 规避冲突。真正的新用户输入仍遵守原有 admission 与 allowance 规则。

## 8. 验收方向（后续）

设计对齐，不带验收。落地时以最小改动验证：构造"部分文本已提交后杀死进程"，恢复后历史是
诚实前缀（无重复、无重派发）（§4 B）；崩溃后新一轮能承认截断并继续；已结算工具不被重放
（§6）。另覆盖：派发标记前后分别杀进程、无输出但已派发、旧数据无标记、托管动作
结果未知，以及“截断/恢复决定已提交、后续尚未派发”时再次崩溃。重复恢复不增加标记、
不重置预算、不重复调度；普通 wake 不触发旧 provider 重试。真实隔离覆盖随 SEC-04。
