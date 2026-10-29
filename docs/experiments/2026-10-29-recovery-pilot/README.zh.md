# 有界功能试跑（2026-10-29）

本轮检查真实模型下的只读检索和小编辑。两端只读通过；原生小编辑首轮失败，保留事件的诊断轮确认了模型输入与工具合同冲突。修复后的原生小编辑及显式选择 TS 的小编辑均通过。这里只记录局部功能可用性，不接受整体迁移、成本或速度收益结论。

## 方法与边界

任务使用未修改的 suite-v6 `read-only` / `small-edit` 合同，具体 suite/task hash、源码 SHA、二进制 SHA、权限/工具 profile、工具数和外置验证结果见 [summary.json](summary.json)。每项限时90秒；原生策略最多6个provider turn，禁用进程网络。每轮使用独立工作目录和凭据快照；日常安装没有替换。原生调试产物来自构建机，下载后核对二进制 SHA；相应已跟踪原生源文件、清单和测试也逐项核对。

两端策略和工具面不同，且没有足够重复样本，因此时长只保留为回执，不计算比较收益。费用未定价，`null` 表示未知。TS 臂通过 `--engine ts` 明确选择后端（[#1646](https://github.com/oxdingzg/miao/pull/1646)），不使用默认后端猜测。

## 全部模型样本

| 样本 | 结果 | provider调用 | 完成工具 |
| --- | --- | ---: | ---: |
| native-read | passed | 5 | 4 |
| native-edit-before | artifact failed / rejected profile | 6 | 8 |
| native-edit-diagnostic | artifact pass / rejected profile | 6 | 8 |
| native-edit-fixed | passed | 5 | 7 |
| typescript-read | passed | 5 | 6 |
| typescript-edit | passed | 6 | 8 |

另保留两项模型请求前的启动失败：首次命令遗漏 `--credential-id`，两项都未产生provider调用。补全启动参数后才开始模型样本；启动失败不计入模型成功率。原生诊断轮外置测试通过，但第6轮进入预算收尾时工具面改变，严格profile检验拒绝把它纳入可比样本；保留该拒绝，不将artifact通过偷换成基准通过。

TS 首次命令中的完整revision字符串有录入错误。实际入口来自同一未修改、已提交的工作树；用 `git rev-parse HEAD` 校正副本并重算receipt hash，原始输出继续保留，未为修正元数据再次调用模型。汇总引用校正后的源码 SHA。

## 编辑失败与修复

原生诊断轮提供了以下 schema 合法输入（路径与内容均来自公开的小编辑fixture）：

```json
{
  "path": "src/add.ts",
  "old_string": "return a - b",
  "new_string": "return a + b",
  "anchor": "",
  "new_text": "",
  "replace_all": false
}
```

该调用还携带了 `read_file` 返回的 `expected_sha256`。旧schema同时广告两套互斥名称，模型给未使用别名填空串后，解析器报告 `pass the replaced text once, as old_string or anchor, not both`。诊断轮改用事务patch才完成编辑。

[#1647](https://github.com/oxdingzg/miao/pull/1647) 将广告schema收敛为必需的 `old_string` / `new_string`，保留旧别名解析及冲突拒绝。真实Runtime回归在原实现失败，修复后替换和空串删除通过；189项定向Rust测试及clippy通过。修复产物的模型试跑使用5个provider调用、7个工具，工具错误为0，现有测试与不可修改文件检查全部通过。该样本不证明全任务分布的改善。

## 剩余验收

继续补齐真实仓库、长会话、失败/中断恢复和完整客户端矩阵；收益评估需冻结相同权限、模型参数、工具面、重复次数及可计量价格。此报告不将 VAL-01/VAL-02 或 Rust 退役门槛标为完成。全部实现仍按各自PR、CI、批准评审和发布记录追踪。
