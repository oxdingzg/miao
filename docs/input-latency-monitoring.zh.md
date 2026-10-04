# 监控阻塞路径修复，2026-10-04

[English](input-latency-monitoring.en.md)

实现提交：`16cb4a0f7`（`perf(miao): make monitoring probes and writes asynchronous`）。本次消除了已确认存在的阻塞代码路径，但没有据此认定原始同步 GC 的业务分配来源。

## 改动

- `ps`、`sysctl` 改为异步执行，保留原有五秒超时。
- FD 目录读取、DB/WAL 文件 stat 改为异步。
- 监控写盘、轮转、启动时留存清理改为异步；同步与异步诊断写入共享租约及留存策略。
- 同时仅有一份采样在途，重叠定时器记录为 `skippedSamples`，不积累无限采样队列。
- 每个窗口读取 mean/P95/P99/max 和样本数后 reset；`loopWindowMs` 记录真实窗口长度，不假定它总等于名义间隔。
- 新增 `probeMs`、`isolate`、`threadId`。RSS 与进程 CPU 仍属于整个进程，不能将两个 isolate 的记录相加。
- 空窗口的延迟为 null；histogram 百分位桶可能比真实 max 略大。

## 验证

- `packages/core` 诊断存储测试：**8 项通过**，覆盖轮转、配额、保护无关文件，以及同步/异步写入的租约互斥。
- `packages/miao` typecheck 通过；监控回归：**1 项通过、16 个断言**。真实子进程中的 OS 探测故意延迟 500ms，主线程心跳仍能继续；测试以实际记录出现为就绪信号，验证采样重叠抑制和窗口指标。
- 原生 histogram 校准：[monitor-calibration-2026-10-04.json](monitor-calibration-2026-10-04.json)，Bun 1.4.2。故意阻塞 90ms 后采样 max 为 85.766ms；reset 后 count 为零；随后空闲窗口 max 为 2.018ms。这是监控校准数据，不是按键回显延迟。

在一次性进程中复现校准：

```sh
bun packages/miao/script/monitor-calibration.ts
```

## 尚未完成

仍需补输入接收/状态/输出时间关联、分配归属、固定工作负载长会话比较，以及 30–60 分钟生命周期/内存曲线。尚不能宣称输入 P95/P99 已改善、内存泄漏已修复，或 GPU 已被归因为主因。原始采样及其 SHA-256 清单保持原样。
