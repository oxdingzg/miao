# RUS-05：JS 运行时与可选 worker 边界

状态：**设计与可选 worker 发布入口修复；Rust 化尚未完成**。基线源码为 `4fbd5f01341206de1d29a5af58dac7185466ac97`。本项接续 [控制面责任图](rus03-control-plane-responsibilities.md) 和 [TS runner 退役边界](https://github.com/oxdingzg/miao/blob/e509b14de27a2c6c41e980d936f53391fdec50bc/specs/rus02-ts-runner-retirement.md)；后者尚待独立 PR 合入。

## 1. 当前必需依赖和可选依赖

| 分类                | 当前使用位置                                                                     | 安装与缺失行为                                                                              | 退役或保留条件                                                      |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 默认产品必需        | 编译版 `miao` 的 CLI 启动、产品配置/凭据装配、`serve`/产品 HTTP、ACP、原生引擎桥 | 发布 CLI 内含 Bun 的 JS 运行时；不需要另装 `bun` 命令，但 JS 仍是产品必需部分               | Rust 接管对应产品入口、持久化权威、认证与管理行为并验收后，才能删除 |
| 兼容执行路径        | `--engine ts`、旧 TS Session、`--tui ts` 及其宿主服务                            | 当前仍随产品保留；不能把编译后没有 `.ts` 文件当成无 JS 依赖                                 | 服从 RUS-02 的客户端/数据迁移验收和明确回滚窗口                     |
| 可选项目工具 worker | ADR-12 `worker-host`，仅在 `MIAO_ENGINE_WORKER=1` 时创建                         | 使用固定 argv 和 protocol 2 握手；加载失败只使扩展工具不可用，原生内置工具继续可用          | 保留为显式兼容能力，不能成为默认 Session 核心的隐式依赖             |
| 可选外部服务        | 用户注册的 MCP、LSP、formatter、shell 和自定义工具的外部程序                     | 所需 Node、Python、语言服务器或项目 npm 依赖由相应能力显式声明/安装；不在模型执行中静默安装 | 按能力记录安装、授权、缺失诊断和取消行为，不把所有程序归为“JS 内核” |
| 仅开发、构建和测试  | `miao-dev`、Bun 工作区脚本、TypeScript 检查、代码生成、前端构建、离线夹具        | 源码开发需要 Bun/依赖树；发布用户不应为开发命令安装它们                                     | 可以保留，不构成默认运行时的常驻服务                                |

上述分类不是 npm lockfile 中每一个包的可达性证明。具体管理入口见 RUS-03；执行/调度/inbox/权限逐文件清单见 RUS-02。前端使用 JS 和 Session 权威留在 JS 是两个独立验收维度。

## 2. 可选 worker 的发布契约

原实现把 `[process.execPath, src/engine/worker-host.ts]` 写进固定的系统临时文件。这依赖源码入口，且两个服务可能覆盖同一个配置文件。单文件发布的 `miao` 必须能启动它自己的 worker。

本切片使用 [WorkerConfig](../packages/miao/src/engine/worker-config.ts) 建立以下边界：

- 编译版重执行自己保留的对应版本二进制，命令为 `miao __worker-host`；不启动外部 `bun`，也不引用发布包外的源码入口。
- 开发模式通过当前 Bun 和源码 `index.ts __worker-host` 进入同一个协议实现。隐藏入口在正常命令装配、内嵌引擎物化之前处理，stdout 保持为协议帧。
- 每个服务创建独立的临时配置目录，scope 关闭后清理；配置必须位于模型工作区外，由引擎继续检查位置、大小和受保护路径。
- worker 在 `hello` 阶段接收工作目录并发现工具；引擎在握手成功后请求工具清单和调用。工具调用仍走原生引擎的外部工具授权与 durable 调度；worker 不能成为 Session、历史、权限或重试的权威。
- 可信配置通过校验后，缺失 worker、握手失败或崩溃保留现有 `extension worker unavailable` 诊断，内置工具继续工作；不合法或位于工作区内的配置会直接拒绝引擎启动。项目工具加载错误当前仅保存在 worker 的 debug 列表中，对外诊断仍需收口；失败不会自动切回 TS provider loop。

worker 只能兼容现有项目自定义工具接口。它不能承诺加载任意 provider 插件；原生路由不支持的 SDK/协议必须明确报错，或另行设计可选 provider adapter。项目工具自己导入的包（例如插件 SDK）仍须在该项目中可解析，编译 worker 不能替项目安装全部依赖。

## 3. Rust 化完成的判定

1. 默认启动、持续会话、CLI/HTTP/ACP 控制面和持久化恢复都不需要常驻 TS 宿主，也不需要编译进启动器的 JS 来承担必需产品逻辑。
2. 每个保留功能都有 Rust 实现或明确接受的替代、迁移及真实客户端记录；删除按关注点拆 PR。不能仅用 Rust TUI 或“用户没有安装 Bun”证明 Rust 化完成。
3. 禁用或移除兼容 worker 后，默认内置能力、准入、权限、历史、恢复和费用归因仍独立工作；扩展能力的缺失可见且范围明确。
4. 插件/外部工具的可选运行时有明确安装方式和错误诊断；已安装但不可用的依赖不能让主引擎静默退回另一套执行权威。
5. 经过迁移和发布回滚窗口后才删除 TS runner/host。开发与测试工具链、前端语言选择和 MIT 许可保留独立处理。

## 4. 验证范围

[worker-config 集成测试](../packages/miao/test/engine/worker-config.test.ts) 检查独立 manifest、scope 清理及真实 stdio `hello/list/call/error/shutdown`。设置 `MIAO_WORKER_HOST_BIN` 可检查实际编译二进制；同一变量让 [原生工具集成](../packages/miao/test/engine/native-worker-tools.test.ts) 通过编译 CLI 验证引擎到 worker 的调用链。

源码用例、编译产物和各平台结果分别记录。此设计与 worker 入口修复不关闭 RUS-05 的全部跨平台发布验收，也不关闭 REL-04 的 Rust 化完成门槛。
