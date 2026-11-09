package dev.miao.app.local

import dev.miao.core.CanonicalJson
import dev.miao.core.JsonValue
import java.util.UUID

data class LocalProvider(
    val id: String = UUID.randomUUID().toString(),
    val name: String = "",
    val baseURL: String = "",
    val apiKey: String = "",
    val model: String = "",
) {
    val ready: Boolean get() = baseURL.isNotBlank() && apiKey.isNotBlank() && model.isNotBlank()

    fun toJson(): JsonValue = JsonValue.obj(
        "id" to JsonValue.of(id),
        "name" to JsonValue.of(name),
        "baseURL" to JsonValue.of(baseURL),
        "apiKey" to JsonValue.of(apiKey),
        "model" to JsonValue.of(model),
    )

    companion object {
        fun fromJson(value: JsonValue): LocalProvider = LocalProvider(
            id = value["id"]?.string ?: UUID.randomUUID().toString(),
            name = value["name"]?.string ?: "",
            baseURL = value["baseURL"]?.string ?: "",
            apiKey = value["apiKey"]?.string ?: "",
            model = value["model"]?.string ?: "",
        )
    }
}

data class LocalMessage(
    val id: String = UUID.randomUUID().toString(),
    val role: Role,
    val text: String,
    val toolName: String? = null,
    val images: List<String> = emptyList(),
) {
    enum class Role(val wire: String) {
        User("user"),
        Assistant("assistant"),
        Tool("tool"),
        ;

        companion object {
            fun fromWire(value: String): Role? = entries.firstOrNull { it.wire == value }
        }
    }

    fun toJson(): JsonValue = JsonValue.obj(
        "id" to JsonValue.of(id),
        "role" to JsonValue.of(role.wire),
        "text" to JsonValue.of(text),
        "toolName" to (toolName?.let { JsonValue.of(it) } ?: JsonValue.Null),
        "images" to JsonValue.Arr(images.map { JsonValue.of(it) }),
    )

    companion object {
        fun fromJson(value: JsonValue): LocalMessage? {
            val role = Role.fromWire(value["role"]?.string ?: return null) ?: return null
            return LocalMessage(
                id = value["id"]?.string ?: UUID.randomUUID().toString(),
                role = role,
                text = value["text"]?.string ?: "",
                toolName = value["toolName"]?.string,
                images = (value["images"]?.array ?: emptyList()).mapNotNull { it.string },
            )
        }
    }
}

data class LocalSession(
    val id: String = UUID.randomUUID().toString(),
    val title: String = "",
    val messages: List<LocalMessage> = emptyList(),
    val updated: Long = System.currentTimeMillis(),
) {
    fun toJson(): JsonValue = JsonValue.obj(
        "id" to JsonValue.of(id),
        "title" to JsonValue.of(title),
        "messages" to JsonValue.Arr(messages.map { it.toJson() }),
        "updated" to JsonValue.of(updated),
    )

    companion object {
        fun fromJson(value: JsonValue): LocalSession? {
            val id = value["id"]?.string ?: return null
            return LocalSession(
                id = id,
                title = value["title"]?.string ?: "",
                messages = (value["messages"]?.array ?: emptyList()).mapNotNull { LocalMessage.fromJson(it) },
                updated = value["updated"]?.long ?: 0,
            )
        }

        fun listJson(sessions: List<LocalSession>): ByteArray =
            CanonicalJson.encodeBytes(JsonValue.Arr(sessions.map { it.toJson() }))
    }
}

/** A provider the app already knows how to reach, so adding one is usually just a key. */
data class LocalPreset(val id: String, val name: String, val baseURL: String, val models: List<String>) {
    val defaultModel: String get() = models.firstOrNull() ?: ""
}

object LocalPresets {
    val all = listOf(
        LocalPreset(
            "volcengine",
            "火山引擎",
            "https://ark.cn-beijing.volces.com/api/v3",
            listOf("deepseek-v4-1-flash-261017", "doubao-seed-2-1-pro-260915", "kimi-k3-1-pro-261024"),
        ),
        LocalPreset("zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4", listOf("glm-5.3", "glm-5.3-flash", "glm-4.6v")),
        LocalPreset("deepseek", "DeepSeek", "https://api.deepseek.com/v1", listOf("deepseek-chat", "deepseek-reasoner")),
        LocalPreset("openai", "OpenAI", "https://api.openai.com/v1", listOf("gpt-5.1", "gpt-5.1-mini")),
        LocalPreset("moonshot", "月之暗面 Kimi", "https://api.moonshot.cn/v1", listOf("kimi-k2-turbo-preview")),
        LocalPreset(
            "dashscope",
            "阿里云百炼",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            listOf("qwen3-max", "qwen3-coder-plus"),
        ),
        LocalPreset("siliconflow", "硅基流动", "https://api.siliconflow.cn/v1", listOf("deepseek-ai/DeepSeek-V3.2")),
        LocalPreset("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", listOf("anthropic/claude-sonnet-4.5")),
    )

    fun named(id: String): LocalPreset? = all.firstOrNull { it.id == id }
}
