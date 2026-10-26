# S5：配置下沉设计

状态：设计稿，2026-10-26。前置：S3。

## 1. 目的

`specs/rust-phase-2.md` §4 的 S5：`miao.json` 的优先级解析进入引擎，TS 只传目录与环境；
删除 `product-*.ts` 的临时文件物化。

## 2. 现状

- 配置解析只在 TS：`packages/core/src/config.ts:49`（`fileNames` 的优先级列表、
  `parseJsonc`、V1 迁移入口 `ConfigMigrateV1`）。
- 引擎只接受 argv 与产品物化的临时文件：`packages/miao/src/engine/product-policy.ts`、
  `product-hooks.ts`、`product-mcp.ts`、`product-lsp.ts`、`product-formatter.ts`、
  `product-agent.ts`、`product-command.ts`、`product-tools.ts`、`product-routes.ts`。
  每一份都是一次"TS 已解析 → 写临时 JSON → 引擎读"的往返。

## 3. 设计

1. **解析进引擎**：引擎读同一组文件（`miao.json` / `miao.jsonc` / `opencode.json` /
   `opencode.jsonc`）与同样的优先级，自己做 V1 迁移判定与 JSONC 解析。
2. **TS 传目录与环境**：启动参数只传 workspace 目录、global 配置目录、以及必须由宿主决定的
   环境（例如网关 token）。临时文件物化删除。
3. **一份解析器两种读者**：S5 期间 TS 仍需要配置（TUI、命令、agent 列表），所以解析器要有
   两份实现且**必须用同一组黄金样例对齐**（输入 JSON → 归一化输出），否则会出现"引擎看到的
   配置与 TUI 不同"。这是 S5 的主要成本，也是它的验收核心。
4. **失败策略**：配置非法时两侧给出同一条错误（相同的 path/键路径），不允许一侧沉默。

## 4. 验收

- 黄金样例集：每个样例（含 JSONC、V1 迁移、多目录优先级、未知键）在 TS 与引擎两侧产生
  相同的归一化配置；样例随 PR 提交。
- 删除 `product-*.ts` 的物化后，全量测试与 blackbox 通过。
- 配置错误信息两侧一致（快照测试）。

## 5. 不做

- 不改配置的语义（键、默认值、迁移规则）。
- 不为插件提供新的配置读取 API（那是 Phase 4）。

## 6. 风险

| 风险 | 处理 |
|---|---|
| 两套解析器漂移 | 黄金样例集进入 CI；漂移即失败 |
| V1 迁移规则在两处实现不一致 | 迁移只在引擎实现一次，TS 侧读引擎归一化后的结果 |
| 启动变慢（引擎每次读文件） | 配置读取在引擎启动一次并缓存，与今天产品侧行为一致 |
