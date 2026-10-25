# miao 当前任务与接手清单（2026-10-25）

核对时间：2026-10-25 21:35 +08:00。此文件是交接快照；PR、CI、运行中的验收可能继续变化，接手先读取下面列出的实时交接文件。

## 1. 用户目标与当前结论

用户要求接手意外关闭的 Claude Code、Codex、miao 会话的全部工作，保存清单、完成修复、及时 commit/push，核对遗留 PR 和分支；**当前 PR、分支和任务完成后，才能发布 0.3.7**。已明确授权直接推进，不必重复请求确认。

**尚未全部完成。当前 26 个开放 PR；main 为 `11f40256a69f3e5f3417006606d8d638db5f863f`。** 开发版本已同步到 0.3.7，但未发布 0.3.7。日常稳定命令仍是已发布 0.3.6；构建成功、preview 安装、版本号变更都不等于发布。

不要只完成合并就宣布全部结束：还有同一最终产物验收、兼容性新缺陷、真实 ACP 客户端验收、进程机制复核，以及明确尚未实现的 Rust 后续阶段。

## 2. 谁在做什么，避免并发覆盖

- **Claude 当前会话负责合并、更新 PR 基线、处理合并冲突、删除已合并分支。** 用户在该会话明确要求先合 #1398、再 #1408、然后其余可合并项。不要另开第二套 merge/update-branch 自动化。
- 本 Codex 协调会话负责实现与复核、release pairing、最终验收和交接。
- 原 Codex continuation `01a17289-2be3-7d42-81a3-43171216c11b` 仍在做验收/CI；其窗口关闭不代表后台工作停止。它不负责合并或发布。接手前读取 `/tmp/miao-reliability-handoff.json` 最新字段并协调。
- Claude 状态：`/tmp/miao-claude-takeover-handoff.json`。其中 #1421 “DIRTY”是过期记录：stdin 修复已提交 `2d71393c24`，最近核对工作树干净，可由合并者继续处理。
- `/tmp/miao-land-prs.py` 已转审计模式；`~/.local/state/miao/landing-state.json` 中 `auditOnly: true`。不要自行恢复写操作。
- 其他 embrix 会话及进程必须保留；不批量 pkill、不重启其服务。

## 3. 已完成的核心工作（多数仍待合并，不能等同已发布）

- 已恢复并备份关闭会话的任务及上下文；截图中的 `feat/app-context-timeline` 对应原 context Session，302 条记录已保存。
- #1398 已 squash 到 main `11f40256a6`；#1399 之前合入 #1398 父分支，其修复随 #1398 进入 main。覆盖元数据读写隔离、目录异常隔离、标题恢复等。#1415 仅版本同步已合并 `fb78c5dac1`。
- 已实现并推送：idle ownership、流式语义事件 watchdog、原子 admission、长历史保留、裁剪事实持久化、裁剪增长防护、孤儿回收和并发 sweep/reopen 竞态修复、目录列表作用域、只读原生 catalog。
- 已实现并推送：usage history API、持久化 context/cache 图、估算组成图、TUI settlement cards、紧凑 footer。组成图明确是估算，不能称为原生精确持久化快照；61 个非英文词典具备键覆盖，稀疏语种仍建议人工语言审校。
- #1421 只读 catalog 不启动执行 Runtime、租约、迁移、LSP/MCP 或 provider；批量最多 200 项，bounded stdin 避免 Windows 命令行长度限制。真实 Linux/Windows CLI 回归均已验证。
- #1419 generated inbox ID 已扩展为可逆身份，处理 read/cancel/promotion/legacy alias；作者报告实际引擎全套 372 tests / 0 fail，CI 仍单独核对。
- #1422 显式 context limits 被自动 route 默认值覆盖已修复；#1423 headless TS 标题完成注册表已修复，R5 实际编译产物标题验收通过；#1426 concurrent native create 通过 placementConflict 后重读采用现有 projected Session，保留其他错误。
- #1425 release pairing 已实现/推送 `7cdace8835`：release 自动构建每架构 engine 后签名嵌入；优先 retained build 的配对 engine，保留显式 override，不覆盖其他窗口持有的旧文件；自动升级不再只换 CLI 而遗留旧 engine。
- #1425 已通过 17 单测、typecheck、真实编译 Windows 锁定旧 engine 升级夹具；完整 Web UI 的 macOS ARM、Intel、Intel-baseline 构建和执行 smoke 均通过。它还不是已合并 main 的最终发布产物。

## 4. 开放 PR 完整快照

合并前重新读取实时 head 与 checks。下表中的“开放”不表示代码尚未实现，也不表示 CI 已通过。

| PR | 内容 | 分支 → 基线 |
| --- | --- | --- |
| [#1394](https://github.com/oxdingzg/miao/pull/1394) | feat(build): embed the engine binary into the single-file build | `feat/embedded-engine-artifact` → `main` |
| [#1400](https://github.com/oxdingzg/miao/pull/1400) | fix(engine): reclaim idle runtimes using process-owned live work | `fix/engine-idle-ownership` → `main` |
| [#1401](https://github.com/oxdingzg/miao/pull/1401) | fix(engine): keep event idle deadlines active throughout provider streams | `fix/native-stream-watchdog` → `fix/engine-idle-ownership` |
| [#1402](https://github.com/oxdingzg/miao/pull/1402) | test(conformance): verify isolated engine placement and durable outcomes | `test/conformance-workspace` → `main` |
| [#1403](https://github.com/oxdingzg/miao/pull/1403) | fix(engine): publish initial input promotion and run start atomically | `fix/native-run-admission-gap` → `fix/native-stream-watchdog` |
| [#1404](https://github.com/oxdingzg/miao/pull/1404) | feat(engine): persist measured tool output pruning facts | `feat/context-prune-events` → `fix/native-run-admission-gap` |
| [#1405](https://github.com/oxdingzg/miao/pull/1405) | fix(engine): preserve long session context, snapshots and forks | `fix/native-long-history` → `fix/native-run-admission-gap` |
| [#1406](https://github.com/oxdingzg/miao/pull/1406) | docs: refresh native engine acceptance status | `docs/native-acceptance-status` → `main` |
| [#1407](https://github.com/oxdingzg/miao/pull/1407) | feat(tui): consolidate the composer into a compact status layout | `feat/tui-compact-footer` → `main` |
| [#1408](https://github.com/oxdingzg/miao/pull/1408) | feat(session): expose paginated provider usage history | `feat/session-usage-history` → `main` |
| [#1409](https://github.com/oxdingzg/miao/pull/1409) | docs: preserve interrupted session work and acceptance checklist | `docs/session-takeover` → `main` |
| [#1410](https://github.com/oxdingzg/miao/pull/1410) | feat(app): chart persisted context and cache history | `feat/app-context-history` → `feat/session-usage-history` |
| [#1411](https://github.com/oxdingzg/miao/pull/1411) | fix(engine): release orphaned engines instead of resurrecting them | `fix/engine-orphan-leak` → `main` |
| [#1413](https://github.com/oxdingzg/miao/pull/1413) | feat(app): chart estimated input composition over time | `feat/app-context-composition` → `feat/app-context-history` |
| [#1414](https://github.com/oxdingzg/miao/pull/1414) | fix(engine): reject pruning that expands tool output | `fix/native-pruning-growth` → `feat/context-prune-events` |
| [#1416](https://github.com/oxdingzg/miao/pull/1416) | feat(context): replay pruning facts and render settlement cards | `feat/context-settlement-cards` → `feat/context-prune-events` |
| [#1417](https://github.com/oxdingzg/miao/pull/1417) | fix(tui): scope session listings to the active directory or project | `fix/tui-session-list-scope` → `main` |
| [#1418](https://github.com/oxdingzg/miao/pull/1418) | fix(engine): accept ten-minute foreground timeouts | `fix/engine-tool-timeout` → `main` |
| [#1419](https://github.com/oxdingzg/miao/pull/1419) | fix(engine): give generated inbox inputs a product identity | `fix/native-pending-input-ids` → `main` |
| [#1420](https://github.com/oxdingzg/miao/pull/1420) | test(core): make ripgrep deadline coverage deterministic | `test/ripgrep-timeout` → `main` |
| [#1421](https://github.com/oxdingzg/miao/pull/1421) | fix(engine): read native catalogs without execution owners | `fix/native-catalog-readonly` → `main` |
| [#1422](https://github.com/oxdingzg/miao/pull/1422) | fix(engine): preserve explicit context limits in generated routes | `fix/native-context-limits` → `main` |
| [#1423](https://github.com/oxdingzg/miao/pull/1423) | fix(core): settle session titles before headless teardown | `fix/headless-session-title` → `main` |
| [#1424](https://github.com/oxdingzg/miao/pull/1424) | docs(engine): record corrected 0.3.7 conformance receipts | `docs/conformance-v037` → `main` |
| [#1425](https://github.com/oxdingzg/miao/pull/1425) | fix(build): ship and select engines paired with each release artifact | `fix/release-engine-pairing` → `feat/embedded-engine-artifact` |
| [#1426](https://github.com/oxdingzg/miao/pull/1426) | fix(core): adopt concurrent native session creation | `fix/native-create-race` → `main` |

依赖顺序：#1400 → #1401 → #1403 → #1404 → #1414/#1416；#1405 依赖 #1403；#1408 → #1410 → #1413；#1394 → #1425。#1420 应先于 #1416 的最新 CI；#1426 应先于 #1422 再验证相关竞争问题。合并父 PR 后按需 retarget、更新子分支并等待当前 head CI。

## 5. 剩余任务，按优先级执行

### P0：新发现的 engine capabilities 协议兼容检查缺陷

- [ ] 修复 `packages/miao/src/engine/discovery.ts` 的真实 wire 解码：Rust `--capabilities` 输出 `routes_schema`，当前检查偏向 `routesSchema`，导致实际声明 schema=1 的引擎被当成“旧格式未声明字段”而错误接受，当前 REQUIRED_ROUTES_SCHEMA=2。
- [ ] 对 snake_case 正常解码/规范化；拒绝非法值和冲突表示；保持真正缺字段的既有 legacy 策略。使用真实子进程输出做回归，不只注入 camelCase probe。
- [ ] 复现脚本 `/tmp/miao-capabilities-contract-check.ts` 已运行，`incorrectlyAcceptedOldSchema:true`。当前编译 engine 的 schema=2，没有证据表明当前 engine 本身不兼容；问题是旧 engine fail-fast 防线失效。
- [ ] 此文件原由本协调者冻结管理；继续前与现有工作者协调，独立 concern 分支/PR，检查后及时 commit/push。此项刚发现，尚未实现，不能遗漏。

### P0：CI、审核、合并与分支核对

- [ ] 由唯一合并者处理上表 26 个 PR，遵守 main 保护、审核与 required checks，squash + 删除已合并远端分支。禁止 direct push main、admin bypass、修改保护或伪造通过状态。
- [ ] 不把 cancelled 当作代码失败。近期批量更新分支导致排队拥堵，取消旧 run 后 wrapper 出现 `policy expected success got cancelled` / `RESULTcancelled`；应检查最新 head 的真实 job。
- [ ] #1394 原测试受继承 `MIAO_ENGINE_BIN` 干扰，fixture-only 修复 `28463c49cc` 已推送；#1425 需同步父分支再验收。
- [ ] #1416 的 ripgrep 1ms 扫描竞争已在 #1420 修复，保留真实 timeout/child termination 断言，合并后刷新 CI。
- [ ] #1408 Windows 可选 E2E cached timeline：latest-message 位置断言通过，但 10 个首帧后代节点被移除，106/107 tests 通过、该项重试仍失败。待比较基线、检查具体节点，不能盲目放宽断言。日志 `/tmp/miao-1408-windows-e2e.log`。
- [ ] #1426 复核并合并，再验证 native Session 并发创建；历史 #1422 失败未保留响应 body，不能宣称已证明唯一原因。
- [ ] 用 `bun script/branch-hygiene.ts` 核对所有远端分支、已关闭未删除分支和未关联 PR 分支；没有独立补丁/工作树依赖证据前不直接删除。

### P0：同一最终产物的全量验收与发布

- [ ] **正在执行 R7 全量 24 格真实 conformance**，由原 Codex continuation 持有。日志 `/tmp/miao-conformance-20261025-v037-r7.log`；源码私有组合 `96e5d42c33`，产物 `/private/tmp/miao-reliability-artifacts-r6`（R7 复用相同未修改产物）。最新快照 13 格完成：12 pass、1 TS model tool-skip fail。两种引擎 forced compaction、interrupt recovery 已通过。等待完整结果，诚实保留失败。
- [ ] R6 因显式 `MIAO_MODELS_PATH` 绕过价格 overlay，在 4 格后主动中止；不能拿它的 usage-priced 结果作为验收。R7 已移除该 pin。
- [ ] #1424 当前记录的是完整 R2 的 22 pass/2 fail，加修复后 R3/R4/R5 的针对性通过，**不是一个不变最终产物 24/24**。R7 完成后追加准确来源、失败与 hash。
- [ ] 当前 R6/R7 CLI SHA256 `8f19156725475282d37273837faa0b48d894e77e3f658301ede595205198f712`；engine SHA256 `65cf97243fbb7bbfe66d971acafb818be9617b7941decca095b20c1b48f5fd3c`。它是组合分支产物，后续 P0 兼容检查修复/main 合并后仍需最终匹配产物验证。
- [ ] main 全部修复稳定后，远程完整构建 0.3.7 CLI+Web UI+匹配 engine，验证版本/协议、干净 HOME、离线提取、旧版本升级、Windows 锁定文件、多架构签名与许可证。已完成构建证据可复用作定位，不能冒充新 main 产物。
- [ ] 最终真实 TUI：120/42 列、idle/busy/retry/queue/compaction/error/approval；恢复关闭 Session 的显示；长工具序列、两窗口隔离、父子完成、崩溃/重启、关闭一个窗口不影响另一个；监测 engine 数量和孤儿。恢复用户 Session 不得隐式重新执行生产 pending prompt。
- [ ] 安装仅用 `miao-preview`，不得覆盖 release-managed 日常 `miao`。最新 R7 实际 home prompt 120/42 列已 smoke，6 个组合 footer/status 测试通过；完整状态矩阵尚未全部重做。
- [ ] 所有当前工作完成后，版本脚本、release notes、正式发布工作流、实际 GitHub release 资产与下载安装验证；最后清理已合并分支及自有 QA 进程。没有派发 0.3.7 release。

### P1：第二个真实 ACP 编辑器验收（进行中，未通过）

- [ ] 采用实际 Neovim 0.12.6 + CodeCompanion v20.0.1，独立 portable QA，非 SDK/mock 客户端。CodeCompanion commit `142eadffdaa8dd06060646b6f8ef74e99c42ab06`；还需记录 plenary commit。
- [ ] 本地工作材料 `/private/tmp/miao-acp-editor-qa/`：`init.lua`、`agent-wrapper.mjs`、`provider.mjs`、`nvim-control.py`；远程同名临时目录，实际构建 miao/engine 冻结副本、独立 HOME/XDG/DB/storage。
- [ ] 初次编辑器连接后 newSession 报“selected product model has no usable native credential/provider route”，尚未走到 approval。wrapper 已加显式 fixture-only native provider/endpoint/model 环境，**这个修改尚未重跑验证**。不要标记客户端通过。
- [ ] 用实际 UI 逐项批准、拒绝、取消：允许写 `allowed.txt`；拒绝不产生 `denied.txt`；流式请求实际 cancel 并释放 provider/engine。观察实际 ACP wire 与编辑器事件。
- [ ] CodeCompanion ask 模式：普通模式 Esc 后 `g2` 同意、`g3` 拒绝，普通 `q` 停止当前请求；Ctrl-C 可能关闭 chat，不可混称等效 cancel。
- [ ] 最近远程进程查询未见该 QA 目录进程，之前 provider/editor SSH session 不可当作仍活着；接手先检查并重新启动必要的自有服务。不得误杀 embrix。代理地址 JSON/日志只存临时目录，fixture key 不是真实凭据。
- [ ] 成功后关闭编辑器，核对该 QA 启动的所有 PID 退出、清理 provider；将脱敏证据更新 #1267/#1406 或单独 PR。

### P1：外部真实验收条件

- [ ] Anthropic 协议 gateway 周配额恢复后，完成真实多轮会话。已有单轮成功不能当多轮通过。
- [ ] 账号主人在场时观察真实 credential 自然过期，确认 broker refresh；受控测试已完成，但不能代替自然过期验收。
- [ ] 配额/自然时间条件不满足时明确记录外部未完成，不伪造通过、不反复请求用户批准。

### 后续 Rust 阶段（明确未实现，不能被包装修复抹掉）

- [ ] Phase 2：剩余 host orchestration、配置、存储、durable admission/delivery、权限边界迁入 Rust；保留 Session/Location 所有权与显式 provider turn/replay 规则。
- [ ] Phase 3：ratatui TUI 重写并逐阶段验证行为对齐。
- [ ] Phase 4：plugin 兼容和相应发布/updater/signing 路径。#1394/#1425 仍是 Bun CLI + 提取 Rust engine 两进程包装，不是纯 Rust 单进程，也不代表 Phase 2–4 完成。
- [ ] 原清单还记录 MCP 长/带下划线身份在 native alias→product tool ID 桥接中的截断/有损风险；核对原任务接受范围与现有修复，不可未经验证删除。

## 6. 关闭窗口与孤儿进程结论

关闭的 context miao host PID 34813 及其 17 个子 engine 已退出，4096 端口已释放。此前剩余 17 个 engine 属于仍活跃的 embrix host PID 63986；该轮未发现 engine PPID=1。这是当时审计结果，不是永久证明。

#1411 修复 supervisor/timer 使已失效 engine 复活的问题，并加入 Unix parent watchdog；后续 `50500f36b3` 修复 sweep 快照覆盖并发 replacement 的竞态，真实 native 回归修前失败、修后 10 轮通过。#1417 修复 TUI 目录/project scope 丢失造成全局扫描；#1421 用只读 catalog 避免仅列会话就生成 engine；#1402 隔离未来 conformance DB。这些分别针对回收、并发所有权、枚举范围、启动机制与测试污染。

尚不能确认截图空白的唯一根因是 OOM/崩溃。0.3.6 曾因无效 native catalog identity 跳过 Session；#1399 已修复但原 stable 未包含。最终版本还需复核资源增长和窗口关闭后的存活情况。

## 7. 工作树、原始数据与接手入口

**根 checkout 是 `fix/engine-orphan-leak`，有原始 conformance 脏数据、notes/spec/mockups。不要 reset、clean、切 main 或全量 stage。** 这些不是待清空垃圾。

| 路径 | 用途 |
| --- | --- |
| `/private/tmp/miao-takeover-ledger` | #1409 文档工作树，本文件所在；只提交文档 |
| `/private/tmp/miao-release-engine-pairing` | #1425，最近 `7cdace8835`，干净 |
| `/private/tmp/miao-readonly-catalog` | #1421，最近 `2d71393c24`，干净；合并者可继续 |
| `/private/tmp/miao-app-context-l10n` | #1410 context/cache 历史 |
| `/private/tmp/miao-app-context-timeline` | #1413 估算组成图 |
| `/private/tmp/miao-catalog-scope` | #1417 scope 修复 |
| `/private/tmp/miao-owner-sweep-race` | #1411 race 修复的独立工作树 |
| `/private/tmp/miao-preview-integration` | 原 continuation 的组合验证工作树，先协调再动 |
| `~/.local/state/miao/takeover-2026-10-25.json` | 私有机器可读总账 |
| `~/.local/state/miao/recovery/2026-10-25/` | 初始 tracked patch/untracked、原会话记录、旧工作树审计备份 |

旧 detached `/private/tmp/miao-033-acceptance` 的 51 个变更已备份：46 个与已知 refs 相同，其余 5 个被 main 新实现覆盖；未发现独立丢失补丁，原文件没有删除。

原会话：Claude `6c05188a-d31a-4e2f-99dd-819010640856`；Codex `01a17289-2be3-7d42-81a3-43171216c11b`；Rust `ses_gfe5e8de7afd9ffewdy2rsSiMd`；context `ses_gfe5e8db8dcc1ffeWmHuyL3KE3`；orphan cleanup `ses_gfe5e8d4368c6ffeggzQpy8PJl`。原任务含继承 Session `ses_gfe5e8f2d2f3effeCmXgYMEbk4`，不要遗漏。

## 8. 验证与提交约束

每个 concern 单独短分支/PR；main 禁止直接提交/推送，CI 和审核通过后 squash。完整验证的变更及时 conventional commit/push，只 stage 自己路径。

测试和 `bun typecheck` 从对应 package 目录运行，不能从根跑测试/直接 tsc。改 public Protocol/HttpApi 后从 packages/client `bun run generate`；禁止手改 generated。重型 Rust/native 构建必须 SSH offload，主机详情读取私有 `~/.config/miao/AGENTS.md`，不写进公共仓库。

优先接手顺序：读两份 /tmp 实时 handoff → 确认唯一合并者与 R7 执行者 → 修 capabilities 解码 → 等/修当前 head CI 并按依赖合并 → 完成真实 ACP → 最终 main 完整配对产物验收 → 整理未完成外部条件和 Rust 后续阶段 → 满足用户发布门槛后发布。
