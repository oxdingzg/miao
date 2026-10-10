# 项目来源与许可

[English](attribution.en.md)

## 来源与致谢

miao 是衍生自 [opencode](https://github.com/anomalyco/opencode) 的开源 AI 智能体。
代码库中相当一部分来自 opencode 的 MIT 授权实现。感谢其作者与贡献者提供的终端编程工作流和工程基础。

miao 作为单独的项目维护，有自己的开发方向、问题追踪和发布版本。
代码来源关系不代表与 opencode 维护者存在隶属关系或获得其背书。
miao 的问题反馈与版本下载请使用 [oxdingzg/miao](https://github.com/oxdingzg/miao)。

## 许可与再分发

miao 以 [MIT 许可证](../LICENSE) 发布，许可证文件保留两条版权声明：

```text
Copyright (c) 2026 the miao authors
Copyright (c) 2025 opencode
```

MIT 在其条款下允许使用、修改与再分发，包括商业使用。
分发软件副本或其中的实质性部分时，必须包含版权声明及授权声明；免责条款仍是许可证的一部分。
第三方组件继续适用各自的许可证和声明，根许可证不替代这些条款。

## 供应商与兼容接口

代码来源与模型供应商选择是不同的关系。miao 无需项目账号即可本地运行；模型访问使用你选择的供应商的凭证，并适用该供应商的条款。
OpenCode Zen 与 Go 是可选的第三方供应商，其名称、ID 和端点标识这些服务。

`.opencode/` 配置回退等兼容标识用于描述受支持的接口，不改变项目维护或许可关系。
当前行为见[供应商与模型](providers.zh.md)和[使用指南](guide.zh.md)。
