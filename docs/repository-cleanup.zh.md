# 无用上游材料清理 — 2026-10-04

**语言 / Language:** [简体中文](repository-cleanup.zh.md) | [English](repository-cleanup.en.md)

本次盘点覆盖已跟踪的根目录材料、app/UI public 素材与符号链接目标、desktop 图标复制和打包路径、
仓库自动化、发布辅助脚本，以及代码和文档中的实际引用。清理无用途材料，不把所有出现
`opencode` 的内容都当作遗留物。

## 已清理

| 材料                                                                         | 无用途的判断依据                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 根目录 `screenshot-uk.png`                                                   | 无引用的上游截图；当前产品截图位于 `docs/images`                                                                              |
| app 帮助素材 `placeholder.png`                                               | 没有组件导入；实际使用的帮助截图和视频保留                                                                                    |
| 旧的无版本 `apple-touch-icon.png`、`favicon-96x96.png`、`favicon.svg`        | 当前 HTML/Favicon 组件使用 v3 素材；未使用的 public 链接和 UI 目标成对删除                                                    |
| `social-share-zen.png`（public 链接与 UI 目标）、UI `social-share-black.png` | 没有当前消费方；仍被引用的 `social-share.png` 保留                                                                            |
| `.github/publish-python-sdk.yml`                                             | 全文为注释，不是可执行工作流；所指 Python SDK 已不存在                                                                        |
| `.github/workflows/notify-discord.yml`                                       | 无用途的上游发布通知集成，不属于当前维护的 release 发布路径                                                                   |
| `script/beta.ts`                                                             | 无引用的上游 beta 集成脚本，依赖已不存在的 `v2`/`beta` 分支并调用 `opencode`                                                  |
| `script/release`                                                             | 直接向 main 提交/push 的旧辅助脚本，已被受保护 main 的 PR 流程取代；中英文发布指南同步改为版本准备 PR 合入后显式触发 workflow |
| desktop Android launcher 生成物（51 个文件）                                 | Electron 包没有 Android 构建目标或消费方                                                                                      |
| desktop iOS 生成物（54 个文件）                                              | Electron 包没有 iOS 构建目标或消费方                                                                                          |
| desktop UWP/Store 生成物（30 个文件）                                        | Windows 打包使用 NSIS，不是 appx/UWP                                                                                          |

合计：**删除 150 个路径**，约 **4.39 MB** 已跟踪内容（含符号链接文本）。
本次删除当前工作树中的文件，不重写 Git 历史。

## 已修正的有效材料

- 当前使用的 web manifest 和共享 Favicon 组件将应用标识改为 `miao`。
- desktop 图标 README 改为实际 Electron channel/复制流程，不再使用已移除的 Tauri 命令。
  三个 channel 所需的桌面图标均保留。
- 版本准备留在短期分支，经 PR 合入后才触发 release 工作流。本次清理不会发布版本。

## 核实后保留

- 根 `LICENSE`、miao/opencode 两条版权声明，以及 UI/HTTP recorder 许可证文件。
- 真实 provider 身份（`opencode`、`opencode-go`）、provider 图标、上游归属、历史研究/changelog、
  数据库/配置兼容标识及仍有效的主题名称。
- 当前 `docs/images` 截图、正在使用的帮助截图/视频、字体、音频、生成的图标 sprite 及其源图标库。
- `scripts/copy-icons.ts`、Electron-builder 和 macOS Dock 使用的 desktop channel 图标：
  `icon.icns`、`icon.ico`、`dock.png`、`icon.png` 与桌面 PNG 尺寸。
- v3 app favicon、manifest 图标、被引用的分享图，以及浏览器惯例请求的 `/favicon.ico`。
  Public 符号链接需要保留其 UI 目标；仅仅没有 TypeScript import，不能证明目标文件无用途。
- 当前维护的 CI/release/install 检查、issue/PR 工具和团队元数据，它们在 fork 中仍有消费方。

仍在使用但视觉身份来自上游的素材属于另一个设计更新事项。删除仍被页面或打包流程使用的素材，
不是有效的清理。
