# SDK → schema/client 迁移对照表（P5）

> 只读生成，基于 HEAD `4e18af0c4` + 当前工作树。SDK 包为 `@miao/sdk`（WIP 重命名中），旧名为 `@opencode-ai/sdk`。

## 0. 路径一致性（回答 rebase 需求）

已核对 `git show HEAD:packages/sdk/js/package.json`：重命名前包名 `@opencode-ai/sdk`，exports map 与工作树 `@miao/sdk` **完全一致**：

```
"./v2": "./src/v2/index.ts",
"./v2/client": "./src/v2/client.ts",
"./v2/gen/client": "./src/v2/gen/client/index.ts",
"./v2/server": "./src/v2/server.ts",
"./v2/types": "./src/v2/gen/types.gen.ts"
```

因此所有符号在 `@opencode-ai/sdk/v2` 与 `@miao/sdk/v2` 下的 subpath **100% 一致**；rebase 只需替换包名，不需调整 subpath。`@opencode-ai/sdk` 仅残留在 `plugin/dist/**` 构建产物，源码 0 处。

## 1. 现行 import 面

| 包 | import 文件数 | 主要 specifier |
|---|---|---|
| app | 96 | `@miao/sdk/v2`, `@miao/sdk/v2/client` |
| tui | 52（src 38） | `@miao/sdk/v2`, `@miao/sdk/v2/client` |
| session-ui | 16 | `@miao/sdk/v2`, `@miao/sdk/v2/client` |
| plugin | 13 | `@miao/sdk/v2`, `@miao/sdk/v2/types` |
| miao | 39（src 24） | `@miao/sdk/v2` |
| cli | 0 | — |
| sdk-next | 0 | — |
| storybook | 1 | `@miao/sdk/v2/client` |

生成的 `types.gen.ts` 导出约 1024 个符号，下游实际用到约 120 个。

## 2. 规范映射

状态：✅直接换路径 / ⚠️形状或 brand 调整 / 🔁需改运行时 / 🆕暂无等价。所有行 subpath 前后一致（见 §0），故省略该列。

### 会话 V1 视图 → `@miao/schema/session-v1`（别名见 `schema/src/v1/session.ts:679-683`）

| SDK 符号 | 目标 | 状态 |
|---|---|---|
| Message | `SessionV1.Message` | ✅ |
| UserMessage | `SessionV1.User` | ✅ |
| AssistantMessage | `SessionV1.Assistant` | ✅ |
| Session | `SessionV1.SessionInfo` | ✅ |
| Part | `SessionV1.Part` | ✅ |
| ToolPart | `SessionV1.ToolPart` | ✅ |
| TextPart / ReasoningPart / FilePart / AgentPart | 同名 | ✅ |
| FilePartSource | `SessionV1.FilePartSource` | ✅ |
| ToolState | `SessionV1.ToolState`（或 `session-message.ToolState`） | ✅ |

### 文件 / VCS

| SDK 符号 | 目标 | 状态 |
|---|---|---|
| FileNode / FileContent | `@miao/schema/filesystem-v1`（`v1/filesystem.ts:7,17`） | ✅ |
| SnapshotFileDiff | `@miao/schema/vcs` | ✅ |
| VcsFileDiff / VcsFileStatus / VcsInfo | `@miao/schema/vcs`（`vcs.ts:49-51`） | ✅ |

### V2 视图

| SDK 符号 | 目标 | 状态 |
|---|---|---|
| AgentV2Info | `@miao/schema/agent` `Info` | ✅ |
| Agent (V1) | `@miao/schema/agent-view` `Agent` | ✅ |
| CommandV2Info | `@miao/schema/command` `Info` | ✅ |
| Command (V1) | `@miao/schema/command-view` `Command` | ✅ |
| ProviderV2Info | `@miao/schema/provider` `Info` | ✅ |
| Provider (V1) | `@miao/schema/provider-view` `Provider` | ✅ |
| Model (V1) | `@miao/schema/provider-view` `Model` | ⚠️ |
| ModelV2Info | `@miao/schema/model` `Info` | ✅ |
| SessionV2Info | `@miao/schema/session-info` `Info` | ✅ |
| SessionMessage | `@miao/schema/session-message` `Message` | ✅ |
| SessionMessageAssistant | `session-message.Assistant` | ✅ |
| SessionMessageAssistantText/Tool/Reasoning | `session-message.AssistantText/AssistantTool/AssistantReasoning` | ✅ |
| SessionStatus | `@miao/schema/session-status-event` `SessionStatus` | ✅ |
| Todo | `@miao/schema/session-todo` `Todo` | ✅ |
| FormatterStatus | `@miao/schema/format-view` `FormatterStatus` | ✅ |
| LspStatus | `@miao/schema/lsp-view` `LspStatus` | ✅ |
| McpStatus | `@miao/schema/mcp` `Status` | ✅ |
| McpServerStatus | `@miao/schema/mcp` `Status`（SDK 拆两名，同一 union） | ✅ |
| McpResource | `@miao/schema/mcp` `Resource` | ✅ |
| Project | `@miao/schema/project` `Info` | ✅ |
| Workspace | `@miao/schema/workspace` `Info` | ✅ |
| WorkspaceAdapterEntry | `workspace.AdapterEntry` | ✅ |
| LocationRef | `@miao/schema/location` `Ref` | ✅ |
| LocationInfo | `@miao/schema/location` `Info` | ✅ |
| Config | `@miao/schema/config` `Config.Info`（旧为整型，V2 为 class） | ⚠️ |
| Auth | `@miao/schema/auth-view` `Auth` | ✅ |
| ProviderAuthMethod | `@miao/schema/provider-auth-view` `ProviderAuthMethod` | ✅ |

### Question / Permission

| SDK 符号 | 目标 | 状态 |
|---|---|---|
| QuestionInfo / QuestionAnswer | `@miao/schema/question`（`question.ts:101-102` 别名） | ✅ |
| QuestionV2Request | `question.Request` | ✅ |
| QuestionV2Answer | `question.Answer` | ✅ |
| QuestionRequest (V1) | `@miao/schema/question-v1` `QuestionV1.Request`（或 V2 `question.Request`） | ⚠️ |
| PermissionV2Request | `@miao/schema/permission` `Request` | ✅ |
| PermissionRequest (V1) | `@miao/schema/permission-v1` `PermissionV1.Request`（或 V2） | ⚠️ |
| PermissionSavedInfo | `@miao/schema/permission-saved` `Info` | ✅ |

### Integration / Credential / Reference / Skill / LLM / Prompt / FS

| SDK 符号 | 目标 | 状态 |
|---|---|---|
| IntegrationInfo | `@miao/schema/integration` `Info` | ✅ |
| IntegrationAttempt | `integration.Attempt` | ✅ |
| IntegrationRef | `integration.Ref` | ✅ |
| IntegrationInputs | `integration.Inputs` | ✅ |
| IntegrationMethod | `integration.Method` | ⚠️名称 |
| IntegrationEnvMethod / KeyMethod / OAuthMethod | `integration.EnvMethod/KeyMethod/OAuthMethod` | ⚠️名称 |
| ConnectionInfo | `@miao/schema/connection` `Info` | ✅ |
| CredentialValue | `@miao/schema/credential` `Value` | ⚠️名称 |
| CredentialOAuth | `credential.OAuth` | ⚠️名称 |
| ReferenceInfo | `@miao/schema/reference` `Info` | ✅ |
| ReferenceGitSource / ReferenceLocalSource | `reference.GitSource/LocalSource` | ⚠️名称 |
| FileSystemEntry | `@miao/schema/filesystem` `Entry` | ✅ |
| SkillV2Info / SkillV2Source | `@miao/schema/skill` `Info`/`Source` | ✅ |
| LlmToolContent | `@miao/schema/llm` `ToolContent` | ✅ |
| PromptInput | `@miao/schema/prompt-input` `PromptInput` | ✅ |

## 3. 暂无等价 / 需新定义 🆕

| SDK 符号 | 现状 / 目标 |
|---|---|
| GlobalEvent | schema 无。TUI 自定于 `tui/src/context/sdk.tsx:8`。建议在 schema 定义 `{directory,project,workspace,payload}` 信封 |
| EventSessionError | `app/src/context/notification.tsx:12,35`。用 `session-event.SessionEvent.Failed` 或 `v1/session` error，需确认 wire 形状 |
| V2SessionListResponse | 无；用 `@miao/client` `SessionsListOutput`/`SessionsActiveOutput` |
| LocationPath | 无 schema；`@miao/client` 已有 `LocationPathOutput`（types.ts:389，`{home,state,config,worktree,directory}`）。可直接用或下沉 `Location.Path` |
| ProjectDirectory | 无 schema；= `ProjectsDirectoriesOutput["data"][number]`（`{directory,strategy?}`），建议下沉 `@miao/schema/project` |
| Event / V2Event（订阅联合） | 用 `@miao/client` `OpenCodeEvent`/`EventsSubscribeOutput`（types.ts:3216）或 `@miao/schema/event-manifest` `Latest` |
| data 命名空间、ServerOptions/TuiOptions/createMiaoServer/createMiaoTui/createMiao | 无 core 等价（进程派生），保留在 CLI/SDK 包，勿下沉 schema |

错误类型 `SessionNotFoundError`/`PermissionNotFoundError` 等 → ✅ `@miao/client` generated types + `is*` guard。

## 4. 运行时改动 🔁

| 旧 | 新 |
|---|---|
| `createMiaoClient(config)` | `@miao/client` 的 `OpenCode.make({ baseUrl, ... })` |
| `MiaoClient`（类型） | `ReturnType<typeof OpenCode.make>` |
| `OpencodeClient`/`createOpencodeClient`（仅 plugin/dist） | 同上 |

中心点：`app/src/utils/server.ts:1,36,46`、`app/src/context/server-sync.tsx`、`tui/src/context/sdk.tsx:1,32`、`plugin/src/index.ts:12`、`miao/src/cli/cmd/run/runtime.ts`。事件订阅改用客户端 events/SSE（适配点 `app/src/context/server-sdk.tsx`、`tui/src/context/data.tsx`）。

## 5. 分包要点

- **app（96）**：context 15、components 14、context/global-sync 13、utils 9、timeline 8、composer 7、pages/session 7、components/session 5、pages/layout 4、context/file 4、prompt-input 3。网络收敛到 `utils/server.ts`+`server-sdk.tsx`；视图类型走 session-v1/filesystem-v1/vcs。
- **tui（52/src 38）**：`context/sdk.tsx` 唯一 client 入口；`data.tsx`/`v2-adapters.ts` 吃 V2 类型；`dialog-move-session.tsx` 的 `ProjectDirectory` 待新定义。
- **session-ui（16）**：纯展示，最简单，全部 session-v1/vcs/filesystem-v1。
- **plugin（13）**：`src/index.ts`/`src/tui.ts` + `v2/effect/*`、`v2/promise/*`；`dist/**` 勿手改。
- **miao（39/src 24）**：`cli/cmd/run/*` 与 provider 插件；`MiaoClient`→`OpenCode.make`，`SessionMessage/ToolPart/PermissionRequest`→schema。
- **cli / sdk-next**：0 直接 import。
- **storybook（1）**：`ProviderAuthMethod` → `@miao/schema/provider-auth-view` 或 mock 对齐 client。

## 6. 建议顺序

1. `@miao/client` 运行时切换（暴露 Input/Output 差异）。
2. 批量 `session-v1`/`filesystem-v1`/`vcs`/`*-view` 视图替换。
3. 处理 🆕（GlobalEvent、EventSessionError、V2SessionListResponse、LocationPath、ProjectDirectory），优先下沉 schema。
