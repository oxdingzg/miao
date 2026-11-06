import Foundation

/// A provider the app already knows how to reach. Picking one fills the URL and
/// a default model, so adding a service is normally just pasting a key.
struct LocalPreset: Identifiable, Sendable, Hashable {
    let id: String
    let name: String
    let baseURL: String
    let models: [String]

    var defaultModel: String { models.first ?? "" }
}

enum LocalPresets {
    static let all: [LocalPreset] = [
        LocalPreset(id: "volcengine", name: "火山引擎", baseURL: "https://ark.cn-beijing.volces.com/api/v3",
                    models: ["deepseek-v4-1-flash-261017", "doubao-seed-2-1-pro-260915", "kimi-k3-1-pro-261024"]),
        LocalPreset(id: "zhipu", name: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4",
                    models: ["glm-5.3", "glm-5.3-flash", "glm-4.6v"]),
        LocalPreset(id: "deepseek", name: "DeepSeek", baseURL: "https://api.deepseek.com/v1",
                    models: ["deepseek-chat", "deepseek-reasoner"]),
        LocalPreset(id: "openai", name: "OpenAI", baseURL: "https://api.openai.com/v1",
                    models: ["gpt-5.1", "gpt-5.1-mini"]),
        LocalPreset(id: "moonshot", name: "月之暗面 Kimi", baseURL: "https://api.moonshot.cn/v1",
                    models: ["kimi-k2-turbo-preview"]),
        LocalPreset(id: "dashscope", name: "阿里云百炼", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    models: ["qwen3-max", "qwen3-coder-plus"]),
        LocalPreset(id: "siliconflow", name: "硅基流动", baseURL: "https://api.siliconflow.cn/v1",
                    models: ["deepseek-ai/DeepSeek-V3.2"]),
        LocalPreset(id: "openrouter", name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1",
                    models: ["anthropic/claude-sonnet-4.5"]),
    ]

    static func named(_ id: String) -> LocalPreset? { all.first { $0.id == id } }
}
