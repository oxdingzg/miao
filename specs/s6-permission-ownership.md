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

### 7.13 原生请求的权限诊断快照

原生 provider 请求及前缀摘要的 profile 在 provider 边界读取实际保存规则（旧投影与原生规则）、
规范 workspace、捕获的 agent policy 和执行能力边界。permissionHash 包含这些快照内容；
原生规则增加或撤销会改变相应请求的哈希，恢复同一权限内容时哈希也恢复。策略描述显式
记录 default/auto 模式。诊断快照不参与授权，活跃 turn 内的每个断言仍取得当时的原生判定；
它不宣称整个 turn 的可变规则被冻结，也不替代断言自己的 authority_revision 证据。

本地取消和匹配当前 run 的条件取消，先同步撤回 product bridge 来源，再回复接受。
撤回与授权提交使用同一来源锁：已经进入的提交可以在取消回复前完成，但不能在回复后
继续落盘。宿主取消通知由 Session actor 持有的任务发送，输出背压不推迟来源撤回；detach
等待通知，全局 shutdown 可中止其发送。过期 run 的条件取消保持当前来源不变。跨进程的
`run.cancel_requested` 仍是提交给归属进程消费的意图，不据此宣称远端已经停机。

### 真实执行归属的权限来源栅栏

Session 库 schema 22 在创建原生 run 时持久记录启动它的 Session lease epoch；首次
输入提升与 run 创建仍同事务。权限读取、准入及答复同时检查真实 dispatched 工具、
running run、Location，以及该 epoch 和当前进程的租约归属。新 epoch 接管后，旧来源
不能继续批准 always；同 epoch 续租仍有效。历史和未加栅栏的存储行保留 NULL，不从当前
租约猜测旧执行来源，也不触发 provider 恢复。旧内核拒绝打开 schema 22。
格式升级与 schema 变更同一 SQLite 写事务；已记录的旧 run 所属进程仍活着时拒绝升级，
保留旧 schema/数据供旧会话完成。Windows 使用只读进程句柄区分活跃与已退出进程。

这先修复现有本地权限来源的归属校验；共享项目库内的 pending/always 原子结算与事件
投影尚未接线，不能把这个局部修复当成共享权限权威已启用。

显式宿主驱动 `handoffNativeProjectPermissions` 会先检查项目管理/目标绑定交接能力，
解析真实原生快照并核对项目，然后依次 prepare、带目标身份的 handoff 和 complete。
原生已有其他输入的回执时，在冻结旧库前拒绝；Core 已确认完成但原生回执丢失时，也不能
重新导入旧规则。原生提交后响应丢失或 Core 保存回执失败，只保留 prepared 边界；使用
新连接重试仍交给原生原始输入凭据核对，不复活已撤销行。不同目标库和并发宿主均通过
实际控制进程测试。这个驱动没有注册到模型工具、启动迁移或 Runtime 授权路径。

目录目的端增加 `context_handoff {authority,patterns}`：在目录写事务内核对项目库持久
身份，第一次导入与原回执重试都必须匹配。原 `prule_` ID、时间及撤销语义不变；不匹配时
目录和项目状态均不修改。交接方须在冻结来源前检查对应能力，并绑定启动时确定的项目、
目录及显式 workspace 身份；同一路径换成另一座库不能继续旧交接。本 API 尚不冻结旧
目录来源，也不启用 Runtime 授权或自动迁移。


Session schema 23 在格式事务内将旧项目投影和目录原生规则表改为 `_legacy` 名称，保留
规则身份、时间、迁移原始凭据、撤销和变更游标。旧 SQL 名称失效，旧内核重新打开时拒绝
新版格式；活跃旧 run 的归属进程仍阻止升级。新只读 catalog 可查看旧格式，当前格式缺表
或新旧名称并存时不回退。这个格式边界本身还不是目录来源冻结或 Shared Runtime 激活。

显式来源控制 `permission-source --db PATH --project ID --directory PATH` 只打开已有的
Native Session 库，不初始化 provider、Session 执行或后台迁移。隐式本地目录先规范化，
项目及目录在进程启动时绑定。`prepare {authority}` 要求目录内没有活跃或归属不明的 run，
在来源事务内保存原始原生规则、目标持久身份及目的端指纹，并冻结旧读写、投影与变更流。
SQL 保护同时约束旧直接写入、规则跨范围移动及新 legacy model run；持久输入准入与执行
仍分开，冻结期间输入可保留 pending，不提升消息或调用 provider。其他目录不受该范围冻结。

目的端使用 `context_handoff` 接收同一原始输入；来源 `complete {snapshot}` 核对真实目的端
身份、项目、目录、workspace、迁移指纹及原始数量，不能以当前剩余规则数代替原始回执。
目的端提交后响应丢失、来源保存失败或重启，均保留 prepared 与旧来源冻结；精确重试接纳
目的端已存在的原始回执，不恢复已撤销规则。完成也不解冻旧来源。Shared Runtime 的权限
pending/always 原子结算与产品自动交接仍是后续接线，不把本控制入口当成 Runtime 激活。

宿主显式驱动 `handoffNativeDirectoryPermissions` 在冻结前检查配对能力，并读取两个真实
控制进程的项目/目录绑定。来源 `binding` 可在尚无迁移记录时提供身份，避免选错目的端就
冻结错误目录。随后核对原始目标身份、执行 prepare、带目标身份的 context_handoff，再将
实际目的端快照交给来源 complete；所有返回值都解析并核对。已有目的端回执却没有来源
记录、已完成来源对应的目的端回执丢失、目标库替换或范围不匹配时拒绝重新导入。两端响应
丢失后的重试保留撤销结果。驱动仅供可信宿主显式调用，尚未挂入 Runtime 自动启动路径。


### 共享规则变更流

MIAP 独立权限库 schema v3 用 revision 触发器在规则/迁移事务内追加不可改写的变更日志。
升级保留 Root UUID、规则、revision、迁移回执和撤销记录；已打开的 v2 连接继续通过原来的
revision 更新产生同事务事件，不能因旧写入者仍存活而漏记。升级前历史由初始快照承载，
不伪造 Session 事件或补写历史变更。

model-free 控制入口增加 observe/changes 与 context_observe/context_changes。observe
在同一读事务返回快照及 Root UUID + 独立 seq 游标；项目订阅按绑定项目过滤，目录订阅
只接受项目规则和绑定目录/workspace 的变更。分页完成后推进至该次 Root 水位，避免其他
项目的更新令空页游标停滞；错误 Root、超前游标和不合法页大小均拒绝。变更只提示重新读取
权威快照，不等同于权限许可，也不替代实际执行来源核验。

这一步仍未迁移 pending/always 到共享事务，未接入跨进程 pending 重求值，没有放开冻结
来源执行或自动交接。后续必须继续完成这些接线及同脚本询问次数验收。
权限事务先等待 OS/SQLite 写锁，再持有 product 与 bridge 来源锁至提交。普通本地取消可在
存储等待阶段撤回来源；已进入授权临界区的提交仍先于取消确认完成。带 run ID 的条件取消
继续核验当前 durable run，不将过期 UI 观察当成取消当前来源的权限。这个锁顺序也约束后续
共享库附加 Session 来源事务，避免来源锁与数据库锁互相等待。

可信 Rust 宿主可从实际 Runtime product call 捕获不透明来源 handle，再通过共享
Authority 的 `with_permission_source` 执行共享库操作。handle 不接受控制帧提供的数据库路径；来源路径、
workspace、run 与 bridge 来自 Runtime。事务先以可读写但禁止内容写入的 URI 附加已有的
Session 库，以 BEGIN IMMEDIATE 同时锁定两库，再持有实际 product/bridge 来源至共享库
提交，前后核对 dispatched 工具、run、Location、lease epoch 与当前 PID。SQLite authorizer
拒绝附加来源库写入、修改附加关系及回调自行控制事务；只有共享主库产生内容变更，因此
不依赖跨 WAL 数据库写入的原子提交。回调失败或来源被取消时回滚，随后移除附加关系。

该 Rust 接口仅提供执行来源的事务栅栏，不作权限决策，也不确认目录所有权交接；调用层
仍须绑定目标项目/目录、核对交接完成状态，并接好共享 pending/always 和独立变更流。
没有新增通用 SQL 控制 RPC，没有启用自动迁移，也没有据此放开已冻结来源的 legacy run。

### 共享审批事务基础（尚未自动接线）

MIAP schema v4 将宿主断言与不可改写的请求结算事件保存在共享 Root。可信宿主显式绑定
项目和隐式本地目录，再由实际 Runtime 捕获不可构造的来源 handle；admit/status/reply/cancel
均在附加真实 Session 来源的 Root 写事务内检查 workspace、bridge、run/epoch 与取消状态。
请求摘要绑定 Root UUID、项目、目录、来源数据库、Runtime owner、run 及完整工具来源；
相同 ID 的不同内容或来源冲突拒绝，精确重试不追加相同结果。显式 workspace 身份暂不启用。

Always 仅保存请求明确提供的 save 模式，目录规则、revision 变更流、请求结果及结算事件
同一事务提交。第二条规则写入失败会回滚前一条、reply 与所有事件。once 不留下 standing
规则；过期、撤销后的请求不能追加 always。当前 agent deny 优先于 Root 中新保存的 allow。
独立连接修改规则后，只能由真正持有活跃来源的归属者在 status 中重新求值自己的 pending；
不为其他进程伪造 bridge，也不把 Root 控制读取当作执行许可。

此库级 API 尚未挂入 Runtime/宿主 RPC，没有新增激活能力声明。来源终结清理、兄弟请求
结算的库级边界见下；Runtime 调用、变更订阅唤醒、完整迁移回执校验及冻结后执行路径仍需
完成，在这些边界落实前不得启用共享后端或宣布 S6 验收。

同一 Root 回复事务在持有实际 bridge 来源集合锁期间结算兄弟请求。reject 只处理当时已
存在的同 Session pending，不复制用户纠正内容，不影响其他 Session 或随后新请求。成功
always 保存规则后，仅重新求值同 Runtime owner、项目和目录的已存在 pending；每项都
核对其实际 bridge、run/epoch 和捕获的 agent 规则。跨进程记录由各自实际归属者重新求值。
`retire_source_requests` 是可信归属者的仅取消操作：即使原工具已结束，也只按精确来源绑定
取消该来源剩余 pending，不新增规则或许可；重试不重复写入事件。此入口仍需在 Runtime
的来源终结及取消确认路径接线，不能据此宣称已自动清理。

目录来源绑定 `Context.bind_handoff(Store)` 从真实 Session 库读取并验证 completed 回执，
再与真实 Root 当前快照核对 UUID、项目、目录、workspace、原始指纹及原始数量，不接受
调用者提供的快照作为绑定凭据。返回不可直接构造的 `HandoffBinding`；每次 snapshot 重新
核对来源回执和目的端身份，读取当前规则并保留撤销结果。prepared、错误目的端或回执丢失
均拒绝。它只证明原生目录来源交接，不代替产品项目级交接证明、不解冻来源、不允许执行。

Session schema v24 为 engine_run 增加可空且不可改写的 shared_permission 标记。旧 INSERT
省略该字段仍为 NULL，冻结目录继续拒绝旧运行，旧规则读写也仍冻结。只有显式调用已验证
HandoffBinding 的运行准入入口，才携带 Root/项目/目录/原始指纹、Runtime UUID 和当前 PID；
SQL 还核对 completed 回执及当前执行租约。失败时连同 inbox 提升一起回滚。活跃共享运行
的目录不能删除或移走，同目录的重复输入准入仍可继续。此处只提供存储运行准入栅栏，
默认 Runtime 仍走旧入口；共享规则判定、审批及来源清理实际接线完成前不启用共享执行。

MIAP schema v5 在每条共享请求持久化实际来源数据库、run、捕获的租约 epoch 与 PID，并将
这些事实纳入来源/输入摘要。来源字段不可改写；实际回复、只读判定和兄弟结算均核对捕获
的 epoch，不能因同 PID 下 run/lease 同时改为新 epoch 就让旧回调重新获得权限。v4 的已有
pending 没有可证明的持久来源，升级只保留历史并结算为 source_metadata_unavailable 取消；
不猜 run、不重试 provider、不追加规则。旧请求 INSERT 缺来源字段会被 SQL 拒绝，已有
standing 规则、Root UUID 与规则变更游标保持不变。任一旧请求损坏时整个升级回滚。
