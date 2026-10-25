# G0-2：Code Mode `execute` 的处置

状态：决定（2026-10-26）。回收 `specs/rust-phase-2.md` §3 的 G0-2 行："决定'移植'或'明确废弃'"。

## 1. 现状

- TS 侧：`execute` 工具（`packages/core/src/tool/code-mode.ts:10`）。它只在 `options.codeMode`
  为真时注册（`packages/core/src/tool/registry.ts:365-383`），而这个选项只有 TS runner 传
  （`packages/core/src/session/runner/llm.ts:769`），开关是实验标志
  `Flag.MIAO_EXPERIMENTAL_CODE_MODE`（`packages/core/src/flag/flag.ts:111`）。
- 它执行的代码不是交给原生 JS 引擎，而是本项目自己的解释器栈
  （`packages/codemode/src/interpreter/`：acorn 解析 + TypeScript 转译 + 自建 stdlib）。
- 引擎侧没有 `execute`。它的"工具表面收敛"是另一条路：compact disclosure 打开后，扩展工具不再
  平铺，而是经 `tool_search` 发现、`tool_call` 调用
  （`crates/miao-engine/src/tool_catalog.rs:113-114`；`crates/miao-engine/src/tools.rs:1002,1791`）。
  开关是 `--tool-disclosure compact`，默认 `full`（`crates/miao-engine/src/main.rs:515-520`）。

## 2. 判定：原生路径明确废弃 `execute`，不移植

1. **移植成本是把一个 JS 运行时装回引擎。** `execute` 的语义是"模型写一段脚本，脚本内串联多个
   工具"。要实现它，引擎必须能解析并执行 JS——即把 `packages/codemode` 的解释器（acorn 语义、
   TS 转译、stdlib 内置类型）整体搬到 Rust。而引擎存在的第一个理由就是不依赖 JS 运行时；
   把这层塞回去与 S5/S6 的方向相反。
2. **能力重叠是部分的，缺口要写下来。** 原生路径的 `tool_search`/`tool_call` 解决"工具表面太大、
   只能在一次调用里发现一个"的问题；但"在一次调用里用代码串起多个工具、让中间数据不经过模型"
   在原生路径上**没有等价物**。这是书面接受的损失，不是"看起来有"。
3. **它今天在 native placement 上本来就不可达。** `codeMode` 只由 TS runner 传；native Session
   的工具表面由引擎构建。所以这不是能力回退，而是把"事实上不可达"写成"明确废弃"，避免以后
   按"缺失"重复讨论。

## 3. 与 TS 路径的关系

S1 不动 TS placement：`execute` 在 TS placement 上继续可用，直到 S3（placement 收口）决定
TS runner 的下场。届时若"一次调用串多个工具"仍是真实需求，应按新设计重新提案（例如在工具侧
提供受限的管道原语），而不是移植这个实验解释器。

## 4. 关闭条件

- `specs/rust-phase-2.md` 的 G0-2 行改为：原生路径废弃，`tool_search`/`tool_call` 是部分覆盖，
  组合式调用为书面接受损失，`execute` 留在 TS placement 至 S3。
- 不需要代码改动：引擎里没有任何 `execute` 注册点，不存在"留下了半个实现"。原生间接调用的
  证据测试是 `crates/miao-engine/tests/mcp.rs:275`
  `discovery_and_filtered_execution_keep_the_provider_surface_stable`。
