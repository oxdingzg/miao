# V2 项目持久化（取代 V1 `Project.fromDirectory`）

状态：已实现，2026-10-03（附带功能一起迁移）。P7 删除 V1 前的必做项；`POST /api/project/git/init` 依赖它。

## 现状（按代码核实）

`project` 表、`project_directory` 表和 `.git/opencode` ID 缓存**只由 V1 维护**：V1 实例启动
（`packages/miao/src/project/instance-store.ts` `boot`）调用 `Project.fromDirectory`，做了以下几件事：

1. `ProjectV2.resolve(directory)`：项目 ID 取 `git remote 的哈希 → .git/opencode 里缓存的旧 ID → 第一个根提交`，
   非 git 目录归入 `global`。仓库第一次加 remote 时 ID 会变，`previous` 给出旧 ID。
2. **ID 迁移**（`previous ≠ id` 时，单事务）：旧项目行复制成新 ID（新 ID 已存在则不覆盖）、删掉旧 ID 的
   `project_directory`、把 `session` 与 `workspace` 的 `project_id` 改为新 ID、删旧项目行。
3. **upsert 项目行**：保留 `name`/`icon`/`commands`/`time_initialized`，更新 `worktree`、`vcs`、`time_updated`；
   打开的目录不是 worktree 时加入 `sandboxes`，并剔除已不存在的 sandbox。
4. 目录原本属于 `global` 的会话（`project_id = global` 且 `directory` 相同）改挂到新项目。
5. 记录 `project_directory`（打开过的目录，app 侧边栏的工作区列表来源）。
6. 发 `project.updated`；git 项目把 ID 写回 `.git/opencode`（`ProjectV2.commit`）。
7. 两个附带功能：实验开关下的 favicon 图标发现；`/init` 命令执行时写 `time_initialized`。

V2 自己只在**建会话**（`session-create.ts`）和**改名**（`ProjectMetadata.ensure`）时 insert-or-ignore 项目行；
不迁移 ID、不写 `project_directory`、不写 ID 缓存、不维护 `sandboxes`。所以删掉 V1 后：
加 remote 的仓库会变成一个新项目、旧会话留在旧 ID 下；侧边栏工作区列表不再更新；新目录要等建会话才出现在项目列表里。

## 方案

### 1. 位置启动时登记项目（core `ProjectRegistry`）

新增 location 级 node `ProjectRegistry`，在位置服务层构建时运行一次（与 V1 实例启动同一时机，
`LocationServiceMap` 每个目录只构建一次，配置写入导致的重建会再跑一次，操作是幂等的）。它把上面 1–6 原样搬进 core：

- 复用 `Location` 已经解析好的项目（`resolved.id/previous/directory/vcs`），不再重复 `resolve`。
- ID 迁移、upsert、global 会话改挂、`project_directory` 写入放在**一个** `immediate` 事务里，并发打开同一项目的
  多个目录时由 SQLite 串行化。
- 事务提交后：内容有变化才发 `project.updated`（V2 事件，已在 `ServerDefinitions` 里）；git 项目写回 ID 缓存。
- 失败只记 warning、不阻塞位置启动（与 V1 的 `saveProjectDirectory` 一致）——登记是记账，不能让一个坏目录打不开会话。

`ProjectMetadata.ensure` 和 `session-create.ts` 里的 insert-or-ignore 保留作兜底（登记失败时仍能建会话、改名）。

### 2. V1 改为委托 core，避免两套实现并存

`Project.fromDirectory` 改成调用 `ProjectRegistry` 的同一实现，V1 只保留取 `InstanceContext` 需要的返回值。
这样过渡期内 V1 和 V2 写的是同一份逻辑，删 V1 时直接删掉调用方即可。V1 的 `fromRow` 与
`ProjectMetadata.fromRow` 的重复也一并收掉。

### 3. `POST /api/project/git/init`

在请求所在目录执行 `git init --quiet`（已是仓库则直接返回），然后 `invalidate` 该位置，重建时 `ProjectRegistry`
登记出带 `vcs: "git"` 的项目；返回登记后的 `Project.Info`。注意：没有提交也没有 remote 的新仓库，
ID 解析结果仍是 `global`（V1 行为相同），第一次提交或加 remote 后下一次打开时会迁移到真正的 ID。

### 4. 两个附带功能（2026-10-03 确认：一起迁移）

- **favicon 图标发现**：仍由实验开关 `MIAO_EXPERIMENTAL_ICON_DISCOVERY` 控制（core `Flag` 补上同名开关）。
  登记完成后在位置作用域里后台运行：git 项目、还没有图标 URL/覆盖时，在 worktree 里找最短路径的
  `favicon.{ico,png,svg,jpg,jpeg,webp}`，转成 data URL 经 `ProjectMetadata.update` 写入（会发 `project.updated`）。
- **`time_initialized`**：V2 没有 `command.executed` 事件，改在 `V2Session.command` 执行 `init` 命令时，
  直接更新该会话所属项目的 `time_initialized`。

### 5. 与 `ProjectCopy` 的关系

core 的 `ProjectCopy.refreshAfterBoot` 只做"从已登记的源目录出发发现 git worktree 并补登记"，源目录本身
目前也靠 V1 写入。`ProjectRegistry` 登记打开的目录后，`ProjectCopy.refreshNode` 改为依赖它，保证先登记再刷新。

## 测试

- core 单测（真 git 仓库 + 临时数据库）：首次打开登记项目与目录；开关打开时发现 favicon；`init` 命令写入
  `time_initialized`；同仓库第二个检出目录进入 `sandboxes` 与
  `project_directory`；加 remote 后再打开，ID 迁移且会话、工作区跟过去，`.git/opencode` 写入新 ID；
  `global` 会话在目录变成 git 仓库后改挂；重复登记不产生多余事件。
- 路由测试：`git/init` 之后 `GET /api/project` 能看到该项目且 `vcs` 为 `git`。

## 实现记录（2026-10-03）

- core `ProjectRegistry`（`e3f5ee234`）：位置构建时登记；`Location` 新增 `previous`；`ProjectCopy.refreshNode` 依赖它；
  `V2Session.command` 执行 `init` 时写 `time_initialized`；core `Flag` 新增 `MIAO_EXPERIMENTAL_ICON_DISCOVERY`。
- V1 `Project.fromDirectory`/`discover` 委托 core（`ae9a3e750`）。
- `POST /api/project/git/init`（`ef8dff72c`）；app 的项目重命名、改色、编辑项目、初始化 git 改走 V2（`2b0e192f2`）。
- 顺带修复（`aed819d21`）：刚打开的目录插件尚未启动完时，`session.command` 执行插件提供的命令（`/init`、`/review`）
  会 404；现在先等插件启动。
