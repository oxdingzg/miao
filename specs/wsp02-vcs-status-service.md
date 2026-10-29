# WSP-02：Git 状态服务迁入 Rust 引擎

路线图卡片：`[WSP-02] Git 状态与 diff 产品服务`（`miao-roadmap:WSP-02`），工作线 Rust 化，依赖 RUS-03。
本文只记录这一项的设计与切片；卡片勾选以验收记录为准，不以本文存在为准。

## 1. 现状

- 产品侧的 Git 能力全在 TypeScript：`packages/server/src/handlers/vcs.ts` 提供 `vcs.get`（`branch`、`default_branch`）、`vcs.status`（`{file, additions, deletions, status}[]`）、`vcs.diff`（working / branch 两种），数据来自 `packages/core/src/git.ts`、`git-cli.ts`、`vcs-diff.ts`。
- Rust 引擎完全没有 Git 面：`crates/miao-engine/src/protocol.rs` 里没有任何 `vcs`/`git` 命令，`snapshot.rs` 也不调用 git（快照是自己算的）。
- 于是"当前工作区改了什么"这类每次打开会话都要问的问题，仍然要经过 TS 控制面，Rust TUI 无法自己回答。这正是 WSP-02 要消除的依赖。

## 2. 命令面

新增一个只读命令，按引擎既有惯例以 Session 定位（root 取 `engine_location`）：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `vcs_status` | `session_id` | 见下 |

```jsonc
{
  "repository": true,
  "root": "/path/to/worktree",      // 会话的 location root
  "branch": "main",                 // detached 时为 null
  "detached": false,
  "upstream": "origin/main",        // 没有上游时为 null
  "ahead": 1,                       // 只在有上游时出现
  "behind": 0,
  "files": [
    {"path":"src/a.rs","original_path":null,"index":"M","worktree":".","kind":"modified"},
    {"path":"src/b.rs","original_path":"src/old.rs","index":"R","worktree":".","kind":"renamed"},
    {"path":"notes.md","original_path":null,"index":".","worktree":"?","kind":"untracked"}
  ],
  "file_count": 3,
  "truncated": false
}
```

不在仓库里时返回 `{"repository": false, "root": <root>}`，**不是错误**：宿主问"有什么改动"时，"这里没有仓库"是一个正常答案，不该让调用方用异常去区分。

`index` / `worktree` 是 `git status --porcelain=v2` 的 XY 两列原样（未改动的一侧为 `.`，未跟踪为 `?`），`kind` 是由 XY 归一的展示分类：`untracked` / `conflicted` / `renamed` / `added` / `deleted` / `modified` / `changed`。保留原始 XY 是因为产品有时要区分"已 staged 的修改"和"只在工作区的修改"，而 `kind` 只回答"这个文件发生了什么"。

## 3. 实现约束

- **一次 git 调用**：`git -C <root> status --porcelain=v2 --branch --untracked-files=normal -z`，机器可读格式、NUL 分隔、路径不需要引号转义。不解析人类可读输出。
- **有界**：单次最多解析 `MAX_STATUS_FILES = 5000` 条；超出时停止解析并置 `truncated: true`（不是静默截断，调用方能看到"还有更多"）。单个路径上限 4096 字符。
- **不阻塞**：命令是异步的，`git` 以 `tokio::process::Command` 启动并带 10 秒超时；超时返回 `Error::Invalid("git status timed out")`，不挂住 drain。
- **只读**：不加锁、不写索引、不 fetch。`status` 不触发网络；`ahead`/`behind` 只读本地 `branch.ab`。
- **路径相对会话 root**：git 默认按 cwd 相对路径输出，宿主拿到的路径可以直接和自己的工作区拼接。

## 4. 切片

- **S1（本 PR）**：`vcs_status` 命令 + porcelain v2 解析 + 分支/上游/ahead-behind + untracked/staged/rename/conflict 分类 + 有界与超时。实现与测试在引擎侧。
- **S2**：`additions`/`deletions`（`git diff --numstat`）与 `vcs_diff`（working / branch），并附带大仓库测量——卡片明确要求"不把单次 git 原语加速当整体收益"，所以测量与实现分开记录。
- **S3**：`packages/server` 的路由改为读引擎命令，TS 的 `git.ts`/`git-cli.ts` 调用面随之缩小。

## 5. 验收映射

- "迁移 vcs.diff/status/分支/文件变化等宿主能力" → S1 提供 status/分支；diff 在 S2。
- "含 untracked、staged 与 rename，异步计算不阻塞 UI" → S1 的 `files[]` 三种状态都有断言（见 `crates/miao-engine/tests/vcs.rs`），命令是异步且带超时。
- "大型仓库全链路测量" → S2，S1 不作声称。
- "关联实现 PR、验收记录与适用版本" → PR 列表在此更新；真实客户端验收要等 S3 接上后才有意义。
