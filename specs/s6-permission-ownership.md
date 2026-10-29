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


## 7. 第③步的绑定规则查询前置

新增 `product_permission_evaluate` 将宿主声明的动作/资源与活跃的产品工具reverse call绑定。
Rust在派发时保存本turn的agent规则和policy revision；控制器只提交session、bridge、call、
message身份以及动作/资源事实，不提交configured/saved规则。查询校验连接、取消状态、
运行中run、dispatched工具和规范工作目录，随后用同目录保存规则求值；回复后、取消后、
工具已settle或跨身份的查询均拒绝。相同policy在不同workspace的authority revision不同。

该前置没有执行宿主动作，没有创建审批/grant，没有启用新的规则写入者，也没有删除TS判定。
它提供的是模式规则判定，不是可重放的执行许可；原生能力/plan边界与宿主取消仍须成立。
产品适配器启用前还依赖完整保存规则快照刷新（#1643）及配对能力门禁；不能在旧追加投影上
假装撤销已生效，也不能退回调用方任意提供规则的通用查询。

接下来的切片仍须分别完成：只展示原生判定的宿主适配器、绑定运行中子请求的持久审批、
有来源区分的原生模式规则写入/事件投影，再移除TS第二判定。既有planned工具审批的唯一索引
不能直接用于多个运行中宿主子请求；也不能放宽原有校验来绕过该边界。完整§4验收仍开放。

### 7.1 原生模式规则写入与来源边界

`permission_pattern_list/put/remove` 为Runtime规范workspace提供原生持久allow规则；
入参不允许选择workspace/source，ID绑定workspace及内容，重复put保持ID和创建时间，
跨workspace的ID不能撤销同内容的另一条规则。原生行与宿主投影分别存储，求值时合并，
configured deny仍先于两类saved allow。SQLite插入约束覆盖两种来源的合并规则预算，失败回滚该写入；满额重复投影仍幂等。

这只是原生规则写入前置。绑定pending子请求的always答复、原生变更事件的产品投影、
完整快照刷新配对验收（#1643）、宿主第二判定删除及§4询问次数验收仍未完成。
不能因为原生表已有写入API而把产品表当成已切换为只读投影。

### 7.2 宿主子请求的原生持久化前置

`product_permission_requests: 1` 为活跃产品工具提供 admit/status/reply/pending RPC。
每次不同断言用独立 request ID；相同 ID 只接受完整输入与来源完全匹配的重试。
记录绑定 Runtime owner、规范 workspace、Session、bridge、源工具、message、输入摘要
及捕获的 authority revision。桥连接和源槽位锁覆盖 SQL 提交；源工具结束、取消和
崩溃恢复会在同一事务清理 pending，不能借旧回复写入 always 规则。

always 仅保存调用方明确声明的 save 模式，和单次答复一起原子提交；空 save 不记忆。
答复前重新检查当前 saved deny；模式写入失败整体回滚。它不制造精确 grant，
也不执行宿主动作。宿主仍须遵守取消信号及原生能力边界。

这一切片尚未启用产品兼容适配器，也未实现产品事件投影
或删除 TS evaluator。必须继续完成这些门禁并通过 §4 验收，不能将前置能力当成 S6 完成。

### 7.3 已在等待的其他子请求

reject 在同一事务拒绝当前 Session 已 pending 的其他断言，不波及其他 Session 或后续新请求。
always 只在当前请求获准且明确保存模式时，重新求值同 Runtime、同规范 workspace 的既有
pending（可跨 Session）；逐一绑定其活跃来源与该 turn 捕获的 agent 规则，仅放行 allow。
新选择的 agent 不替换既有来源捕获的规则，配置 deny 仍不能被别的 Session 的保存规则覆盖。

模式、当前回复、其他 pending 的结算及事件一起提交；任一写入故障整体回滚。已经结算的
精确回复重试不再扫描新请求，也不恢复后来撤销的规则。该后端行为仍须与兼容适配器、
拒绝反馈的产品消费及 UI 事件投影配对验收，不能据此声明第二 TS 判定已经退役。

### 7.4 拒绝时的纠正反馈

`product_permission_replies: 1` 明确标识同级回复语义和可选 message。非空拒绝消息作为
feedback 保存到当前请求与结算事件，reason 为 user_corrected；同一拒绝清理的其他请求
仍为 user_rejected，不复制纠正内容。空拒绝消息与普通拒绝一致，once/always 的 message
不参与语义。反馈限制 4096 UTF-8 字节且不接受 NUL；非法反馈不结算请求。

精确回复重试还须匹配规范化后的纠正消息，不能借重试修改历史反馈。缺少 feedback 的旧记录
按无反馈读取，无反馈时不输出该字段。产品必须协商能力后才发送带 message 的回复；
仍待兼容适配器消费、事件投影、自动分类模式核对及 §4 完整问询次数验收。

### 7.5 宿主 auto 模式

原生子请求准入捕获派发 turn 的 agent auto 标志；切换 agent/mode 不追溯改变活跃来源。
configured deny 不进入分类器；仅将 edit/bash 中可证明安全的 ask 改为 allow，记录
reason=auto_allowed，不保存模式规则或精确 grant。stdin 字段存在（包括 null）时 bash
仍需询问；未知动作/操作继续 ask，Windows bash 不自动放行。

产品工具 manifest 的 host_context 携带 Location 路径拼写及宿主 cwd，directory 须规范化为
同一原生 Location，cwd 若存在须为绝对路径。它在启动时校验、每个来源捕获，不能由单次请求
覆盖。规则仍匹配原资源，分类才按宿主 cwd 作词法解析；根目录自身、越界路径及敏感路径
不自动放行。原始/解析后敏感路径均保守检查，不替代实际执行器的文件系统与能力上限。

product_permission_auto:1 为单独门禁，准入 authority hash 绑定模式及路径上下文；rule-only
查询不等于完整准入。仍须用真实 TS 分类器对照自动/手动模式、相对路径与 stdin，再完成
产品适配、事件投影和 §4 总体验收，不能将后端能力当成 TS 判定已退役。

### 7.6 单个断言等待的撤销

`product_permission_cancel: 1` 提供绑定活跃 source 与 request_id 的撤销命令，供宿主等待被
中断时清理自己的断言。仅将本条 pending 结算为 cancelled/caller_cancelled，不应用用户
reject 对同 Session 已等待请求的清扫语义，不保存模式或 grant；记录与事件同事务提交。
重复撤销不重复发事件，已结算记录保持原结果，过期记录保持 expired。旧 always 回复不能
重新批准已撤销请求，外来/失活来源不能撤销。这只是兼容适配器的中断清理前置，尚未启用
该适配器，也不代表 §4 的询问次数与取消验收已完成。

### 7.7 拒绝决定的历史证据

`product_permission_diagnostics: 1` 为 policy_denied 记录保存实际 Rust 判定的 denial：
effect、有效规则及该次判定的 authority_revision。准入拒绝保存准入时的结果；答复时重查
产生拒绝则保存重查结果，同时保留原准入绑定供精确重试。随后规则变化不改写历史证据。
用户拒绝、取消或允许不伪造 policy denial，缺少该字段的旧行按证据未知读取。未来适配器
须消费原生证据，不能用较晚的 TS 规则重新解释历史拒绝；本项尚未启用适配器。

### 7.8 Location 内的活跃调用路由

Core 的 PermissionSource 保存 Location 内的活跃 `(Session, message, call)` 绑定，不向工具
注册表加入鉴权回调，也不建立 Session-ID layer。内建及插件工具仍捕获同一个 Permission
服务；启用原生路由后，服务按实际 placement 将 native 断言交给绑定的原生适配器。独立
插件 Promise 不依赖 Effect 上下文传播来找来源。TS-owned Session 保留原决策行为。

启用状态在该 Location 内只会收紧；绑定释放、重复登记或来源缺失不能恢复成 TS 授权。
宿主接线要求完整快照及原生请求/回复/撤销/诊断/auto 能力，且回调必须有实际 message
身份与取消信号。该接线依赖完整快照、回调取消和宿主路由前置改动，不用版本号猜能力。
位置级待审批列表从 placement 定位引擎并查询原生记录，回复前再次核对所属 Session。

本切片仍不代表 S6 完成：原生 standing-rule 的产品投影、撤销入口和 §4 脚本验收尚待完成；
兼容阶段也不能据此声明所有 TS 判定路径已经退役。

### 7.9 原生持续规则的产品查询与撤销

saved-permission API 合并旧产品规则与当前目录引擎的原生模式规则。原生行使用独立
psv_native_ 标识，并携带 origin=native、规范目录 scope；查询其他 project 不把当前目录
规则伪装成该 project 的授权。产品只投影查询结果，不把原生行写回旧表，所以旧快照导入
不会重复导入原生规则或改变合并规则预算。

撤销根据当前目录的引擎重新查询绑定后调用 permission_pattern_remove，不信任客户端
提供的工作目录或原生 ID。重复撤销幂等，不会撤销另一目录的规则；旧产品规则保持独立。
不能控制原生规则的 TS 模式返回明确 Conflict，而不是假装撤销成功。该切片提供 API 和
生成 SDK 的投影/撤销能力；管理界面、事件驱动的持久投影与完整 S6 验收仍待收口。

### 7.10 Native placement 的判定切换

Core 的 ask/assert 每次先读取 Session 的持久 placement。Native Session 从第一次权限调用
起必须有当前工具的来源绑定；没有绑定、来源缺失、能力不足而未能接线、绑定释放后，均失败
关闭，不再以 Location 是否曾启用路由作为退回 TS 判定的条件。Location 服务只保存当前绑定，
没有可恢复旧判定的模式开关。TS-owned Session 保留原有判定，供兼容与对照验收。

此切片只移除 Native ask/assert 的第二判定路径；旧产品保存规则的导入/持久投影退役、
Native 权限 profile 诊断及 §4 的完整脚本验收仍须分别完成。能力缺失不能制造 Native 授权。

### 7.11 原生持续规则的持久变更记录

`permission_pattern_changes:1` 提供规范目录绑定的原子快照与持久游标分页。原生 put、
撤销及 always 保存规则时，把 upsert/remove 记录与规则写在同一事务；内容重试、
重复/跨目录撤销不增加记录，日志失败回滚授权变更。快照在同一读事务取得规则和游标，
涵盖日志引入前已有规则；产品须从快照建立投影，再按游标消费后续变化，不能从空日志
推断旧规则不存在。分页严格限制大小，作用域及损坏记录校验失败不返回半页投影。

这只是持久投影的原生前置，未把旧产品 permission 表变成只读副本，也未退出旧导入。
产品投影事务/游标提交、来源隔离、重连同步及旧规则一次性迁移仍需继续实现与验收。

### 7.12 产品侧原生规则只读副本

支持变更游标的引擎在每个新 transport 首次查询时重新取得原子快照，覆盖持久副本及游标；
空快照也覆盖旧行。后续查询和撤销确认后按顺序重放变更，副本与游标同事务提交；陈旧游标
或不一致分页重新同步快照，SQL 失败回滚整次更新。并发查询按 owner 串行，持续变更超过
有界分页工作量后改用新快照。存储、Location 目录及 workspace 身份隔离副本。

副本使用独立表，权限判定不读取它，旧 permission 导入也不读取它。没有变更游标能力的
兼容引擎继续直接读取原生列表。此实现收口持久投影与重连同步，不代表旧规则导入已退出，
也不代表原生 profile 诊断、跨作用域完整迁移或 S6 总体验收已经完成。
