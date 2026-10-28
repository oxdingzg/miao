# RUS-03：Rust 产品控制面与接口责任图

状态：职责图已随 #1570 落地；源码盘点基线为 main `8cac456e63`，2026-10-28。
本文不是管理面已迁移的声明；关联实现和验收见 §8。
前置事实：S5 已让引擎读有序配置源（`--config-sources`）并自行派生 policy/LSP
（`crates/miao-engine/src/config_derive.rs:1`，LSP 物化消除 #1557 已合并）；saved 规则已投影
进引擎（product-permission.ts → `PermissionSavedProject`，#1546）。

## 1. 目的

RUS-03 回答一个问题：session 以外的全部产品控制面能力（HTTP API 与 CLI），今天归谁、
Rust 化时归谁。为账号、workspace、vcs、目录、配置、catalog、remote、pty 八个域分别
判定：**Rust 服务**、**兼容边界保留 TS**、还是**引擎 RPC 扩展**，并给出迁移前置与风险。

## 2. 方法与总判定

盘点来源：

- HTTP API：`packages/protocol/src/groups/*.ts` 全部 29 组；实现层
  `packages/server/src/handlers/*.ts`（handlers.ts:32 逐一装配）。
- CLI：`packages/miao/src/index.ts` 的 24 个 command loader + 默认 `tui`，以及
  独立拦截的内部命令 `__sandbox-run`。`auth`、`plug`、`remote-control` 是对应 handler 的兼容别名，子命令仍归各命令模块。
- 引擎 RPC：`crates/miao-engine/src/protocol.rs` `Command` 枚举（67 项）与
  `crates/miao-engine/src/host.rs:41` 分发。

**总判定：引擎 RPC ≠ 产品接口。** 除 session/message 外的 27 个 HTTP 组，其 handler 全部直接
使用 TypeScript 服务（`packages/core` 的 Integration/WorkspaceV2/Git/Catalog/
ConfigWrite/Pty/MCP/LSP/Format/RuntimeIdentity 等），**没有一个走引擎 RPC 透传**。
引擎 Command 枚举主要是 Session 执行域词表；§5 单列目录、凭据、迁移和执行支撑边界。因此"引擎已有某条 RPC"
永远不能推出"该产品能力已迁移"；反向也不成立：产品接口大面积存在，而引擎面为空。

## 3. HTTP API 责任图（session 以外）

属主列均为 TS 服务（`packages/core`），实现入口 `packages/server/src/handlers/<组>.ts`。

| 组           | 端点                                                                                        | 现属主                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| health       | health.get                                                                                  | 版本常量 + 进程 pid                                                                                                 |
| capabilities | capabilities.get                                                                            | 静态声明                                                                                                            |
| formatter    | formatter.status                                                                            | Format.Service                                                                                                      |
| config       | config.get/update/providers/catalog                                                         | Config.Service 读；ConfigWrite.Service 写（失效 open location + ConfigEvent.Updated）；providers/catalog 查 Catalog |
| lsp          | lsp.status                                                                                  | LSP.Service                                                                                                         |
| mcp          | mcp.status/resources/authenticate/logout/connect/disconnect                                 | MCP.Service（产品侧客户端；凭据留在产品存储）                                                                       |
| location     | location.get、location.path                                                                 | Location.Service + Global（home/state/config 目录）                                                                 |
| agent        | agent.list                                                                                  | AgentV2.Service                                                                                                     |
| model        | model.list/default                                                                          | Catalog（bootedCatalog）                                                                                            |
| provider     | provider.list/get                                                                           | Catalog                                                                                                             |
| integration  | integration.list/get/connect.key/connect.oauth/attempt.status/complete/cancel               | Integration.Service（OAuth/key 连接流）                                                                             |
| credential   | credential.list/update/activate/remove                                                      | Integration.Service（connection）                                                                                   |
| permission   | permission.request.list、permission.saved.list（全局）；session.permission.\*（session 域） | PermissionSaved + SessionV2/引擎                                                                                    |
| fs           | fs.content/read/list/find                                                                   | FileSystem.Service（Location 根相对路径）                                                                           |
| command      | command.list                                                                                | CommandV2.Service                                                                                                   |
| skill        | skill.list                                                                                  | SkillV2.Service                                                                                                     |
| event        | event.subscribe、event.durable                                                              | EventV2 + ClientEvents                                                                                              |
| pty          | pty.shells/list/create/get/update/remove/connect-token/connect（websocket）                 | Pty.Service + PtyTicket（票据/origin 校验）+ PtyEnvironment                                                         |
| question     | question.request.list（全局）；session.question.\*（session 域）                            | Question + SessionV2/引擎                                                                                           |
| reference    | reference.list                                                                              | Reference.Service                                                                                                   |
| projectCopy  | projectCopy.create/remove/refresh                                                           | ProjectCopy.Service                                                                                                 |
| project      | project.list/current/directories/update/initGit                                             | ProjectV2/ProjectMetadata/GitCli（initGit 后失效 Location）                                                         |
| vcs          | vcs.get/status/diff                                                                         | Git + GitCli + VcsDiff                                                                                              |
| workspace    | workspace.list/status/adapters/create/syncList/warp/remove                                  | WorkspaceV2.Service                                                                                                 |
| worktree     | worktree.create/remove/reset                                                                | ProjectWorktree.Service（先释放目标 location 再操作）                                                               |
| controlPlane | controlPlane.moveSession                                                                    | MoveSession.Service                                                                                                 |
| runtime      | runtime.identity/stop + runtime.control.\*（13 端点：启停、账号信任、配对、设备授予）       | RuntimeIdentity（Remote Control administration，仅 hosted Runtime 可用）                                            |

session 域（`session`、`message`，及 permission/question 组内的 `session.*` 端点）是
S2–S6 与 Phase 3 的范围，本文只标界、不展开；其混合属主（TS 编排 + NativeEngine RPC，
`packages/server/src/handlers/session.ts` 全文引用 NativeEngine.Service/Placement）
不在责任图内重新判定。

## 4. CLI 命令面责任图

机制三档：**本地**（纯本地文件/进程，不开服务）、**TS 服务**（直用 packages/core 服务或
直读产品库）、**引擎相关**（经 placement/引擎二进制，或经 server 的 session 域间接）。

| 命令                    | 职责                                                                         | 机制                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| tui（默认 Rust）        | 交互界面                                                                     | CLI 启动 Rust TUI，Rust TUI 直接启动/连接 native engine；不经 TS HTTP server |
| tui（`--tui legacy`）   | 兼容交互界面                                                                 | TS worker/server；session 域按 placement 使用引擎                            |
| serve                   | 启动 HTTP server（全量产品服务）                                             | TS 服务；`applyEngineOptIn` 决定 native placement                            |
| run                     | 无头运行一次 prompt                                                          | TS 编排；native placement 时派引擎子进程                                     |
| attach                  | 连接已运行 server                                                            | 纯客户端（ServerAuth）                                                       |
| session                 | list/delete/migrate/migrate-all/migrate-back/compact                         | TS 编排；迁移等子命令显式启动 EngineClient，按 placement 处理 native 数据    |
| db                      | externalize-blobs/gc-blobs/backfill/vacuum/retention/restore/compact         | TS 直读产品库                                                                |
| doctor                  | DB 完整性 + 引擎二进制发现（resolveEngine/engineSettings/engineStorageRoot） | TS + 引擎二进制检查                                                          |
| mcp                     | add/auth/login/logout/list                                                   | TS 服务（McpAuth/McpOAuthProvider，写全局配置与凭据）                        |
| providers               | login/logout/list                                                            | TS 服务（ModelsCatalog/Credential/Integration）                              |
| models                  | 模型目录                                                                     | TS 服务（Catalog/ModelsCatalog）                                             |
| agent                   | agent 文件创建/编辑                                                          | 本地文件（可选 ai 生成）                                                     |
| plugin / marketplace    | 插件安装/市场                                                                | 本地文件 + 全局配置                                                          |
| export / import         | 会话导出/导入（V1 兼容）                                                     | TS 直读/写产品库；引擎侧另有 Transfer\* RPC（session 域基础设施）            |
| stats                   | 用量统计                                                                     | TS 直读产品库（SessionStats）                                                |
| pr                      | `gh pr checkout` 后启动 miao                                                 | 本地（GitCli + gh）                                                          |
| remote                  | login/status/logout                                                          | TS 服务（RuntimeOwnership/RuntimeRegistration/HubSetup + OpenCode client）   |
| runtime                 | `runtime <action>` → runtime-access                                          | TS 服务（RuntimeOwnership/RuntimeRegistration，直读产品库）                  |
| web                     | 启动 server 并开浏览器                                                       | TS 服务                                                                      |
| acp                     | ACP 协议对外暴露会话                                                         | 本进程 TS 运行时（packages/acp）                                             |
| upgrade / uninstall     | 安装管理                                                                     | 本地                                                                         |
| generate                | 生成命令/agent 文档                                                          | 本地                                                                         |
| debug \<name\>          | config/file/lsp/redact/ripgrep/scrap/skill/snapshot/startup/v2 诊断          | TS 直读                                                                      |
| `__sandbox-run`（内部） | 单文件产物自执行沙箱子进程入口                                               | 在 yargs 之前拦截；独立于公开命令目录                                        |

引擎依赖按入口、模式和子命令判断：默认 Rust TUI 直接依赖引擎；legacy TUI、attach、
web 和 ACP 使用宿主服务面；serve/run 按 placement 接入 native；session 迁移直接使用
EngineClient。不能从“命令 handler 是 TS”推出它不依赖引擎。

## 5. 引擎 RPC 现有面与缺口

`Command` 枚举（protocol.rs:221）几乎全部以 `session_id` 为第一个参数：Initialize、
Admit、Shell/ShellStatus、Inject、Wake/Resume、PendingInputs/CancelInput、SelectModel、
SelectAccount、Recoveries/ResolveRecovery、Mode、Rename、Archive、Remove、RequestCompact、
SelectAgent、Cancel/CancelIf、Compact、Recall、Crons/CancelCron、Wakeups/CancelWakeup、
Questions/AnswerQuestion/RejectQuestion、State/Usage/UpdateState、History、Job/Jobs/
CancelJob、Context、Snapshot、Fork、Revert\*、Events/Subscribe/Unsubscribe、Approve/
ApprovePersistent、Shutdown。

例外（看起来像产品能力、实际是执行域内部 RPC，禁止据此宣称"产品接口已迁移"）：

| Command                                                                                                                  | 实际含义                                                            | 不覆盖的产品面                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ModelCatalog                                                                                                             | 查询 spawn 时宿主注入的 exact provider 路由表（model_catalog.rs:1） | catalog 的**管理**：连接、登录、刷新、默认模型决策全在 TS Catalog         |
| SelectAccount                                                                                                            | 只携带 opaque credential id（session_account.rs:1）                 | 账号/凭据的**管理**：integration.\*、credential.\*、providers 登录全在 TS |
| TransferValidate/Stage/Activate/Export\*/Abort                                                                           | 会话迁移/导出的存储操作                                             | import/export 的产品语义、V1 兼容读取全在 TS                              |
| PermissionEvaluate、PermissionSavedProject（S6 投影，#1546）、TimerSessions（supervisor 重拥有）、Sessions（catalog 读） | 执行域支撑与规则求值                                                | 不含账号、目录或权限管理面 CRUD                                           |

**缺口单**（引擎 RPC 完全没有、也不应有）：账号与凭据管理、auth、config 写、catalog
管理、vcs、fs、pty、workspace、remote control、integration。

引擎对宿主事实的**只读消费**（不是接口）：`credential.rs:185` 直接对产品 credential 表
执行 `SELECT integration_id,value FROM credential WHERE id=?1`（`--credential-db/
--credential-id/--credential-integration`），或 `--auth-file` 静态注入，或交给 AWS SDK
profile，或问 credential daemon（miao_credential::client）。spawn 参数即契约
（`packages/miao/src/engine/client.ts:261` engineArgs）：`--config-dir --config-sources
--workspace --db --model` 加一组仍存在的物化文件参数（§6 配置域）。

## 6. 八域归属判定

| 域                                  | 现属主                                                                                                                                                                                                            | 目标                                                                                                                                                                                                                                                                                   | 前置依赖                                                               | 风险                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 账号（integration/credential/登录） | TS Integration.Service（integration.\*、credential.\*、CLI providers/mcp auth）；引擎只消费（§5）                                                                                                                 | **兼容边界保留 TS**；引擎维持"opaque 引用 + 只读消费者"契约                                                                                                                                                                                                                            | credential daemon（miao_credential）只在 Rust 宿主接管长驻刷新时才需要 | credential 表 schema 演进破坏引擎只读 SELECT；OAuth 刷新逻辑双实现漂移                                                                   |
| workspace                           | TS WorkspaceV2.Service                                                                                                                                                                                            | **兼容边界保留 TS**（Phase 4 再议）                                                                                                                                                                                                                                                    | 无                                                                     | phase-3-parity 已记录 workspace 列表/切换为"有意偏离（Phase 4 宿主移植）"；warp/syncList 依赖外部适配器二进制，Rust 化成本高收益低       |
| vcs                                 | TS Git/GitCli/VcsDiff + ProjectWorktree + ProjectCopy                                                                                                                                                             | **兼容边界保留 TS**；git 解析不双实现                                                                                                                                                                                                                                                  | 若未来 Rust 宿主接手 worktree：LocationServiceMap 失效协议             | worktree.reset"先释放 location 再操作"的顺序是易错点；diff 语义（working/branch）两侧漂移                                                |
| 目录（location/project/fs）         | TS Location/LocationServiceMap、ProjectV2/Metadata/Directories、FileSystem.Service                                                                                                                                | **兼容边界保留 TS**；引擎只拿 `--workspace` 与 storage root                                                                                                                                                                                                                            | 无                                                                     | project.initGit 后的 locations.invalidate 顺序；fs 的 Location 根相对路径安全边界在中间件                                                |
| 配置                                | 读：双侧（TS Config.Service；引擎 config_scope.rs）；写：TS ConfigWrite.Service；派生：policy/LSP 已进引擎（config_derive.rs，黄金样例对齐）；formatter 派生仍是 TS 探针（附录 A）；saved 规则投影进引擎（#1546） | **混合**：解析维持"一份解析器两种读者 + 黄金样例"；写路径留 TS；物化按"纯配置 vs 宿主事实"二分——纯配置类已删（policy/LSP，#1557 已合并），宿主事实类保留并登记（product-routes/product-tools/plugin-hooks/mcp-config/ambient-context，另有 product-agent/command/hooks/worker-config） | formatter 宿主事实契约（附录 A）                                       | 解析器漂移（golden 样例防线）；写后失效窗口：引擎 owner 启动时读一次配置，宿主改配置不回灌已有 owner；JSONC/V1 迁移双实现                |
| catalog                             | TS Catalog/ModelsCatalog（model.\*、provider.\*、config.providers/catalog、CLI models）；引擎 model_catalog.rs/model_routes.rs 是 spawn 注入的执行投影                                                            | **兼容边界保留 TS**（目录管理）；引擎路由表继续宿主注入（product-routes 物化登记为宿主事实）                                                                                                                                                                                           | G0-1 已完成（五条原生路由 + 两侧等价测试）                             | 把 `ModelCatalog` RPC 误当"catalog 已迁移"（§5 已钉死）；ADC-only 账号仍走宿主网关（g0-1 实现记录）                                      |
| remote                              | TS RuntimeIdentity administration（runtime.\* 13 端点）+ packages/remote-control（HubSetup）+ RuntimeOwnership/RuntimeRegistration（CLI remote/runtime）                                                          | **兼容边界保留 TS**；hub/relay 协议与引擎解耦，session 事件经宿主转发                                                                                                                                                                                                                  | window-runtime.md 的窗口生命周期契约                                   | `runtime.control.setSessionEnabled` 需 placement 感知：native session 在引擎，宿主只能经 session 域 RPC 到达；远程客户端永远只见产品接口 |
| pty                                 | TS Pty.Service + PtyTicket（票据/origin 校验）+ PtyEnvironment + websocket upgrade                                                                                                                                | **兼容边界保留 TS**；交互终端面板是宿主能力，引擎 session shell 是另一回事（session 域）                                                                                                                                                                                               | 无                                                                     | 票据/CORS/origin 校验语义迁移时易丢；Windows ConPTY 差异；进程生命周期与宿主窗口绑定                                                     |

判定汇总：八域中零个域近期需要新 Rust 服务；两个域（配置读、catalog 路由投影）已有
引擎侧"执行投影"；其余全部是兼容边界保留 TS。引擎 RPC 扩展只在 session 域内部继续
（S2–S6），不为上述八域加管理面 RPC。

## 7. 迁移顺序与依赖

```
本文（RUS-03 责任图 PR）
  ├─► 契约钉住：credential 只读 SELECT、formatter enabled(context)、
  │   engineArgs 参数表各上一组测试（防无意识漂移）
  ├─► 物化清单二分收口（S5 尾巴）：
  │     纯配置类 → policy/LSP 已退役，#1557 已合并
  │     宿主事实类（routes/tools/hooks/mcp-config/ambient-context）→ 登记 + 版本化
  │        └─ formatter 采用附录 A 选项 2，保留宿主探针
  └─► remote 的 placement 感知路径审查（复用 session 域接口，不加管理面 RPC）
Phase 4（宿主移植，依赖 G0-5 + S5 成果，本文不做）：
  账号管理 / pty / remote / vcs / workspace / catalog 管理的 Rust 宿主化
```

顺序原则与 rust-phase-2.md §4 一致：先钉契约、再删/留路径；删除与新增不在同一 PR。

## 8. 验收

- §3/§4 表格覆盖 session/message 外全部 27 个 HTTP 组与全部 24+1 个公开 CLI 入口及内部沙箱入口，每行有属主
  判定；抽查任一行能在 `handlers/` 或 `cli/cmd/` 找到对应实现。
- §5 的例外表明确列出"易被误读为产品接口已迁移"的引擎 RPC。
- 八域每域有唯一目标判定。formatter 保留宿主探针（附录 A 选项 2），不将它的环境
  探测误写成引擎已有的静态配置派生。
- 关联实现 PR：#1570 为职责图，#1557 为 LSP 物化退役，#1546 为 saved 规则投影，
  #1559/#1572 为 credential、formatter context 与 engineArgs 契约；均已合并。
- 本次离线盘点的完整入口名称见
  [源码清单](../docs/experiments/2026-10-28-ownership-inventory/inventory.json)。清单固定于
  main `8cac456e63`，不是新版本所有入口都永久不变的声明。管理面的实际迁移、真实客户端和
  后续发布仍由各自条目验收，不能由本职责图代替。

## 9. 不做（Phase 4 边界）

- 不把 integration/credential 管理、catalog 管理、pty 面板、remote control、vcs、
  workspace 移进引擎，也不为它们新建 Rust 服务。
- 不为上述八域新增引擎管理面 RPC。
- 不动 session 域接口（S2–S6 与 Phase 3 范围）。
- 本 PR 不改任何代码。

## 10. 风险

| 风险                                                                                  | 处理                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| "引擎 RPC 已存在"被误读为"产品接口已迁移"                                             | §5 例外表 + 验收抽查；评审引用本文 §2 总判定                                                                        |
| credential 表 schema 演进破坏引擎只读读路径                                           | 契约钉住（§7 第一步）：表结构变更须双侧评审                                                                         |
| 配置写后失效窗口：TS 失效 open location，但引擎 owner 启动读一次不回灌                | 语义如实登记（保持现行为）；如需热更新另立设计                                                                      |
| S5 收口时机械"删除全部 product-\*.ts"误删宿主运行时事实                               | §6 配置域二分清单；formatter 按附录 A 选项 2 登记为宿主事实                                                         |
| mcp 双消费者混淆：TS MCP.Service（产品 HTTP 面）与引擎 mcp.rs（session 内客户端）并存 | 二者读不同来源（产品配置 vs mcp-config 物化的 trusted global servers），auth 状态留在产品存储；文档已注明，不做合并 |
| CLI 直读产品库（session/db/export/stats）在 S4 存储合一遍后读到的是投影               | S4 落地时重审这批命令的读路径；本文仅标记                                                                           |
| 引擎二进制发现（doctor/discovery.ts）随分发方式变化失效                               | 属发布/updater 路径（Phase 4），届时随 runtime-upgrades.md 一起审                                                   |

## 附录 A：formatter 探针归属（保留宿主事实）

现状：引擎没有探测器，只有执行器（formatter.rs:1"host-configured formatters run
through the same confined process runner as tools"）。TS 侧
`packages/miao/src/engine/product-formatter.ts:53` 逐个调用
`Formatter.*.enabled({ directory, worktree, experimentalOxfmt })`——每个 formatter 的
`enabled` 是一段进程探测（execFile/which/findUp 读 package.json 等，
`packages/core/src/format/registry.ts:53`），返回 argv 或 false；解析结果写临时
`formatter.json`（0600）经 `--formatter-config` 交给引擎。

这不是"机械移植欠账"，而是设计决策：探针探测的是**宿主运行时环境事实**（哪些
formatter 二进制在 PATH、如何调用），与 product-routes（宿主路由）、product-tools
（宿主工具清单）、plugin-hooks、mcp-config、ambient-context 同类。S5 收口把它们
从"待删除物化"重分类为"保留的宿主事实"。

选项：

1. **Rust 复刻探针**：引擎自带 which/版本探测 + 每个 formatter 的探测规则。每加一个
   TS formatter 都要双侧同步，违背"一份解析器"原则，成本最高。
2. **保留 TS 物化作为运行时事实**（当前采用）：与 product-routes 等同一待遇；代价是引擎
   的自动 formatter 发现依赖宿主先跑探针；显式 operator manifest 仍可覆盖。
3. **混合**：引擎做通用探测原语（which/argv 解析），宿主下发"探测策略"清单。引入新
   DSL，复杂度不划算。

采用选项 2，保留 product-formatter.ts 的宿主探针和私有生命周期清单；这保持当前运行
边界，不宣称 formatter 已完全 Rust 化。`enabled(context)` 的 context 三元组
（directory/worktree/experimentalOxfmt）已有 #1572 的实际 prepare 路径测试，engineArgs
参数表同样钉住。若以后替换传输或迁移探针，需单独实现及验证对应契约。
