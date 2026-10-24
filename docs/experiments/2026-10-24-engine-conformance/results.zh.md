# 2026-10-24 引擎功能一致性套件（TypeScript runner 对比 Rust 引擎）

`script/engine-conformance.ts`：12 个结构性场景 × 2 引擎（24 cell），单次执行，模型 `zhipuai-coding-plan/glm-5.3-flash`；视觉对（`image-input`）固定 `zhipuai-coding-plan/glm-4.6v`。每个 cell 在全新临时 workspace 里经 `miao run --format json` 运行；rust cell 通过 `MIAO_ENGINE_STORAGE` 放置原生引擎（凭据来自操作员环境），ts cell 删除该变量。断言只看结构性结果——工具确实执行、文件确实变更、sqlite 确实有行——绝不比对回复原文。原始证据（脱敏后的 stdout JSONL、stderr、每 cell 结果）在 `raw/`；机器可读汇总为 `results.json`。

## 结果矩阵（含下列修复后的最终状态）

| 场景                  | TS     | RS     | TS 成本 | RS 成本 | TS 轮次 | RS 轮次 | TS 时长 (s) | RS 时长 (s) |
| --------------------- | ------ | ------ | ------- | ------- | -------- | -------- | ----------- | ----------- |
| tool-recall           | PASS   | PASS   | 0.0012  | 0.0008  | 2        | 2        | 7           | 15          |
| file-edit             | PASS   | PASS   | 0.0017  | 0.0018  | 3        | 4        | 11          | 26          |
| apply-patch           | PASS   | PASS   | 0.0034  | 0.0018  | 4        | 4        | 13          | 21          |
| multi-turn-retention  | PASS   | PASS   | 0.0012  | 0.0009  | 2        | 2        | 13          | 18          |
| forced-compaction     | PASS ¹ | PASS   | 0.0056  | 0.0036  | 5        | 4        | 18          | 57          |
| interrupt-recovery    | PASS   | PASS   | 0.0023  | 0.0026  | 4        | 5        | 34          | 80          |
| background-job        | PASS   | PASS   | 0.0039  | 0.0022  | 5        | 4        | 21          | 32          |
| mcp-fixture           | PASS   | PASS   | 0.0023  | 0.0011  | 2        | 2        | 11          | 15          |
| permission-deny       | PASS   | PASS   | 0.0036  | 0.0020  | 4        | 4        | 23          | 35          |
| usage-priced          | PASS   | PASS   | 0.0007  | 0.0004  | 1        | 1        | 4           | 8           |
| session-title         | **FAIL** ² | PASS | 0.0016  | 0.0004  | 1        | 1        | 6           | 10          |
| image-input (4.6v)    | PASS   | PASS   | 0.0000 ³ | 0.0000 ³ | 1       | 2        | 7           | 17          |

**23/24 PASS，总花费 $0.0917。** 备用模型未动用（主凭据全程健康；`openai/gpt-6.1-sol` 在模型目录中不存在，按任务书的备用列表原样使用会直接失败）。

¹ TS 只断言完成；压缩行断言仅适用 rust（tsEquivalent n/a）。RS：在 `MIAO_CONTEXT_LIMITS={"window":4000,"ratio":0.6,"headroom":1000,"perPass":2}` 下 `engine_compaction` 行数 = 1。
² 已知限制，未修复（见缺陷 #5）：TS 标题是 fire-and-forget fiber，临时性 `miao run` 通常在生成完成前退出。交互会话不受影响。
³ `glm-4.6v` 无目录价目，双引擎都报 $0.0000——已知的未计价模型限制，记为 pass。

## 发现的缺陷 → 处置

| # | 缺陷 | 命中 | 层 | 处置 |
| - | ---- | ---- | -- | ---- |
| 1 | 桥接层把引擎工具 id 投影成产品并不存在的词汇：`apply_patch` → `apply-patch`（产品工具、tui、session-ui 都以 `apply_patch` 为键），job 家族被折叠成杜撰的 `background-job` id，引擎 MCP 别名落到 `custom` | rust | 产品层（`packages/miao/src/engine/bridge.ts`） | **已修复** `cb3b8bdbb3` — 映射到真实产品 id，剥离 MCP 摘要后缀，`start_job` 的 argv 翻译为 `bash` + `run_in_background` |
| 2 | `translateCompaction` 产出的负载不满足 OpenCodeEvent schema（`{status}` 没有 sessionID/timestamp；ended 缺 text/recent），导致每个触发过压缩的原生会话日志重放失败：`session.context` 返回 ConflictError，`miao run` 在完全成功的一轮之后仍以退出码 1 结束 | rust | 产品层（`bridge.ts`） | **已修复** `61f052208d` — `pre_compact` → 合法的 `compaction.started`，`history.compacted`（自带 summary）→ 合法的 `compaction.ended` |
| 3 | `native.title` 从 location runtime 上下文取 `LLMClient.Service`，而全局节点只作为构建依赖被组合、从不出现在构建产物上下文里——Context.get 永远报 "Service not found"，原生会话从不生成标题 | rust | 产品层（`packages/miao/src/engine/native-engine.ts`） | **已修复** `c9ebac331f` — 从层构建上下文取客户端（`llmClient` 加入 NativeEngine node deps） |
| 4 | 本地 `--file` 附件保留 `file://` URL；openai-chat 的媒体构造要求内联 base64，视觉提示在 TS runner 上直接失败（"media must contain valid base64"） | ts | 产品层（`packages/miao/src/cli/cmd/run.ts`） | **已修复** `b0fe7a7808` — 常规文件内联为 base64；本地目录保留 `file://` URL |
| 5 | TS 标题生成是 fire-and-forget fiber；临时性 headless 运行在落地前退出，`miao run` 会话保留默认标题 | ts | 产品层设计取舍 | **OPEN，已记录** —— 不是功能损坏（交互会话标题正常）；要修需让 headless 等待路径等待标题 fiber |
| 6 | 引擎 MCP 别名把 server 名截到 12 字符、工具名截到 14 字符，更长的 MCP 工具投影后 id 是截断的（客户端只能剥掉摘要后缀） | rust | 引擎层（Rust 别名格式） | **OPEN，已记录** —— 忠实投影需要引擎侧的 别名→身份 映射；本地 cargo 构建被 guard 阻止，未尝试 |

套件侧修正（场景/脚本层，随套件提交入库）：任务书给的 `MIAO_ENGINE_CONTEXT_LIMITS` 环境变量名不对——产品读的是 `MIAO_CONTEXT_LIMITS`（`packages/miao/src/engine/native-engine.ts`）；`miao run` 的 yargs 会把紧跟 `--file …` 之后的位置参数吞掉，所以提示词必须放在附件之前；引擎拒绝位于可写 workspace 内的 MCP/policy 配置文件，场景把它们写到 workspace 旁边并用 `MIAO_ENGINE_MCP_CONFIG`/`MIAO_ENGINE_POLICY` 指过去（即文档化的操作员路径——项目级 MCP 按设计从不转发给引擎）；内置标题 agent 的模型（`glm-5.3-highspeed`）不在本订阅内（429），场景用项目配置把 `agents.title.model` 钉住，以测试管线本身而非该选型。

## 运行方式

```
source ~/.config/miao/engine-on.sh
bun script/engine-conformance.ts [--binary miao-dev] [--models a/b,c/d]
    [--scenarios id,id] [--engines ts,rust] [--storage DIR] [--data DIR]
    [--max-cost 3] [--segment-timeout 420]
```

每 cell 证据：`raw/<scenario>.<engine>.<model>.jsonl`（segment 标记 + 脱敏事件流）、`.stderr.txt`、`.result.json`（断言结果、sessionID、成本、token、工具调用）、失败时另有 `.workspace.txt`。引擎凭据环境中的机密（credential db/id/integration、endpoint、storage 根、routes 配置）一律替换为 `[redacted]`；`sk-`/`Bearer` 值会被擦除。`results.json` 保存三轮（首轮 + 两次修复验证重跑）合并后的矩阵；后跑的证据覆盖同名文件。
