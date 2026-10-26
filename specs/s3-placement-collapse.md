# S3：placement 收口设计

状态：设计稿，2026-10-26。前置：S2（单一 durable inbox）落地之后。

## 1. 目的

`specs/rust-phase-2.md` §4 的 S3 是"新 Session 一律 `rust`；TS placement 退化为显式环境变量的
应急回滚"。S3 之后 Phase 3（TUI 重写）才有意义，因为会话状态只有一个属主。

## 2. 现状

- 属主目录：`session_engine_placement` 表（`packages/core/src/session/engine-placement.sql.ts:8`），
  `engine` 只有 `'ts' | 'rust'` 两个取值，并有 check 约束保证 `rust` 行必须带
  `native_storage` 与 `location`（`:17-24`）。
- 判定：`routing.ts:37` 的 `route()` 把 `placed` 解析成 `native` 或 `ts`；`resolve()`
  （`routing.ts:52`）把 durable 目录当作唯一权威，Rust Session 不会被 TS 元数据"复活"。
- 现状的默认：新 Session 的 `engine` 由产品决定，取决于启动开关；两种 placement 都有生产语料。

## 3. 设计

1. **默认单一**：新 Session 的 `engine` 恒为 `'rust'`。选择点收敛到一处（建行的地方），
   不再分散到调用方。
2. **回滚开关**：一个环境变量把默认改回 `'ts'`，用于发布后应急；开关只影响"新建行"，
   已有行不改写。回滚不是"迁移"，所以不需要数据脚本。
3. **表结构不变**：`'ts'` 仍合法，S4 之后才考虑收紧 check。S3 不改 schema，避免与 S4 的
   迁移窗口重叠。
4. **迁移既有 Session 不属于 S3**：`engine='ts'` 的旧行保持 `ts`，直到 S4 的存储迁移
   把它们纳入。S3 只承诺"新 Session 只有一个属主"。

## 4. 验收

- 关掉回滚开关（即强制 `rust`）跑全量测试与 blackbox，全部通过；
- 回滚开关本身有测试：打开后新建 Session 的 `engine` 为 `ts`，且 S2 的 inbox 行为不变；
- `routing.route()` 的两种结果都仍被覆盖（S3 不删除 TS 分支）。

## 5. 不做

- 不删除 TS placement 的代码路径（S4 之后）。
- 不合并存储文件（S4）。
- 不改 `routing.resolve()` 的权威顺序（S2 之后它已经是权威）。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 某个只在 TS placement 下验证过的功能在 `rust` 上回归 | 先在 CI 里用"强制 rust"跑一遍全量，再改默认 |
| 回滚开关被长期打开，等于没做 S3 | 开关记录在启动日志与诊断里；发版检查项列出"未打开" |
