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
