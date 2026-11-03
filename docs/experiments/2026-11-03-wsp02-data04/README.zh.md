# 2026-11-03 WSP-02 vcs 全链路测量 + DATA-04 blob 外置

两条 roadmap 腿、一个分支（`feat/wsp02-vcs-whole-path`），各答一个验收问题。
测量腿量的是大 `vcs_status`/`vcs_diff` 答案的全链路耗时——git、解析、wire、
解码、渲染——因为只让单个 git 原语变快并不证明操作者的等待变短。DATA-04 腿
把超大的事件 payload 移到内容寻址文件，并给出带可重复磁盘曲线的显式 GC。

## 腿 1 — WSP-02 项 3：全链路数字

Harness：`crates/miao-engine/tests/vcs_scale.rs`（engine 层，合成 5000 文件树 +
3350 条混合改动：3000 modified、100 staged 后再改、20 个纯 `git mv` 改名、
30 删除、200 个落在已跟踪目录里的 untracked）与
`crates/miao-tui/tests/vcs_latency.rs`（真 TUI 走真 wire 对脚本 engine，
答案放大到 3300 条；leader 和弦到文件数上屏为端到端样本，paint/decode 单列基线）。

Engine 层，release，macOS 构建机（M4，macOS）：

| 场景          | engine p50/p95 ms | 裸 git p50/p95 ms | engine 份额 p50 ms | 答案字节 |
| ------------- | ----------------- | ------------------ | ------------------- | -------- |
| status 3350 条 | 60 / 70          | 53 / 70            | ~7                  | 298,648  |
| status 50 条   | 32 / 37          | —                  | —                   | 4,821    |
| diff 单文件    | 33 / 48          | 33 / 36            | ~0                  | 226      |

三倍于答案上限的 patch 被立即拒绝并给出截断事实
（`an_oversized_diff_refuses_instead_of_stalling`），而不是流式吐出整个 patch。

结论：git 原语占全链路的绝对大头；engine 自身份额（解析 + JSON 构建）在
3350 条下保持个位数毫秒，答案以单个 310 KiB wire 帧传输。

TUI 层数字与磁盘曲线在 `raw/`。

## 腿 2 — DATA-04 项 1 + 3：blob 外置与 GC

设计在 `crates/miao-engine/src/blob.rs`：超过 64 KiB 的字符串值移入
`<ledger 同目录>/blobs/<sha256[..2]>/<sha256>`，行内以
`{"blob": ..., "bytes": ...}` 引用占位。相同文档共享一个文件——这正是要点：
真实 1.2 GB ledger 把同一份权限规则表复制到 26k 条 provider 请求上，
附件在 admitted/promoted 两条事件里各存一份。

- 写路径：外置发生在 append 内部，blob 根目录从连接自身的 ledger 路径推导
  ——75 个 append 调用点一个没改。返回的 Event 已 rehydrate，广播与进程内
  读者永远看到原文。
- 读路径：三个把事件交给消费者的组装点（`events`、`latest_event`、export）
  rehydrate。用 `json_extract` 深入 `data` 的 SQL 消费者（cron、usage、权限
  投影）只碰小字段，小字段按构造保持 inline。Session 迁移走 export
  （已 rehydrate），迁移出去的会话自包含。
- blob 文件缺失时引用原样留在原地：读者看到事实而不是失败，gc 报告点名缺口。
- GC：`miao db blob-gc` 经一个只读快照扫描 ledger 的引用，然后移除无引用的
  文件——与 vacuum 相同的 dry-run / `--apply` 契约。崩溃遗留的 staging 写
  在同一次遍历中回收。

真实 ledger 排练（1.24 GB 生产库的只读副本）：

- 超 64 KiB 的事件行约 116 MB，其中 91% 被字符串值阈值覆盖（附件 base64）。
- 对真实库 `blob-gc` dry run：0 引用、0 孤儿——空转，外置尚未发生时这就是
  正确行为。

测试证据随分支：单测覆盖 roundtrip、去重、缺文件防御、GC 保活引用、dry run
不删任何东西；集成测试覆盖行收缩到 200 字节内引用且读回全文、截断 + gc 恰好
移除孤儿、10 轮磁盘曲线（10 份重复的 128 KB 规则表收敛为 1 个文件，ledger
保持在 inline 体积一半以下）。
