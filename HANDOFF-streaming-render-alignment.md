# 交接：miao TUI 流式渲染回归修复

## 背景

2026-11-02 下午起，`feat/release-single-binary` 分支（后合入 main）连续合入了约 20 个渲染相关提交（`#2375`-`#2410` 及后续），重构了 miao TUI（Rust ratatui）的整个渲染管线。合入后用户报告以下回归，多个 Claude 会话（含本会话）交替修复，但**渲染视觉质量仍未恢复到 0.3.26 水平**。

## 已确认正常的（不要重做）

| 层 | 验证方式 | 结论 |
|---|---|---|
| engine 发 delta | stdio wire log：GLM 路由 54 个 reasoning.delta | ✅ 正常 |
| 双 turn 连续流式 | 探针：turn1=65 / turn2=44 个 delta | ✅ 无断点 |
| TUI transport 接收 progress | embedded wire log：27 帧 progress 到达 | ✅ 正常 |
| 权限通配 allow | config_derive.rs permission_rules() 探针+clippy | ✅ 已修复(#2393 同修复) |
| installer 版本校验 | 已修复并推 main（`1b9234a14a`） | ✅ |

## 用户报告的回归（按严重度排列）

### 1. 流式文本渲染无格式（最严重）

流式期间的 assistant 回复渲染为一堵密不透风的文字墙：
- 无段落间距
- 无 markdown 格式（代码块、标题、粗体等不可见）
- 工具调用与文本交错但无视觉分隔

**0.3.26 对照**：相同内容流式显示时有清晰的段落间距和格式。

**关键代码**：`crates/miao-tui/src/pane.rs` → `fn draft_lines()` → 调用 `prose_lines()` → 调用 `markdown::lines(text, theme)`。markdown 解析器**存在且被调用**（clippy 确认 import 存在），但**渲染结果缺少格式**。需要对比 `markdown.rs` 的 `pub fn lines()` 在 0.3.26（`ece84b33c0`）和当前 `origin/main` 之间的差异，以及 `prose_lines` 函数自身的样式处理是否完整传递了 markdown 输出的样式。

**注意**：当前 pane.rs 有多个 python 脚本编辑产生的重复代码块残留（`unknown_command_notice`、`parse_devices` 等在 `mod tests` 后有重复定义）。git 历史 `b5e81eefd3` 是 clippy 干净的最后提交。

### 2. 闪烁（已修但可能仍有残余）

**根因**：`#2402`（`c9ac1962cf`）在 `app.rs` → `fn stream()` 中给每个 delta 加了 `self.redraw_requested = true`，而 `terminal.rs` → `pub fn redraw()` 内部调用 `terminal.resize()`——ratatui 的 resize 会清空差分缓冲，导致每个 token 触发一次**全屏重写**（实测 215KB/s）。

**已修复**：`1b5fdcbcc4` 删除了该 `redraw_requested`；`7284f2c17a` 添加了 CSI 2026 同步更新标记（`terminal.rs` → `pub fn draw_frame()`）。实测输出从 215KB/s 降至 ~5KB/s。

**可能残留**：如果用户仍报闪烁，检查 `lib.rs` 主循环是否有其他高频重绘触发点。

### 3. 首页（launcher）布局回归

**用户想要**：0.3.26 的列表式启动页——session 列表面板 + composer 边框盒子 + Tab 焦点切换 + footer 提示文案。

**当前版本**：`#2380`（`f98284574e`）+ `d5ca52247a` 将 launcher 改为了 prompt-only 首页（无列表，MIAO banner 居中）。这是**刻意的重设计**（#2380 的 PR 描述明确说了），但用户不喜欢这个设计。

**修复方向**：恢复 0.3.26 的列表式 launcher（session 列表面板 + composer 边框盒子 + Tab 焦点切换 + footer 提示文案）。核心代码在 `pane.rs` → `impl Home` 块（当前已被大量修改，需要从 `ece84b33c0` 的 pane.rs 恢复 Home 的列表交互逻辑，同时保留后续的功能修复如 thinking 折叠窗口、status strip 等）。

### 4. thinking 平铺（部分已修）

`#2375`（`b8dd3eec83`）让 thinking verbatim 流式显示。当前版本已在 `draft_lines()` 中加了折叠窗口（摘要行 + 最近 6 行），但**已 committed 的 thinking**（`Entry::Reasoning`）仍显示为 `▸ thinking · N chars` 单行摘要，而非 0.3.26 的 verbatim 内容。需要修改 `session.rs` → `transcript_lines()` 中 `Entry::Reasoning` 的渲染逻辑。

### 5. `/quit` 需要按两次回车

`#2402`（`c9ac1962cf`）给补全面板加了 Enter 拦截。已修复（`600d15add5`），但需确认。

### 6. `exit`/`quit` 统一退出

已修复（`01f14bc9bc`、`c102260f8f`）。已确认正常。

## 关键文件与行号（当前 HEAD `01f14bc9bc`）

| 文件 | 区域 | 说明 |
|---|---|---|
| `crates/miao-tui/src/pane.rs` | 全文件 | 渲染核心，被 #2410 完全重写 |
| `crates/miao-tui/src/pane.rs` L1186 | `fn draft_lines()` | 流式 thinking/text 渲染 |
| `crates/miao-tui/src/pane.rs` L1213 | `fn transcript_lines()` | committed 条目渲染 |
| `crates/miao-tui/src/pane.rs` L30-38 | `fn body_columns()` | transcript/sidebar 布局拆分 |
| `crates/miao-tui/src/pane.rs` L3098-3175 | 重复定义块 | **需删除**（#2410 合入产生的重复） |
| `crates/miao-tui/src/app.rs` L2000-2110 | `fn handle_session_key()` | Session 屏键盘处理 |
| `crates/miao-tui/src/app.rs` L2465 | `fn stream()` | delta → draft 追加 |
| `crates/miao-tui/src/markdown.rs` | 全文件 | markdown 渲染器（确认未变） |
| `crates/miao-tui/src/tool.rs` | 全文件 | 工具调用渲染（有变更，需对比） |

## git 参考

| 版本 | commit | 说明 |
|---|---|---|
| 0.3.26 基线 | `ece84b33c0` | 渲染正常的最后提交 |
| #2375 thinking verbatim | `b8dd3eec83` | 第一个渲染改动 |
| #2380 landing action row | `f98284574e` | launcher 开始变化 |
| #2402 early streaming deltas | `c9ac1962cf` | 加了 per-delta redraw（闪烁源头） |
| #2404 stream draft real time | `54fbe4fdbd` | draft 渲染变化 |
| #2410 mirror TS layout | `340ca8406b` | **最大的渲染重写** |
| 当前 origin/main | `b5e81eefd3` | 包含全部修复 |

## 诊断工具（已验证有效）

1. **pty 屏幕重建**：用 `pty.fork()` + 终端网格重建脚本读取实际渲染像素，带行号
2. **stdio wire log**：直接给 engine 发 JSON-RPC 帧，抓 progress/event 回复
3. **embedded wire log**：设 `MIAO_TUI_WIRE_LOG=/tmp/wire.log` 跑 TUI，记录 embedded engine 帧收发
4. **字节率测量**：pty 下逐秒测量输出字节数——流式时 >100KB/s 表示整屏重绘仍在发生

## 协作注意

本仓库今晚有多个 Claude 会话同时在高频推送 main（几分钟一个提交）。**在操作前先 `git fetch` 并确认 origin/main 没有新提交**。如果要推 main，先 rebase 到最新 origin/main。协作会话可能会在你 rebase 期间又推新提交——这种情况需要再 rebase。

## 建议的修复策略

**方案 A（保守）：回退 pane.rs 到 0.3.26 版本**，然后逐个 cherry-pick 后续的功能修复（跳过渲染相关的变更）。风险：后续提交与 pane.rs 深度耦合，可能产生大量冲突。

**方案 B（渐进）：在当前树上修复渲染质量问题**。保留 #2410 的架构改动，针对用户报告的具体视觉差异逐个修复。优点：改动最小、不丢功能。缺点：需要精确理解 #2410 改了什么、为什么导致视觉退化。

**推荐方案 B**，因为渲染重写带来了实质改进（TS 布局镜像、实时流式架构），回退会丢失这些改进。
