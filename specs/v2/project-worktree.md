# V2 项目工作树（取代 V1 `/experimental/worktree`）

状态：已实现，2026-10-03（`c55e8b36e`）。P7 剩余项：app 的"新建工作区 / 删除 / 重置"仍走 V1 `worktree.create/remove/reset`
与 `instance.dispose`。本方案是 V1 行为的平移，不改变用户可见语义。

## 现状（按代码核实）

V1 `packages/miao/src/worktree/index.ts`：

- **create**：项目必须是 git；在 `<data>/worktree/<projectID>/` 下生成不冲突的名字（随机 slug，或给定名字
  slug 化，重名追加后缀），建分支 `miao/<name>`（`detached` 时不建）；`git worktree add --no-checkout`，把目录
  加进项目 `sandboxes`，**立即返回** `{name, branch, directory}`。后台继续：`git reset --hard` 填充文件 →
  启动该目录的实例 → 发 `worktree.ready`（失败发 `worktree.failed`）→ 依次运行项目 `commands.start` 与调用方给的
  `startCommand`。
- **remove**：先释放该目录的实例；`git worktree remove --force`，失败但 git 已不认识时视为成功；删除目录（Windows
  重试）；删除 `miao/` 分支。目录不在 git 列表里但存在时直接删目录。
- **reset**：不能重置主工作区；`fetch` 默认分支的远端 → `reset --hard <默认分支>` → `clean -ffdx`（失败时清掉
  报错的条目再试）→ 子模块 `update --init --recursive --force`、`foreach reset --hard`、`foreach clean -fdx` →
  确认 `status` 干净；然后后台重跑启动脚本。app 在调用前先 `instance.dispose` 该目录。

V2 现有能力：core `ProjectCopy`（git worktree 策略，`--detach`、不建分支、不跑脚本），协议在
`/experimental/project/:projectID/copy`；`/api/workspace` 是控制面的远程工作区，与 git 工作树无关。
`worktree.ready/failed` 事件定义存在，但不在 `/api/event` 的 `ServerDefinitions` 里。

## 方案

1. **core `ProjectWorktree`（全局 node）**：把 V1 的 create/remove/reset 与启动脚本原样搬进 core，git 操作用
   `GitCli`（与 V1 相同的命令行），启动脚本读 `project.commands.start`。输入显式带项目根目录与项目 ID，不依赖
   位置作用域；后台任务 fork 在服务自己的作用域里，不随某个位置的重建被打断。
   - 目录登记：create 后写 `project_directory`（策略 `git_worktree`）并发 `project.directories.updated`，同时加入
     `sandboxes`；remove 后两处一并移除。
   - 事件：`worktree.ready` / `worktree.failed` 以**新工作树目录**作为事件的 location 发布（app 按
     `location.directory` 匹配），并加入 `ServerDefinitions`。
2. **路由**（`/api/worktree`，location 为项目任一目录）：
   - `POST /api/worktree` `{ name?, startCommand? }` → `{ name, branch?, directory }`
   - `DELETE /api/worktree` `{ directory }` → 先失效该目录的位置服务，再删除
   - `POST /api/worktree/reset` `{ directory }` → 先失效该目录的位置服务（取代 app 的 `instance.dispose`），再重置
3. **app**：`layout.tsx` 的新建 / 删除 / 重置与 `prompt-input/submit.ts` 的"新会话建工作树"改走上述路由；删除
   `instance.dispose` 调用。
4. **V1**：暂不委托。V1 `Worktree` 还被 V1 控制面的工作树适配器（`control-plane/adapters/worktree.ts`）使用，
   依赖 core 版本没有的 detached 工作树与列表；这些调用方随 V1 路由与控制面一起删除，过渡期两份实现并存。

## 测试

core 单测（真 git 仓库）：create 生成名字与 `miao/` 分支、填充文件后发 ready、运行项目启动脚本；remove 删除
目录与分支并移除登记；reset 回到默认分支、清掉未跟踪文件、拒绝主工作区。路由测试：create → ready 事件到达 →
目录出现在 `/api/project/:id/directories`；reset、remove 的状态码与结果。
