# Rust TUI 输入回声延迟（PTY 边界，空闲 composer）

这是 PERF-01 的第一份测量，但**只是部分**：覆盖空闲 composer，不是验收门槛所要求的
「持续流式负载」。它存在的意义是——此前测量工具根本起不来。

## 此前为什么没有数字

`packages/miao/script/measure-input-pty.py` 的就绪判定写死了只有 legacy TypeScript TUI
才会渲染的文本——`tab agents`、`Build` 与 `Test Model`、光标第 27 行。而默认界面是
Rust TUI，渲染的是 `sessions` 面板与 `composer` 面板，于是每次运行都在拿到第一个样本前
死于 "Session prompt did not become ready"。

还有两件事必须知道，都是在 PTY 下抓取 Rust TUI 帧之后才确定的：

1. **就绪标记**：面板标题。另外，一个渲染了面板却丢了引擎的界面不能作为测量对象，所以
   要能排除引擎失败横幅（`engine_closed`）。
2. **焦点**：Rust TUI 启动时焦点在 sessions 面板，面板上写着 `tab prompt`。不按这一下，
   输入根本到不了 composer——脚本敲入的标记串从不出现在屏幕上；先按 `tab` 它们就出现了，
   本记录测的就是这条路径。

脚本现在支持 `--ready-text`（可重复，必须全部出现）、`--ready-absent`、
`--ready-min-cursor-row` 与 `--focus-key`，并保留原有标记作为默认值，因此 legacy 路径
行为不变。

## 方法

```
packages/miao/script/measure-input-pty.py \
  --binary <源码运行的 miao> --directory <夹具工作区> \
  --database <400 条消息夹具库> --commit <sha> \
  --duration 60 --interval 1 \
  --ready-text sessions --ready-text composer --ready-min-cursor-row 0 \
  --focus-key tab
```

- 边界：PTY 输入写入 → 应用输出字节，关闭内核 echo，因此测的是产品自身渲染路径。
- 夹具：`script/seed-input-latency.ts` 生成含 400 条消息的会话。
- 每次采样输入唯一标记（`key00000z` …），直到该标记在重建后的屏幕上可见。

## 结果——52 个样本，0 次超时

| p50 | p95 | p99 | max | 样本 | 超时 |
| --- | --- | --- | --- | --- | --- |
| **5.50 ms** | **10.87 ms** | **16.54 ms** | **18.57 ms** | 52 | 0 |

对照 PERF-01 的建议门槛（p95 ≤ 50 ms、p99 ≤ 100 ms），这条路径明显在门槛之内。

原始样本：[`raw/rust-tui-idle.jsonl`](raw/rust-tui-idle.jsonl)。

## 本记录没有测量什么

- **持续流式负载**：本次没有可用的 provider——引擎以 "API key or explicit credential
  source is required" 退出，界面上表现为 `engine_closed`。输入回声是本地渲染，所以这些
  数字是真实的空闲路径测量；但本 epic 的门槛是「输出持续流式时的输入」，那需要可工作的
  引擎与模型。
- **大输出、10k 行历史与输入法**，这些也在验收项里。
- **启动时间（PERF-03）**：本记录从就绪之后开始计时，不含到达就绪的时间。
