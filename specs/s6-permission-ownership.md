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

### 项目共享的原生规则存储前置

`permission_project::Authority` 是独立的项目持续规则库，不存 Session、执行 lease 或精确
调用 grant。可信宿主先绑定 project，后续查询和写入不再接收可变作用域；多个连接共享
同一个项目状态。数据库持久身份加项目内 revision 区分存储与版本；快照在同一读事务内
取得身份、revision、迁移凭据和规则。`global` 仍是旧的非 Git 项目 ID，不表示给全部
Git 项目增加授权。

旧行按项目一次性交接，原始 ID 与内容形成不可变凭据；逐 ID 撤销保留墓碑，旧输入重试
不恢复已撤销规则。原生规则保持独立，重复内容写入幂等。规则、凭据和 revision 同事务
提交，预算或存储失败全部回滚；跨项目、跨数据库、损坏凭据与未知库格式拒绝混用。
并发首开时，版本头和 schema 事实也必须在同一个初始化写事务内读取。

独立的 `miao-engine permissions --db PATH --project ID` 控制入口仅管理项目规则，不创建
Session 或 provider；项目在启动时绑定，逐帧不能选择数据库或作用域。它尚未改变 Runtime
的授权路径或启用自动迁移。

共享库 schema v2 增加 `Project.context(directory, workspace_id)`：目录先真实规范化，
省略 workspace ID 的 implicit-local 与显式 workspace 身份相互隔离。目录原生规则仍保留
原 `prule_` ID、目录和创建时间，不提升成项目授权；项目规则对同一项目各目录可见。
目录规则、迁移原始输入凭据和目录 revision 同事务提交，快照在一个读事务内取得项目与
目录两套事实。撤销后精确重试不复活旧规则；输入内容变化拒绝。项目及目录的有效规则
按内容合并后共用 256 条预算，数据库触发器也约束已打开的旧版项目写入连接。

v1 升级在初始化事务内保留库身份、项目 revision、原始规则和撤销墓碑；测试使用上一版
编译引擎实际生成的数据库 SQL 快照与来源记录。目录存储也可由上述控制入口的 `--directory PATH [--workspace-id ID]`
在进程启动时绑定；`context_snapshot/put/remove/migrate` 不接受逐帧范围变更。多进程
SDK 回归验证共享、隔离、迁移撤销与重启；它仍未接入 Runtime 或启用自动交接。
接线还需把活跃来源 fence、待审批记录及 always 答复的结算边界与项目规则一致地落实；
不能先在 Session 库确认 always 成功，再尽力写共享项目库。旧目录库到共享项目库的产品
交接、全项目撤销、投影重连与真实客户端验收仍是 S6 的未完成项。

目录目的端增加 `context_handoff {authority,patterns}`：在目录写事务内核对项目库持久
身份，第一次导入与原回执重试都必须匹配。原 `prule_` ID、时间及撤销语义不变；不匹配时
目录和项目状态均不修改。交接方须在冻结来源前检查对应能力，并绑定启动时确定的项目、
目录及显式 workspace 身份；同一路径换成另一座库不能继续旧交接。本 API 尚不冻结旧
目录来源，也不启用 Runtime 授权或自动迁移。

### 旧项目规则的持久交接边界

`PermissionHandoff.prepare` 在 Core 事务内保存原始项目规则、目标原生库持久身份和
原生迁移指纹，并安装写入保护。准备后不再允许旧来源列表参与授权，也不能增改删旧行；
重复准备只接受同一目标。原始行保留用于核对，不是原生规则的可写副本。非 Git 的
`global` 仍只是一个具体项目。

原生库完成迁移后，宿主将真实快照中的库身份和迁移回执交给 `complete`。项目、指纹和
原始数量必须精确一致，才能记录完成；回执保存失败时仍保留 prepared 状态，重启后重放
同一原始输入，再核对回执。没有本地 abort/unfreeze 操作，因为准备后可能已经在另一
数据库提交成功。这不是跨库原子事务，也不会重试 provider 工作。

Core 表改名为 `permission_legacy`，保留原主键、时间、唯一索引和项目外键。新版本 TS
路径仍可使用未冻结的项目；准备冻结的项目要求接入原生后端。旧客户端对原表的读取、
添加和撤销都会失败，不能静默读取过期授权或谎报撤销成功。应用此数据库迁移后，不支持
把旧二进制直接换回同一数据库；验收和发布必须明确这一格式兼容边界。

当前只有显式宿主交接 API 和写保护，没有启动时自动准备或后台迁移。产品接线还必须
绑定真实原生库、收敛旧运行来源，完成原生 source/pending/always 的事务结算，再启用
自动交接。原目录库的所有权切换也仍需单独接好，不能把本 API 当作整个 S6 完成。

显式宿主驱动 `handoffNativeProjectPermissions` 会先检查项目管理/目标绑定交接能力，
解析真实原生快照并核对项目，然后依次 prepare、带目标身份的 handoff 和 complete。
原生已有其他输入的回执时，在冻结旧库前拒绝；Core 已确认完成但原生回执丢失时，也不能
重新导入旧规则。原生提交后响应丢失或 Core 保存回执失败，只保留 prepared 边界；使用
新连接重试仍交给原生原始输入凭据核对，不复活已撤销行。不同目标库和并发宿主均通过
实际控制进程测试。这个驱动没有注册到模型工具、启动迁移或 Runtime 授权路径。

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

本地取消和匹配当前 run 的条件取消，先同步撤回 product bridge 来源，再回复接受。
撤回与授权提交使用同一来源锁：已经进入的提交可以在取消回复前完成，但不能在回复后
继续落盘。宿主取消通知由 Session actor 持有的任务发送，输出背压不推迟来源撤回；detach
等待通知，全局 shutdown 可中止其发送。过期 run 的条件取消保持当前来源不变。跨进程的
`run.cancel_requested` 仍是提交给归属进程消费的意图，不据此宣称远端已经停机。

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
