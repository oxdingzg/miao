# V2 全局配置写入（`PATCH /api/config`）

状态：设计稿，2026-10-03，待确认。P7 剩余项之一：替代 V1 的 `PATCH /global/config` 与随之的
`global.dispose` / `instance.dispose`，让 app 的设置页（shell、禁用 provider、自定义 provider）在 V2 下可用。

## 现状（按代码核实）

- **读取**：core `Config` 在位置服务层构建时读一次，之后由 `LocationServiceMap`（`LayerMap`，空闲 60 分钟回收）
  缓存整个位置生命周期。全局目录下依次读取 `miao.json`、`miao.jsonc`、`opencode.json`、`opencode.jsonc`，
  后读的覆盖先读的。V2 没有任何配置重载或文件监听（`catalog-config-plugin-lifecycle.md` 标为待设计）。
- **格式判定**：文件里只要出现一个 V1 键（`provider`、`permission`、`disabled_providers`、`agent`…），
  整份文件就按 V1 解码再迁移；V2 独有的键（`providers`、`permissions`）会被静默丢弃。解码失败时整份文件被忽略。
- **V1 写入**（`packages/miao/src/config/config.ts` `updateGlobal`）：选第一个存在的 `miao.jsonc` / `miao.json` /
  `opencode.*` / `config.json`，用 jsonc-parser 逐键 patch（保留注释），写完销毁所有 V1 实例。注意它会写
  `config.json`，而 core 根本不读这个文件。
- **app 写入的键**：`shell`、`disabled_providers`、`provider.<id>`（自定义 provider）——全是 V1 键。
  其中 `disabled_providers` 在 V1→V2 迁移里没有映射（V2 对应 `providers.<id>.disabled`），所以 app 的
  "禁用 provider" 在 V2 下本来就不生效。
- **凭据**：catalog 每次调用都现查 `integrations.list()`，凭据增删实时生效，不需要 dispose。
- **本机实情**：`~/.config/miao/miao.jsonc` 是 V1 格式（`$schema`、`model`、`permission`、`lsp`、`provider`）。

## 方案

### 1. 接口

`PATCH /api/config`，只改用户全局配置（项目级配置不在本轮范围）。

- 请求体：V2 形状的部分配置，JSON merge-patch 语义（对象递归合并，`null` 删除该键）。
- 拒绝 V1 键（400，`InvalidRequestError` 列出键名），防止把 V2 文件"翻转"成 V1 解码而丢数据。
- 写前校验：把 patch 应用到目标文件后，用与读取完全相同的解析与解码规则（jsonc + `Config.Info`）再解一次，
  失败则 400 且不写盘。
- 响应：合并后的全局配置文档。

### 2. 写到哪个文件

全局目录里按 core 的读取顺序，选**优先级最高的已存在文件**（最后被读的那个），保证写入的值不会被别的文件覆盖；
都不存在时新建 `miao.json`。不再写 `config.json`。

### 3. 目标文件是 V1 格式时（需要决策）

V2 键写进 V1 文件会被整份按 V1 解码忽略，所以必须处理：

- **A（推荐）首次写入时迁移成 V2**：用读取时同一套 `ConfigMigrateV1.migrate` 把文件转为 V2 形状再 patch，
  原文件备份为 `<name>.v1-<时间戳>.bak`。语义与 V2 现在读到的完全一致（就是同一个迁移函数）；代价是 jsonc 注释丢失一次。
  0.0.35 的 V1 读取路径经 `v2-compat.ts` 能读 V2 文件；更老的二进制（如 4132 上的 0.0.21）读不了。
- B 拒绝写入（409），提示先运行新增的 `miao config migrate`：最安全，但设置页在迁移前一直不可用。
- C 按文件格式翻译 patch（V1 文件写 V1 键）：需要维护 V2→V1 的逐键映射，`disabled_providers` 这类 V2 不认的键
  仍然无效，不建议。

### 4. 生效（取代 dispose）

写盘成功且内容有变化时：

1. 对 `LocationServiceMap` 的每个已打开位置调用 `invalidate`。`LayerMap` 基于 `RcMap`：条目立即移出，正在使用的
   引用（进行中的会话 drain）继续用旧配置直到释放，下一个请求按新配置重建。
2. 发布 EventV2 `config.updated`（新定义，加入 `ServerDefinitions`）。app 已经在监听这个事件名并重新 bootstrap；
   TUI 同样订阅后刷新。
3. V1 侧：保持现有 `PATCH /global/config` 不动，直到 V1 路由整体删除。

app 侧随之：`updateConfig` 改走 `PATCH /api/config` 并发 V2 键（`shell`、`providers.<id>.disabled`、`providers.<id>`）；
删除 `global.dispose` / `instance.dispose` 调用（凭据实时生效，配置由第 4 步生效）；去掉 `protocol !== "v1"` 的提前返回。

### 5. 实现位置

- core：`ConfigWrite`（全局 node，依赖 `FSUtil`、`Global`），负责选文件、迁移、patch、校验、写盘；jsonc 补丁沿用
  `jsonc-parser` 的 `modify`/`applyEdits`（与 V1 相同，保留注释）。
- protocol/server：`config.update` 端点；handler 在构造期取 `ConfigWrite`、`LocationServiceMap`、`EventV2`。
- 测试：core 单测覆盖选文件、V1 迁移与备份、拒绝 V1 键、校验失败不写盘；路由测试验证写后新请求读到新值、
  `config.updated` 事件到达。

## 不在本轮

- 项目级配置写入、配置文件监听（手改文件后自动生效）、插件 transform 重载。
