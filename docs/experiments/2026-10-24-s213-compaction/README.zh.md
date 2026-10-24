# 2026-10-24 §2.13 1M 窗口真实 compaction 实测（验收：未通过——压缩从未触发，实际是 elision）

所有者授权的 §2.13 实测：模型 `zhipuai-coding-plan/glm-5.3-flash`（目录标称 context = 1,000,000），run 路径（`MIAO_ENGINE_STORAGE` 原生放置），通过 `--continue` 链把 6 段 × ~600KB（≈150k token/段）的用户提示注入同一会话，目标跨越真实 compaction 触发点。魔咒标记分置于第 1/3/5/6 段中点，压缩后无工具回忆中段两条作为验收断言。

## 结果：验收未通过，但发现了更有价值的事实

1. **真实 compaction 从未触发**：填到 ~450k token（chunk3 的请求 input=160,573）时，`engine_compaction` 表 **0 行**——引擎在默认预算下的行为是 **elision（把有效窗口省略/截断到 ~160k token）**，而不是 summary-compaction。后续 verify 轮 input 159,712 与之同源。
2. **1M 窗口在 run 路径上是虚构的**：目录标称 1M，但引擎的有效窗口 ≈160k——预算既不来自模型 limit，compaction 设置（`MIAO_CONFIG_DIR` 下 `compaction.threshold=300000` 已验证能被 `compactionSettings` 正确解码）也没有到达引擎。根因与计价 $0 同源：**run 路径没有组合 NativeEngine layer**（issue #1285）。
3. **elision 的行为边界**：压缩后无工具回忆中段两条魔咒（`f03`/`f09` 等价物）失败——被省略的 prompt 中段内容无法恢复（restore note 指向文件，但内容埋在 prompt 里，无文件可重读）。会话本身稳定续跑（无崩溃、无重复消息）。
4. 填充方式本身的发现：read 工具负载**不会**触发压缩——引擎对 read 结果主动 elision（3.7MB 读取后 input 峰值仅 46k，见第一轮），只有 user prompt 体量才能推高上下文。

## 证据

- `input-curve.csv`：v6 四段 + verify 的逐请求 input token（chunk3: 160,573；verify: 159,712）。
- `engine_compaction.rows0.txt`：run 后引擎库 `engine_compaction` 表行数 = 0。
- `codes2.txt`/`codes3.txt`：两轮全部魔咒标准答案；v6 verify 回答中不含任何魔咒值（recall 失败的正面记录）。

## 复测条件（修复后）

#1285 落地（run 路径组合 NativeEngine layer）后重跑本验收，并预期：compaction 设置（threshold）与模型 limit（1M）到达引擎；`engine_compaction` 出现真实行；压缩后 restore note（#1280）注入；跨压缩记忆按 summary/重读策略验证。

## Post-#1302 final acceptance (2026-10-24)

#1302 合入后在本目录复测（工作树基于 ebaf9efffa；引擎进程探针确认带 `--context-limits {"window":1000000,"ratio":0.9,"headroom":62048,"perPass":8}`，预算派生修复确实到达了引擎）。复测结论：**BLOCKED——压缩仍未触发（`engine_compaction` 0 行），且本轮发现了比网关更根本的阻断：引擎 store 层的 2 MiB 快照/分叉投影上限，使 1M 窗口的压缩触发点在架构上不可达。**

### 复测执行记录

填充链路：6 段 × 602,360 字节（≈150k token）的 user prompt，经 `--continue` 链注入同一会话（`ses_gfe5e94c8e4baffezme3Vsz0du`，存储 `/tmp/s213-storage7`）。

| 请求                             | input token     | 结果                                                                                                                                            |
| -------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| chunk 1                          | 161,012         | step_finish，正常返回                                                                                                                           |
| chunk 2                          | （日志丢失）    | 用户消息已持久化（seq 21，602,391 字节）；存储中无对应 assistant 回复                                                                           |
| chunk 3                          | 463,664         | 网关报错 1 次：`{"reason":"MalformedResponse","name":"ClientError"}`；批次内重试成功，step_finish                                               |
| chunk 4（sweep）                 | —               | 用户消息已持久化（seq 45，606,791 字节）后引擎拒绝：`ConflictError: projection exceeds snapshot/fork limit`，sweep exit 1，未发出 provider 请求 |
| chunk 4 诊断探针（`--continue`） | 46,438 / 50,278 | 误续到陈旧会话（见下节），与链路无关                                                                                                            |
| chunk 4 重试（`--session`）      | —               | TS 侧报 `Session not found`（SDK 吞掉了引擎对快照读取的 4xx）                                                                                   |
| 无重读回忆 verify                | 未执行          | 会话不可恢复，无法到达该轮                                                                                                                      |

`engine_compaction` 终值：**0 行**（全部尝试之后）。MAGIC-MID-1/2 的无重读回忆因 verify 无法执行而无判定。

### 根因：2 MiB 快照/分叉投影上限

- `crates/miao-engine/src/store.rs` 的 `projected()` 硬编码：投影消息累计字节 > 2 MiB（2×1024×1024）或 ≥1000 条即返回 `Error::Invalid("projection exceeds snapshot/fork limit")`。
- `snapshot()`（store.rs:1023，"one read transaction captures a replay cursor and its projections"）是引擎读取/续跑会话的路径；`fork`（store.rs:1145）走同一投影。
- 链路会话 6 条消息共 **2,419,737 字节 > 2,097,152**（seq 5/15/21/30/39/45 = 601,060 / 2,207 / 602,391 / 605,371 / 1,917 / 606,791）。chunk 4 的 prompt 先被 durable admission 持久化、再投影，投影越限被拒——会话自此永久无法快照/续跑/分叉。
- 推论：本引擎下 prompt 填充可持续的上限 ≈ 2 MiB 消息体（该模型计价约 46 万-50 万 token；实测推到 463,664），而 1M 窗口压缩触发点（window=1,000,000、ratio=0.9、headroom=62,048，量级 ~84 万 token ≈ 3.4 MB prompt 字节）在到达之前就会撞上快照上限。**压缩在该路径上永远不会触发**，与 #1302 的预算修复正交。

### 运维发现：`--continue` 会话选择不可靠

复测诊断时 `--continue` 解析到 2026-10-23 的陈旧会话（`ses_gfe5e9663876dffexbeZZ7uFIM`，placement 指向旧存储 `/tmp/s213-storage3`，input 46,438→50,278），而非目录内最新的链路会话（`run.ts` 从 `sessions.list({order:"desc",limit:50,directory})` 取第一个非子会话；其排序合并路径未逐层核实）。恢复链路必须显式 `--session`，也正是显式续链暴露了上面的 2 MiB 阻断。

### 结论与复测条件

验收结论：**BLOCKED**（非 PASS/PARTIAL：压缩未触发、中段记忆无从验证，执行被引擎硬限制阻止，与网关/模型无关）。复测条件：解除或将 `projected()` 的 2 MiB/1000 条投影上限改为可配置（或 admission 侧分段），保留 #1302 的预算派生，然后重跑 6 段填充与无重读回忆。
