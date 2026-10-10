# 准确性验收机制

Rust engine 的目标是让 miao 更好用。这里检验用户可观察的结果、可靠性和权限契约；TS 参考实现是辅助证据，不是规定 Rust 必须逐行复制的规范。

## 四层证据

| 层次 | 测试 | 检验内容 |
|---|---|---|
| 产品结果 | `tests/accuracy.rs` | 实际读到原文、补丁修改正确、无关文字保留；拒绝写入不改变文件；replay 与完整 ledger 相同 |
| Golden / 工具契约 | `tests/accuracy/*.json` | 正常与拒绝场景的生命周期顺序；只读和 workspace 模式实际暴露的工具 input schema |
| 独立队列模型 | `tests/accuracy.rs` | 12 个固定种子，每个 128 步；混合 steer/queue、重复提交、冲突提交与不同 idle 边界，检查投递顺序、幂等、无丢失/重复及 projection |
| 共享语义差分 | `tests/differential.rs` | 42 个 patch 案例；TS `parse` + **纯 TS `deriveTs`** 生成 reference，Rust 执行后比较真实文件集合与内容；另有 6 个拒绝/无部分副作用场景 |

Golden 去掉 UUID、时间戳和 checkpoint 等非稳定字段，仅保留本轮选择的生命周期及工具身份。它不是整个协议的兼容性承诺；工具 schema 锁定目前覆盖只读和 workspace 文件工具，新增 capability 模式应补相应快照。

## 差异的处理

语料中的 `reference` 是 TS 算出的结果，禁止用 Rust 输出覆盖它。`contract` 则记录有意不同的 Rust 产品契约及理由：

- 新建文本文件补末尾换行。
- 更新已有文件保留它原来的末尾换行约定。
- 当前严格 patch API 不支持 `Move to`，应拒绝且无副作用。这里记录能力边界，不宣称拒绝 move 是产品改进。

未注明差异的案例必须与参考相同。遇到新差异先判断错误、能力边界还是改进，再补明确契约，不能为把 CI 改绿就批量重录。

TS generator 在 CI 中执行 `--check`，重新调用当前参考实现并核对签入语料。这样 TS 改变时也会触发核对，而非永远使用旧 reference。Generator 不调用 native derive，避免两边实际使用同一段 Rust 算法的循环证明。

## 运行

按项目约定在 build host 或 CI 编译，以下命令的工作目录为 `crates/miao-engine`：

```sh
cargo test --test accuracy --test differential
python3 tests/accuracy/sensitivity.py
```

从完整仓库根目录执行参考核对（需要已安装 workspace 的 Bun dependencies）：

```sh
bun crates/miao-engine/tests/differential/generate.ts --check
```

日常 `cargo test` 自动包含这些测试；`engine` CI 在 macOS/Linux/Windows 跑它们，Linux 额外做故障注入，独立 reference job 执行 live TS 核对。

## 修改预期

明确需要改变产品行为时，先审阅固定结果断言及契约，再在 build host 的 disposable checkout 中运行：

```sh
MIAO_UPDATE_GOLDEN=1 cargo test --test accuracy
```

该变量只能更新 golden/schema，不能绕过文件结果、权限、随机不变量或差分的断言；CI 禁止更新。将更新后的 JSON 拷回并审阅 diff，随后用不带变量的普通测试确认。

参考结果需要更新时，从仓库根目录运行 generator（不带 `--check`）。审阅 reference 变化及所有 `contract` 的理由，再运行 Rust 差分。

## 检验测试自身

`sensitivity.py` 先要求普通 baseline 通过，再依次注入四个故障：删事件、漂移工具 schema、篡改参考结果、执行错误修复值。每个故障必须产生**测试断言失败**，编译失败不能算检测成功。每次以 `finally` 恢复原文件；最后 baseline 必须再次通过。

该脚本会短暂改写 checkout 中的 fixture/test source，应在独立 build checkout 串行运行，不要与另一个测试进程共享目录。

## 证据边界

本套件使用确定性 provider fixture，验证引擎执行和协议行为，不证明真实模型在任意任务上的推理质量。实际模型任务成功率、响应时间、RSS 和成本需另设带任务标准答案的评测。差分目前只覆盖 patch，不能据此宣称整个 TS/Rust engine 语义一致。
