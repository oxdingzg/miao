# miao 响应与执行速度：离线日志基线

目标：在改善任务正确率的同时，减少请求前等待、总任务耗时和 token 消耗。先测量，再决定优化项。

## 使用

工具仅读取日志，不调用模型、不修改运行时或数据库：

```sh
bun packages/script/src/baseline.ts --help
bun packages/script/src/baseline.ts --since 2026-10-06T00:00:00Z --until 2026-10-06T03:11:46Z
bun packages/script/src/baseline.ts --log /path/to/miao.log --model provider/model --run RUN_ID --json
```

默认读取 `${XDG_DATA_HOME:-$HOME/.local/share}/miao/log/miao.log`，与当前 Global 的数据路径一致。支持重复 `--log`、精确 `--model` / `--session` / `--run` 和包含端点的 ISO 时间范围。重叠日志文件会重复计数，请只传不重叠的文件。无匹配记录或无效时间范围会失败退出。

输出各指标的有效样本数、mean、p50/p90/p99/max，以及模型 × warm × cache 原因分层。没有上报的值是缺测，不补零。snapshot 总耗时先逐 step 求和，再计算分布。

## 指标语义

来源：`packages/core/src/session/runner/llm.ts` 的 `session.turn`；格式由 `packages/core/src/observability/logging.ts` 定义。

- **preRequestMs**：本次尝试开始到请求发出前的等待，包括本地准备和可能的集成/鉴权等待，不全是 CPU。
- **ttftMs**：请求发出到首个流事件，不保证是首个可见文字。网络、provider 排队与 prefill 混在其中，无法进一步分离。
- **turnMs**：本次 provider step 的整体墙钟时间，包含本地准备、流处理和工具执行。不能称为纯 provider 耗时，也不能直接当用户任务总耗时。
- **toolsMs**：工具集物化耗时，**不是工具执行耗时**。
- **startSnapshotMs**：请求前快照；**endSnapshotMs/filesMs**：结束快照和 diff，在 step 结束路径。
- **cacheHitRatio**：逐 step 比例。报告 mean 是非加权平均；warm 是运行时的本地热窗口判断，不能等同 provider 缓存命中。
- **tokens**：原样分别累计 input/output/reasoning/cache.read/cache.write，不跨 provider 推算统一 prompt 总量或账单。

只统计成功落下 `session.turn` 的 step。失败、中断和未结算的调用不会进入本分布，因此这不是完整成功率或可靠性报告。

## 探索性样本（2026-10-06）

读取上述 UTC 时间区间内的实际使用日志，共 **894 个已完成 step、11 个 Session**。多模型、多任务、多运行批次混合；日志缺少完整版本/机器 provenance，因此以下只用于寻找排查方向。

| 指标                       |      p50 |       p90 |        p99 |
| -------------------------- | -------: | --------: | ---------: |
| 请求前等待                 |   170 ms |  1,762 ms |  28,289 ms |
| 请求到首个流事件           | 2,436 ms |  5,125 ms |  40,518 ms |
| step 墙钟耗时              | 7,807 ms | 31,679 ms | 543,083 ms |
| 前快照                     |    34 ms |    234 ms |   1,658 ms |
| 后快照                     |    40 ms |    270 ms |   3,016 ms |
| diff                       |     9 ms |     77 ms |   1,072 ms |
| 快照总耗时（逐 step 相加） |    85 ms |    638 ms |   6,267 ms |
| 模型解析                   |    96 ms |    872 ms |   7,198 ms |
| 历史加载                   |     2 ms |     26 ms |     207 ms |
| 工具集物化                 |     0 ms |      4 ms |      43 ms |

初步解读：

1. 常态本地等待不是几秒级，但长尾明显。模型解析与快照均值得查，尚无证据认定快照是唯一或最大瓶颈。
2. 首事件耗时按模型差异明显，不能用混合平均值评价 miao 的本地执行效率。
3. 极端墙钟样本可能包含长工具执行、系统休眠或资源争用；仅凭本报告无法归因，不能直接提出“可节省百分比”。
4. 不能叠加各子阶段的 p50，或用 p50 的比值推断每步占比。

## 受控验证方案

每组固定代码 commit、二进制 channel、机器、provider/model、配置、初始仓库状态和任务；记录这些 provenance 在独立实验记录中，以 `--run` / `--session` 提取。分别统计冷读与 warm。顺序交替 A/B，并预先规定重复次数，防止只选择最快样本。

建议任务集：

| 任务                 | 目的             | 验收                                |
| -------------------- | ---------------- | ----------------------------------- |
| 小型仓库问题回答     | 只读准备与检索   | 答案有正确文件/符号依据             |
| 单文件明确修复       | 编辑效率         | 预设回归检查通过，diff 范围符合要求 |
| 多文件缺陷定位与修复 | 总任务耗时与返工 | 独立验收通过，记录尝试数            |
| 多工具/MCP 检索      | 定义披露收益     | 同等信息完整度、工具选择正确        |
| 长会话继续任务       | 压缩与缓存       | 约束保留、重复读取次数和验收结果    |

两种成本都要记录：**每次尝试 token/耗时**以及**每个通过验收的任务 token/耗时**。并行子代理的 wall-clock 与总 token 分开；不以“step 更少”冒充“任务做得更好”。

## 仍需单独测量

- 工具定义 token 占比（请求 tools 字段的模型相关 token 测量）。
- 提交到 provider、提交到首个可见文字、启动到可输入、UI 输入/滚动延迟。
- 工具执行独立计时与关键路径、权限等待。
- 完整失败/中断率、总任务 token 和独立验收通过率。

以上缺测项未由现有日志推算。下一轮优化优先从不损害验收质量的本地长尾入手；是否采用工具延迟披露、自动记忆或模型分类器，应通过任务级 A/B 决定。

## 第二轮：已选模型的定点解析（2026-10-06）

对同一 UTC 范围的日志再提取，本轮读取 894 个已完成 step（两个 run）。在请求前等待超过 1 秒的 150 个 step 中，对已记录的 resolve/requestBuild/startSnapshot/history/compact/small/tools 阶段逐行比较，136 个的最大值是 resolveMs。14 个 step 的请求前等待超过 10 秒；其中一些样本的多个阶段同时变慢，不能据此认定单一根因。这些子阶段也不覆盖完整等待路径。

代码核查发现一个可独立消除的工作量：`SessionRunnerModel.resolve` 对已有明确模型选择的 Session，仍调用 `catalog.model.available()`，投影并排序整个模型目录，最后才查找一项。修改为 `catalog.model.getAvailable(providerID, modelID)`：

- 只读取该 provider/model，沿用既有可用性判断。
- 仍合并 provider/model 配置，并实时检查启用状态、integration 与凭据。
- 不缓存解析结果；每轮配置变化、禁用和凭据撤销仍生效。
- 没有显式模型选择时保留原来的默认模型/可用模型回退路径。

### 受控局部测量

在同一台工作站、Bun 1.3.14、相同目录构造和 Session 下，直接调用真实 `SessionRunnerModel.Service.resolve`。目录由 100 个额外 provider 各 25 个模型以及 1 个选中模型组成，选中 provider 使用配置 API key；经过 5 次预热后采样 40 次，不发起模型网络请求。

| resolver 实现                |      p50 |      p90 |      p99 |
| ---------------------------- | -------: | -------: | -------: |
| 修改前：全目录投影/排序/查找 | 20.55 ms | 22.61 ms | 29.17 ms |
| 修改后：定点查找             |  0.33 ms |  1.95 ms | 12.22 ms |

修改前后的样本不是交替采样，长尾会受系统争用和 GC 影响；结果用于证明不必要的目录规模相关开销可被消除，不作为服务延迟 SLA。常规真实使用日志中的 resolve p50=96 ms 还包含其他等待，不能直接用本表替换。也不能声称首字、总任务耗时或验收通过率已取得同样幅度的改善。

复现（从包目录执行；该性能测量默认不开启）：

```sh
cd packages/core
MIAO_BENCHMARK_CATALOG=1 bun test test/session-model-lookup.test.ts
```

该文件还通过真实 Catalog/Integration/Credential 服务验证配置覆盖更新、模型/provider 禁用或移除、凭据创建与撤销、可选鉴权及 SDK settings key。正确性测试不设置墙钟阈值。

下一步需补足运行时精细计时，区分模型目录选择、integration 查找、凭据解析/刷新以及事件循环争用，再评估剩余 resolve 长尾。

## 第三轮：删除同次 integration 调用的重复凭据读取（2026-10-06）

核查发现 `Integration.get` 和 `Integration.connection.active` 在健康的已有凭据路径中，各调用两次 `Credential.list`：第一次判断是否需要 legacy OAuth 迁移，第二次取同一 integration 的凭据用于投影连接。两次调用都执行真实 SQLite SELECT 和凭据 Schema 解码。

修改只复用**同次调用**的首个读取结果：已有凭据时直接返回；缺失凭据时仍尝试迁移并再次读取。没有跨调用缓存，后续调用继续观察凭据更新、删除、重新创建；`connection.resolve` 仍按 ID 独立读取，避免使用之前拿到的失效凭据。环境变量 fallback、旧 OAuth 文件迁移、刷新逻辑保持原路径。

### 真实 tracing 和局部基准

使用原生 Effect tracer 观察真实服务，不替换 DB/文件系统实现。每条 `get → active → resolve` 链路的凭据查询次数如下：

| 操作                                   | 修改前 | 修改后 |
| -------------------------------------- | -----: | -----: |
| Credential.list（每次对应一条 SELECT） |      4 |      2 |
| Credential.get（每次对应一条 SELECT）  |      1 |      1 |
| 合计                                   |      5 |      3 |

在相同工作站、Bun 1.3.14、隔离的内存 SQLite 中，用一个已存 API key 的 integration 做 10 次预热、100 次链路调用。修改前后分别单独运行同一个 benchmark（不运行其他测试），结果如下：

| 实现   |      p50 |      p90 |      p99 |
| ------ | -------: | -------: | -------: |
| 修改前 | 0.425 ms | 0.543 ms | 2.550 ms |
| 修改后 | 0.276 ms | 0.386 ms | 2.392 ms |

这是约 0.15 ms 的局部中位数差异。凭据查询次数的减少是确定性结果；时间差异仅为这组样本的观察，不代表磁盘数据库、OAuth 刷新或整个任务取得相同改善，也未证明真实使用的秒级长尾已解决。系统资源争用仍需独立测量。

复现：

```sh
cd packages/core
MIAO_BENCHMARK_CREDENTIALS=1 bun test test/integration-credential-lookup.test.ts --test-name-pattern benchmarks
```

正常测试运行不启用性能采样。回归检查涵盖同次调用查询次数、后续凭据更新/撤销/重新创建，以及旧 OAuth 凭据迁移后必要的二次读取；不设置墙钟阈值。

## 第四轮：减少长历史材料化的 CPU 工作（2026-10-06）

### 卡顿相关证据

现有 monitor 已按进程/isolate 写入 CPU、RSS、系统负载和事件循环延迟；无需再增加一个采样器。读取 `log/monitor/*.jsonl*` 的历史样本发现如下异常窗口：

| 样本时间（UTC）         | 窗口内 loopMaxMs | loopWindowMs | 同期系统 load1 |
| ----------------------- | ---------------: | -----------: | -------------: |
| 2026-10-06 01:48:50.110 |         96,444.8 |       98,297 |          63.01 |
| 2026-10-06 01:54:21.670 |        119,252.4 |      144,962 |          53.36 |

这些样本的 header 标记 `loopStats: window`，不是全进程累计峰值。它们与前述多阶段同时变慢的历史发生在同一时间段，说明本地调度/资源争用值得重点调查。系统 load 不是 CPU 百分比；事件循环延迟还可能受到休眠、同步代码、GC 等影响。尚未把样本精确关联到同一个 Session/step，不能据此断言具体根因或把所有首事件等待归因于 provider。

### 可独立验证的请求构建热点

`materializeBlobRefs` 每轮准备 provider 历史时，对每条工具输出的 `structured` 数据逐字段执行 Effect 遍历并复制，哪怕完全没有 `contentRef`。在多条 grep/read 等结果组成的历史中，会重复构造大量 Effect 和输出对象。

改为先用迭代栈扫描：

- 无引用的普通结构化 JSON 直接沿用输入数据，不逐字段构造 Effect 或复制。
- 找到 `contentRef: true` 且 `content` 为字符串时，继续执行原来的完整还原路径。
- 非 JSON 对象保留旧的字段归一化路径。
- 迭代扫描避免深层 JSON 的递归调用栈溢出；没有增加跨轮缓存或 blob 保留期。

### 受控局部测量

相同工作站和 Bun 1.3.14，构造 100 条 assistant 工具历史，每条含 100 个结构化匹配项，总计 10,000 项。使用真实 Blob 服务与 `materializeBlobRefs`，不调用模型；5 次预热后采样 20 次。目录、历史构造均在计时区间外。

| 实现   |      p50 |      p90 |      p99 |
| ------ | -------: | -------: | -------: |
| 修改前 | 39.18 ms | 46.41 ms | 52.00 ms |
| 修改后 | 2.45 ms | 4.12 ms | 5.11 ms |

这组样本的中位数减少约 36.7 ms。它是构造的引用缺失历史的局部微基准，不是实际任务端到端 A/B；前后并非交替采样，也未测量 GC、UI 输入/帧延迟或高资源争用下的尾延迟。引用密集的历史需要额外扫描，尚未量化该路径的增量成本；因此不能把此表外推到所有历史，或宣称数十秒停顿已解决。

复现：

```sh
cd packages/core
MIAO_BENCHMARK_MATERIALIZE=1 bun test test/session-runner-materialize.test.ts --test-name-pattern benchmarks
```

回归测试覆盖无引用数据的保留、嵌套有效/缺失 blob、原始历史不被修改、非 JSON 对象旧语义，以及 10,000 层无引用 JSON。常规测试不启用性能采样，不设置时间阈值。
