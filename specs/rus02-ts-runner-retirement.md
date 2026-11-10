# RUS-02：TS runner 退役边界与调用方清点

状态：**退役完成（2026-11-11，RUS-02 第 3 步执行）**。清单冻结源码为 `2e2d428e8e5417a1d67c5b15e19ddc7e2c5df7d0`：runner 边界 0/0（源码/验证），总边界 240 → 184，`session/runner/` 与 `execution/local.ts` 已删除；`location-services` 将 SessionExecution 绑定到 no-op 执行器。历史基线：296（10-28）→ 319（11-04）→ 312（11-10）→ 240（第 2 步后）→ 184（第 3 步后）。

## 1. 可复核清单

[逐文件依赖清单](../docs/experiments/2026-10-28-ts-runner-retirement/imports.json) 保存每条依赖的调用方文件、行号、目标、导入方式、是否仅类型导入和源码/验证分类。包含所有 tracked `packages` TypeScript 文件中，指向下表边界的字面量 import、export 和动态 import；解析相对路径及 `@miao/core/*`，排除模块自己的 namespace 自导出。

这是一份静态导入边界清单。导入不等于运行时执行；Effect DI 绑定、服务方法调用、计算出的模块名、`require()` 和第三方消费者仍需结合源码审查。`typeOnly: false` 也不证明模块产生执行副作用。

| 边界       | 源码依赖条数 | 验证依赖条数 | 定义范围                                                        |
| ---------- | -----------: | -----------: | --------------------------------------------------------------- |
| runner     |           11 |           15 | `session/runner/` 的 10 个文件                                  |
| execution  |           19 |           29 | `session/execution.ts` 与 `session/execution/`                  |
| scheduling |           16 |           10 | `run-coordinator`、`schedule`、`delegation`、`delegation-store` |
| inbox      |           26 |           17 | `session/input`、`session/admission`                            |
| permission |           64 |           66 | `permission.ts` 与 `permission/`，不包括 V1 permission          |
| placement  |           23 |           16 | `session/routing.ts`、`engine-placement.ts`                     |

合计 312 条导入边界（2026-11-10 复算；11-04 为 319 条）。`runner` 的入边减少最多（源码 25 → 11、验证 33 → 15），说明这个目录已经收缩成叶子；`permission` 的入边增长（44 → 64），是因为更多产品路径改从它就位而不是从 runner。数字变化本身不是退役，只是把「还连着谁」重新算对。一份文件可以落入多个边界，因此这些数字不是独立调用方数量。重新清点时在仓库根目录运行：

### 1.1 生产耦合只剩两处

按目标文件统计 runner 目录的入边（同一份清单，2026-11-10）：

| runner 文件            | runner 外的源码引用 | runner 外的测试引用 |
| ---------------------- | ------------------: | ------------------: |
| `llm.ts`               |                   1 |                   3 |
| `index.ts`             |                   1 |                   3 |
| `first-byte-guard.ts`  |                   0 |                   1 |
| `max-steps.ts`         |                   0 |                   0 |
| `metrics.ts`           |                   0 |                   1 |
| `model-io.ts`          |                   0 |                   1 |
| `output-guard.ts`      |                   0 |                   2 |
| `provider-retry.ts`    |                   0 |                   1 |
| `publish-llm-event.ts` |                   0 |                   2 |
| `tool-input-guard.ts`  |                   0 |                   1 |

唯一的两个生产引用是 `packages/core/src/location-services.ts:36 → runner/llm.ts` 和

**已完成（2026-11-11，RUS-02 第 2、3 步）**：上表与两条生产边已随删除 PR 全部
消失——`runner/` 十个文件、`execution/local.ts` 不复存在，静态清单 runner 边界
0/0；存储层单活 run 语义由 `single_active_run` 测试钉死
（`docs/acceptance/2026-11-10-g1-single-execution-authority.md`）。
`packages/core/src/session/execution/local.ts:7 → runner/index.ts`。其余 8 个文件只被
`llm.ts` 内部使用或被测试引用。

因此删除顺序只能从这两条边入手，而不是从叶子文件开始：

1. 先让 `execution/local.ts` 不再需要 `runner/index.ts` 的类型（错误契约迁到
   `session/error`），再删除 TS drain 本身。
2. 再拆 `location-services.ts` 对 `runner/llm.ts` 的装配。
3. 这两条边断掉之后，`llm.ts` 与它的 8 个叶子文件才成为可删的整体。

在 TS drain 仍被 `miao-dev`（`bun run ./src/index.ts`）启动的前提下，第 1 步会同时决定
开发入口的去向：要么开发入口改用 Rust engine，要么这一批删除必须等它退役。

### 1.2 复核后的更正（2026-11-04）

上面那段前提已经过时：`miao-dev` 现在是 Rust 启动器（直接运行
`$HOME/.local/share/miao/native/miao`，TUI 与 engine 同进程），发行版同样是
`crates/miao-cli` 一个二进制。TS drain 在产品与开发路径上都没有消费者了，它的装配方
只剩 TS 产品栈自己：

| 装配方      | 位置                                                     |
| ----------- | -------------------------------------------------------- |
| Location DI | `packages/core/src/location-services.ts:39`、`:167`       |
| runtime     | `packages/miao/src/runtime/host.ts:70`                    |
| TS server   | `packages/miao/src/server/server.ts:9`、`:166`            |
| TS CLI      | `packages/miao/src/cli/cli-runtime.ts:24`、`:58`          |
| HTTP routes | `packages/server/src/routes.ts:23`                        |

所以 RUS-02 的真实范围不是「删 `session/runner/` 目录」，而是「退役整套 TS 产品栈」：
`packages/cli`、`packages/miao`、`packages/server`，以及 `packages/core` 的执行路径。
在这个范围里还有一处产品外依赖必须先解开——CI 仍用 TS 入口做沙箱验收：

- `.github/workflows/native.yml:73`、`:124`、`:197` 运行
  `bun src/index.ts __sandbox-run`。沙箱实现本身已在 `crates/miao-native` 与
  `crates/miao-sandbox`，所以这一步是换载体，不是改行为。

修订后的顺序：

1. 把 `native.yml` 的沙箱验收从 `bun src/index.ts __sandbox-run` 换到 `crates/miao-native`
   的 `miao-run`。
2. 删除 TS 产品栈的入口与装配（`packages/cli`、`packages/miao`、`packages/server`），
   `location-services.ts` 的 `SessionExecution.node` 装配随之下线。
3. 前两步完成后，`execution/local.ts → runner/index.ts` 与
   `location-services.ts → runner/llm.ts` 两条边自动消失；`llm.ts` 与 8 个叶子文件作为一个
   整体删除。每批单独开 PR，跑 `bun typecheck` 与相关 `bun test`。


```sh
bun docs/experiments/2026-10-28-ts-runner-retirement/generate.cjs
```

生成结果绑定运行时的 HEAD；跨版本复核应在对应 checkout 执行。生成器只读取 tracked 源码和提交号，写入同目录的 `imports.json`，不访问用户 Session、数据库或 provider。

## 2. 执行与调度

- `core/src/session/execution/local.ts` 是实际 TS drain：`SessionRunCoordinator.make` 的 drain 先 `requireTypeScript`，再按 Session 的 Location 获取服务并调用 `SessionRunner.Service.run`。`wake` 对 Rust placement 返回；`resume` 也要求 TS placement。不能把公共 `SessionExecution` 接口的存在解释为 Rust Session 在 TS 中运行。
- `core/src/location-services.ts` 仍装配 `SessionRunnerLLM.node`、`SessionRunnerModel.node`；CLI、Server assembly 与 Location scope 仍绑定 `SessionExecutionLocal.node`。退役要同时检查组合根，不能只删除 `llm.ts` 的调用点。
- `core/src/session.ts` 暴露 TS Session 的 prompt/resume/status；`session/peer-tools.ts`、`session/delegation.ts`、`tool/background-task.ts`、`tool/bash.ts`、`tool/monitor.ts` 与 `tool/schedule.ts` 仍通过共享服务调度、等待或唤醒。
- `session/schedule.ts` 的任务是进程内、非 durable；触发时发布 `NotificationAdmitted`，再 advisory wake。替换它必须保留机器通知与人工输入的区别，不能在退役中顺便引入重启后自动重试 provider。
- `miao/src/engine/product-tools.ts` 仍可使用这些产品服务，`native-engine.ts` 仍依赖 `SessionExecution`。原生执行器与宿主工具桥的责任要分别验收。

## 3. inbox 与 placement

- `core/src/session/admission.ts` 的默认 layer 仍直接调用 `SessionInput.admit/cancel`；`miao/src/engine/admission-binding.ts` 负责绑定产品替代实现。
- `miao/src/engine/admission.ts` 遇到 `MIAO_INPUT_TS_ADMIT=1`、缺 native transport 或缺 engine target 时，仍回到 TS writer；正常 engine 准入明确传 `resume: undefined`，TS-owned 执行由自己的 runner 消费投影。不能把这个开关解释为现有 Rust Session 自动转为 TS；`requireTypeScript` 的写入保护仍成立。
- `miao/src/engine/product-tools.ts` 在 admission 服务不存在时也提供直接 TS admission fallback。删除前需要逐一证明生产组合根提供 owner-aware 服务，且原生 peer 工具与 TS 兼容模式行为有对应覆盖。
- `session.ts`、`heal`、`placement`、`peer-tools`、`delegation`、`runner/llm` 是输入或 continuation 消费方；`projector`、`input-projection`、`context-epoch`、`blackbox-history` 仍读取或维护历史投影。表的读取、回放、导出需求不能随 runner 一并删除。
- `session-create`、`routing`、`engine-placement`、migration/reverse-migration/move coordinator 与 transfer bundle 保留已有数据的所有权判定。`--engine ts` 通过显式空 `MIAO_ENGINE_STORAGE` 关闭本次调用的默认 native storage；已有 placement 仍由 durable binding 决定。
- SDK remote-control、Server middleware/routes 和 CLI session 管理命令也引用这些接口。它们必须列入删除 PR 的检查范围；不只验证默认 TUI。

## 4. 权限不是 runner 私有能力

`PermissionV2` 仍被工具、MCP、技能、插件、shell approval、SDK、Server permission handlers 与原生 product tools 使用。`PermissionSaved` 则由 `miao/src/engine/product-permission.ts` 转换成当前项目的 native saved rules。原生 journal 审批回复和 TS 的 pending request 不是可互换的存储。

因此删除 TS runner 不授权删除 `permission.ts` 或 saved-rule 存储。先逐项迁移宿主工具 ask/reply、拒绝、always-allow 和 Location 作用域，保留可选宿主工具及 API 客户端需要的服务；客户端不能重新成为权限权威。完整逐文件名单见清单的 `permission` 类。

## 5. runner 目录中的共享能力

| 文件                   | runner 目录外的实际消费者                                                           | 退役处理                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `model.ts`             | Location composition、`session/native-title.ts`、`miao/src/engine/native-engine.ts` | 实现已在 `session/model.ts`；`runner/model.ts` 兼容壳已删除。native 启动依赖保留在 `session/model.ts`，不是 runner 入口 |
| `cost.ts`              | `miao/src/engine/bridge.ts`、`server/src/native-session.ts`                         | **已迁出**至 `session/cost.ts`；`runner/cost.ts` 兼容壳已删除            |
| `materialize-files.ts` | `core/src/session.ts`                                                               | **已迁出**至 `session/materialize-files.ts`；`runner/` 兼容壳已删除      |
| `index.ts`             | Session 公共错误类型、execution 接口、local runner                                  | 在独立 PR 解开类型/服务耦合，再删除 TS 执行接口                         |
| `provider-headers.ts`  | `session/native-title.ts`（runner 外）                                              | **已迁出**至 `packages/core/src/session/provider-headers.ts`；runner 改为从该处导入 |
| 其余 runner 文件       | **逐文件实测见下表**（原先概括为「主要由 `llm.ts` 与 runner 内部消费」，经复核不成立） | 以实测消费者为准，随 TS loop 分批退役                                   |

实测方法（基线 `4d887a1337`）：对每个 runner 文件统计 `packages/` 与 `apps/` 下、runner 目录之外的导入者。结果：

| 模块                | runner 外的消费者                                        | 性质     |
| ------------------- | -------------------------------------------------------- | -------- |
| `llm.ts`            | `core/src/location-services.ts`、3 个测试                 | **生产** |
| `to-llm-message.ts` | 原为 `core/src/session/side-question.ts` + 1 个测试        | **已迁出**至 `session/to-llm-message.ts` |
| `index.ts`          | `core/src/session/execution/local.ts`、3 个测试           | **生产** |
| `max-steps.ts`      | 无                                                       | —        |
| 其余 7 个模块       | 仅测试（`first-byte-guard`、`metrics`、`model-io`、`output-guard`、`provider-retry`、`publish-llm-event`、`tool-input-guard`） | 仅测试 |

结论：`provider-headers` 与 `to-llm-message` 迁出后，runner 目录之外真正的**生产**耦合只剩两处（`location-services` → `llm`、`execution/local` → `index`）；
其余模块的消费者都是测试。退役顺序应按这三处推进，而不是按「runner 内部消费」的概括判断。

注：本表上一版把 `provider-headers.ts` 归入「其余 runner 文件」，与事实不符——它当时已有
runner 外的消费者（`session/native-title.ts`）。这也是为什么该行单独列出：清单本身需要
按代码复核，不能只按目录推断。

## 6. 分 PR 顺序与删除门槛

1. 先迁出被原生产品使用的共享能力，各 PR 保持两种 placement 的行为不变。
2. 对齐组合根与宿主工具桥的 admission/execution 依赖，补齐当前版本的真实客户端、数据迁移及反向恢复记录。
3. 明确发布版本和回滚观察窗口的起止与通过证据；当前没有从既有记录推导出一个已结束的窗口，不能猜定日期。
4. 窗口通过后，单独删除 TS provider loop 与对应 DI 绑定，再分别删除默认 TS admission 和 placement fallback。每次删除同时核查清单中的源码、验证与外部 API 消费方。
5. 最后处理旧投影表、迁移命令和配置开关。历史导出、旧 Session 的可读性、许可与迁移说明先保留，数据删除另行设计。

现有 [S2](s2-single-inbox.md)、[S3](s3-placement-collapse.md)、[S4](s4-storage-merge.md) 描述已完成的切片；[产品验收矩阵](../crates/miao-engine/docs/product-acceptance-matrix.md) 和 [客户端验收记录](../crates/miao-engine/docs/client-acceptance-2026-10-24.json) 是门槛线索，旧版本记录不能直接关闭本次验收。RUS-02 当前仅提供清点与退役边界，不关闭整项任务。

## 7. 本次核验

冻结版本的 routing、engine-placement、run-coordinator、permission-decide 四个既有实际实现测试文件共 52 测试、124 断言通过。此结果验证既有所有权、调度和权限边界；没有执行真实客户端迁移或声明删除后验收。生成器复跑与清单一致，格式和文档链接检查通过。

## 8. 共享错误合同解耦

SessionV2 与 SessionExecution 的公开 resume 类型改用已有 `session/error.ts` 中的
`ExecutionError`，不再为了错误联合类型依赖 `session/runner/index.ts`。联合成员保持
一致，runner 继续导出兼容的 `RunError` 名称。此项只移除两个公共接口到可退役入口的
类型耦合，不改变运行时调度、错误标签或 legacy runner 的服务绑定，也不声明启动
性能改善。后续删除 runner 入口时仍需处理实际 local 执行层及其测试。
