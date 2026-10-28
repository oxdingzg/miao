# COST-01 验收记录：真实账单与每次尝试归因

适用版本：main `22de1a0a5`（2026-10-28）。逐条证据以该树为准；实现 PR 表见文末。

## 验收 1：缺失维度保留未知 — 可勾

- 归一化只复制命中的轴：`crates/miao-engine/src/usage.rs:29-43`（observed()），缺失轴不建键；`insert()` 仅 `Option::Some` 写入（usage.rs:127-131）。
- 各 provider 注释与实现明确保持未知：anthropic reasoningTokens（usage.rs:165-167）、bedrock:137、chat:193、responses:217、gemini:242；cache lineage 缺席轴缺席（usage.rs:267-292，"never read as a zero-cache hit"）。
- 汇总 coverage=0 → Null（usage.rs:71-91）；store merge 缺席轴不建键（store.rs:2532+）。
- 测试钉住：tests/usage.rs:16（anthropic reasoning is_none）、:83-95（responses 缺失 is_none、显式 0 保留）、usage.rs:311、auxiliary_usage.rs:68-84（unknown ≠ measured zero）、auxiliary_usage.rs:40/46（partial 计入 missing）；本轮补充断言钉住 providerDetail[0].observedUsage 的缺席轴语义（cacheRead 在场、cacheWrite/reasoning 缺席）。

## 验收 2：主/子代理/辅助/失败重试分别归因并可汇总 — 可勾

- 主代理：per-step usage 带 run_id/step/model（runtime.rs:2089-2090），run.usage 按 run 汇总（store.rs:3492-3496；tests/run_usage.rs:55-124）。
- 子代理：独立子 session（runtime.rs:4012），父链原子汇总 applyUsageWithAncestors（usage-store.ts:94-113，重放恰好一次测试 session-usage-store.test.ts:152-198）；subagent_start 带 agent 名（runtime.rs:4051-4053）；子会话 usage_report（runtime.rs:4206）。
- 辅助角色：role.provider.started/completed 带 role/path/accepted/identity 与三态计数（store.rs:3252-3268；tests/auxiliary_usage.rs:5-64）。
- 失败重试：provider.retry 持久事实带 attempt/reason/status/delay_ms（runtime.rs:1864-1869、provider.rs:1138；bridge.ts:581-599 translateRetried 带 attempt）；失败路径 partial usage（runtime.rs:1946/1980，partial:true）；partialTurns 入账（usage_lineage.rs:79、auxiliary_usage.rs:46）；retry.test.ts:16-38 单测 + 45-101 端到端（durable+重放）。
- 汇总面：usage_report（store.rs:3196，host.rs:238）；SessionUsageStore.summary 按模型汇总（usage-store.ts:247+，测试 340-378）。

## 验收 3：模型/时间/价格来源；历史价格不被重写 — 可勾

- 模型：usage 事件带 model；provider.started identity 按 run+step 记录（usage_lineage.rs:22-28、87-90）；step.ended 模型由已记录 identity 解析（session.ts:423-432）。
- 时间：session_turn_usage.time_created/ttft（usage-store.ts:141-158）；turnsDetail turnMs/ttftMs（usage_lineage.rs:100）；辅助 durationMs。
- 价格来源：ProductRoutes.prepare → prices → locationPricing（native-engine.ts:1050-1051、1084、1234，注释 "Journal replays price with the same catalog the live connection got"）；结算时按 catalog 计（bridge.ts:389-441）。
- 不被重写：session_turn_usage 以 event_id 为主键 onConflictDoNothing（usage-store.ts:141-165、sql.ts:229）→ 重放至多一次，已落库成本冻结；engine-translator.test.ts:92-160 钉住重放定价身份（跨 run/step 不得借用、未记录 identity → cost 0）。
- 备注（计费惯例，非缺陷）：store.rs 主回合 detail 的 usage 块为逐回合计价便利以 0 填充缺失轴（store.rs ~3355-3366），同 row 另有 observedUsage 保留缺席；bridge.ts translateUsage `?? 0` 同理（未知 cache 折扣按 0 记，保守）。

## 验收 4：关联实现 PR

#667（canonical provider usage）、#842（TTFT+cache lineage）、#957（Responses cache writes）、#973（auxiliary usage+coverage）、#539（run.usage 汇总）、#915（native usage+catalog 定价）、#1166（native steps 定价）、#288（session_turn_usage/session_tool_usage 事实表）、#1319（祖先链原子汇总）、#1294（delivery path 定价与持久化）、#1408（分页历史）、#1092/#1097（Bedrock/actor）。

## 记录在案的缺口（不阻断验收）

1. 操作员/报告层 recall 不区分 observedUsage 与 0 填充块（本记录已注明语义）。
2. 真实供应商账单对账（外部条件）：需真实费用预算后抽样对账，属 VAL 线。

## 本轮测试

- macmini：`cargo test --test auxiliary_usage` 2/2（含新增缺席轴断言）；`cargo fmt` 干净。
