# S6：权限合一设计

状态：进行中。§3.1 第 ① 步（引擎规则模型与求值，#1499）和第 ② 步（产品 saved
permission 规则投影至引擎存储，#1546）均已合入 main。第 ③ 步删除 TS 判定路径尚未完成；
询问次数对齐与本文 §4 的验收仍需逐项核对，不能用第 ② 步合并代替。前置：S4 已落地。

## 1. 目的

`specs/rust-phase-2.md` §4 的 S6：引擎的 grant 表成为唯一存储，产品 `permission` 表变为投影；
TS 的判定路径删除。

## 2. 现状

- 引擎：`engine_permission_grant` 与 `engine_permission_request_scope`
  （`crates/miao-engine/src/permission_grant.rs:116`，判定在 `runtime.rs:4124`）。
- 产品：`permission` 表（`packages/core/src/permission/sql.ts:7`，服务
  `packages/core/src/permission/saved.ts:29`）。
- 后果（测绘结论）：引擎从不读产品表，所以 native Session 看不到项目级"always allow"，
  用户在同一条规则上要被问两遍。

## 3. 设计

1. **唯一写入者**：grant 与 scope 只写引擎库；产品的 `permission` 表由事件投影而来。
2. **判定的唯一位置**：允许/拒绝的决定只在引擎侧做（`runtime.rs` 的判定点），TS 不再有
   第二条判定路径；产品只渲染请求与展示结果。
3. **项目级规则**：项目级 "always allow" 作为 grant 的一条 scope 记入引擎库，随 Session 的
   Location 生效；这就是今天缺失的那条能力。
4. **迁移**：产品表现有行一次性导入引擎库（幂等，按 `(scope, rule)` 去重），导入后产品表只读。
5. **收紧**：S4 之后产品表可以整体删除；S6 只承诺"产品表不再是权威"。

### 3.1 实现前必须知道：grant 不是规则

引擎的 grant 是**精确调用**的摘要（`crates/miao-engine/src/permission_grant.rs:13-100`）：
`Scope` 由 `workspace + authority_revision + tool + resource + targets + input_hash` 求 SHA-256 得到，
`contains` 只做精确匹配。它回答的是"这一次调用是否已被批准"，不是"某条模式规则是否允许"。

产品的 saved permission 是**模式规则**（`packages/core/src/permission/sql.ts:7`），由 TS 的
policy 做优先级求值。两者不是同一种东西，所以 S6 不是"加一个导入 RPC 把产品表灌进 grant 表"：

- 精确 grant 无法表达 `bash:git *` 这类模式；导入时只能为历史调用逐个造 scope，对新调用无效。
- 真正缺的是"规则求值"进引擎：模式匹配、优先级（session > project > global）、allow/ask/deny
  三态与 deny 优先，以及 `authority_revision` 与 agent manifest 的绑定关系。
- 这一步是安全敏感的：判定语义出错等于悄悄放宽权限。因此 S6 的实施顺序应为
  ①引擎侧规则模型与求值（含与 TS 判定表的黄金样例对齐）→ ②把产品表投影为引擎规则 →
  ③删除 TS 判定路径。三者在同一个 PR 里做是不安全的。

本文原来的"grant 表成为唯一存储"仍然成立，但"唯一存储"存的是**规则**，而不是今天的精确 scope；
`engine_permission_grant` 继续作为"这次调用已批准"的缓存，二者并存。

### 3.2 保存规则的撤销同步

第②步的旧 `permission_saved_project` 只有追加导入语义，不能传达撤销。产品宿主改用
`permission_saved_snapshot`：`rules` 是该工作目录中产品保存的完整 allow 集合；空列表
清空旧投影。引擎先验证完整输入，再在一个事务中替换；输入错误或中途写入失败保留旧集合。
请求必须属于控制器所在 Runtime 的工作目录，路径先规范化，防止别名造成两份权限集合。
原有 additive 命令保留兼容用途；权威刷新使用新命令，旧引擎收到它会明确拒绝而非忽略撤销。

`--capabilities` 的 `saved_rules_snapshot: 1` 表示支持这项语义。产品的缓存发现、嵌入
二进制配对和受管理 native owner 要求此能力；仅支持追加的二进制不会被当作可用配对。
规则为零时也发送快照。新 owner 发布前再次读取保存表，复用 owner 的 prompt/resume
刷新在准入前读取同一项目的当前保存表；同步失败时该次准入失败，不沿用旧 allow 继续提交。

这项收口保留了精确 grant、模式规则和配置 deny 的区别，没有删除 TS 判定路径。
未经过刷新边界的活动 turn、完整权限事件投影及保存规则的原生写入权仍属于后续第③步；
不能把本快照修复声明为 S6 完整退役。引擎表当前由历史保存规则的投影使用；引入原生模式
规则写入者时，必须先区分来源，不能让旧产品快照覆盖新的原生权威规则。

## 4. 验收

- 同一组审批脚本（允许一次、always allow、项目级 allow、拒绝）在 native 与 TS Session 上
  产生相同的询问次数；
- 迁移后重复执行导入不产生重复 grant；
- 删除 TS 判定路径后，全量测试与 blackbox 通过。

## 5. 不做

- 不改规则的匹配语法与优先级。
- 不改 UI 的审批交互。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 迁移期间"问过又再问一次" | 导入在 Session 唤醒前完成；导入失败则拒绝启动该 Session |
| 项目级规则的作用域误用（跨项目生效） | scope 以 Location 为键，测试覆盖两个项目互不影响 |
| 删除 TS 判定后某些插件失去判定入口 | 插件走引擎的工具/权限 RPC；先在 S6 前补一个兼容层 |
