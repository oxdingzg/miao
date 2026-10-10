# 本地 engine 预览回退演练

本轮实际执行了安装/升级/回退，而不只是写流程。它覆盖 POSIX 本地 engine 安装通道，不代表产品默认后端切换或 Windows 安装器的完整回退。

## 发现与修复

旧安装器按 `--version` 创建目标路径。两个不同预览构建 A/B 若都返回 `miao-engine 0.2.2`，B 会覆盖 A 的路径，`miao-engine.prev` 也读到 B。演练已复现这一缺陷。

安装器现在按 **版本＋完整 SHA-256** 创建不可混淆的目标。新构建保留旧二进制；重复安装完全相同的构建不会覆盖 previous 指针。

`packages/miao/test/engine/install.test.ts` 验证：同版本 A/B 可回退、重复安装 B 仍保留 A、执行实际回退后运行 A，以及候选二进制的版本 smoke 失败时保留当前安装。

## 实际二进制演练结果

在隔离临时 HOME 中，使用两份真实 macOS engine 二进制（同版本号、不同文件内容），顺序安装 A、B，再执行 previous 指针回退：

| 项 | SHA-256 |
|---|---|
| A / 回退目标 | `569d3f9c1dde0ddbf08a9a024f5b044e6cd45b4f685e464df829d48257e2efd2` |
| B / 候选构建 | `5eaf2c7db17ac7595fe58ba83f20e2e0110457e29b023106a33d785b8d2814c8` |
| 回退后运行入口 | 与 A 的 SHA-256 完全相等 |

回退后 `--version` 正常返回 `miao-engine 0.2.2`。没有触碰日常发行版 `miao`、当前 Rust preview 安装或真实会话数据库。

## 再运行

从 `packages/miao`：

```sh
bun test test/engine/install.test.ts
```

对 build host 编译的实际二进制，可在临时 HOME 下运行同一 `script/install-engine.sh --binary ...`；记录安装前后、previous 与回退后文件的 SHA-256，确保恢复的是 A 的字节，不只比较版本字符串。

这完成的是 engine 本地预览回退证据。默认切换前仍需真实产品投影/审批/恢复与发布通道回退验收。
