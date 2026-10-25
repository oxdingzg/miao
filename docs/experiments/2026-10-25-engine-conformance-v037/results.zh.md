# 0.3.7 候选版本双引擎一致性验证（2026-10-25）

最新完整 R7 在同一份未变更、包含完整 Web UI 的 CLI／引擎配对产物上通过 **23/24**。唯一失败是 TypeScript 工具调用单元：模型直接回答提示中已有的 token，没有执行要求的 bash 命令。命令正常退出，但缺少实际工具调用仍判失败，不能称为 24/24。

| Scenario             | TypeScript | Rust      |
| -------------------- | ---------- | --------- |
| tool-recall          | FAIL (r7)  | PASS (r7) |
| file-edit            | PASS (r7)  | PASS (r7) |
| apply-patch          | PASS (r7)  | PASS (r7) |
| multi-turn-retention | PASS (r7)  | PASS (r7) |
| forced-compaction    | PASS (r7)  | PASS (r7) |
| interrupt-recovery   | PASS (r7)  | PASS (r7) |
| background-job       | PASS (r7)  | PASS (r7) |
| mcp-fixture          | PASS (r7)  | PASS (r7) |
| permission-deny      | PASS (r7)  | PASS (r7) |
| usage-priced         | PASS (r7)  | PASS (r7) |
| session-title        | PASS (r7)  | PASS (r7) |
| image-input          | PASS (r7)  | PASS (r7) |

两种引擎的文件编辑、补丁应用、多轮记忆、中断恢复、后台任务、MCP、权限拒绝、用量计价、标题保存和图片输入均通过。Rust 强制压缩确认一条持久化 engine_compaction 记录；TS 压缩单元只验证完成，不证明发生了 TS 压缩。本轮矩阵没有观察到进程卡死或崩溃。

每个单元显式指定引擎与 --dir，隔离产品数据库和原生存储。宿主与引擎均报告 0.3.7。凭据只通过进程内存传递。验收读取原生持久化完成、用量及标题记录，退出码为零但运行中断不能通过。主模型为 zhipuai-coding-plan/glm-5.3-flash，图片单元为 glm-4.6v；源码与可执行文件摘要见 provenance.json。

R2 曾通过 22/24，两个产品缺陷分别是显式上下文限制被覆盖和 TS 短命令退出前标题尚未保存。#1422、#1423 修复后经 R3–R5 定向验证通过，本次完整 R7 也均通过。旧轮次及此前汇总保留在 runs；results.json 现在选择全部最新 R7 记录，包括失败，不会用较早通过结果遮盖新失败。

R7 主模型轮次参考成本为 $0.05362252294，R2–R5 为 $0.05987445618；均不含辅助标题调用，也不是订阅实付费用。视觉模型缺少目录价格而记零，不能据此认定免费。R6 因验收环境误固定零价原始目录、绕过正常参考价覆盖而中止，保留中止记录，不算一次完整验收。

R7 产物包含 #1425 引擎配对与 #1426 并发创建修复。完整 Web UI 构建及编译版 TUI 在 120／42 列显示输入框均通过；模型验收不替代 App UI、最终 main 集成、最终安装产物或跨平台升级验收。另行发现的路由能力字段解码修复也不在本轮冻结产物中。未发布版本；外部编辑器／服务商／自然到期凭据验收及后续 Rust 迁移没有因此完成。
