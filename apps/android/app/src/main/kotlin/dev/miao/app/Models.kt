package dev.miao.app

import dev.miao.core.JsonValue
import dev.miao.core.ProtocolIncompatibleException

data class SessionSummary(
    val id: String,
    val title: String,
    val projectID: String,
    val archived: Boolean,
    val pinned: Boolean,
) {
    companion object {
        fun parse(value: JsonValue): SessionSummary = SessionSummary(
            id = value["id"]?.string ?: throw ProtocolIncompatibleException(),
            title = value["title"]?.string ?: throw ProtocolIncompatibleException(),
            projectID = value["projectID"]?.string ?: throw ProtocolIncompatibleException(),
            archived = value["time"]?.get("archived") != null,
            pinned = value["time"]?.get("pinned") != null,
        )
    }
}

/** One Session that waits on the phone: a tool approval, a question, or both. */
data class InboxEntry(
    val sessionID: String,
    val title: String,
    val projectID: String,
    val actions: List<String>,
    val questions: List<String>,
) {
    val count: Int get() = actions.size + questions.size

    val summary: String
        get() = actions.firstOrNull() ?: questions.firstOrNull() ?: "等待你的处理"

    companion object {
        fun parse(value: JsonValue): InboxEntry = InboxEntry(
            sessionID = value["sessionID"]?.string ?: throw ProtocolIncompatibleException(),
            title = value["title"]?.string ?: throw ProtocolIncompatibleException(),
            projectID = value["projectID"]?.string ?: throw ProtocolIncompatibleException(),
            actions = (value["permissions"]?.array ?: emptyList()).mapNotNull { it["action"]?.string },
            questions = (value["questions"]?.array ?: emptyList()).mapNotNull { it["text"]?.string },
        )
    }
}

/** One provider as the phone may see it; credential values never travel back. */
data class ProviderSummary(
    val id: String,
    val name: String,
    val connected: Boolean,
    val allowsKey: Boolean,
    val environment: List<String>,
) {
    val editable: Boolean get() = allowsKey

    companion object {
        fun parse(value: JsonValue): ProviderSummary {
            val methods = value["methods"]?.array ?: emptyList()
            return ProviderSummary(
                id = value["id"]?.string ?: throw ProtocolIncompatibleException(),
                name = value["name"]?.string ?: throw ProtocolIncompatibleException(),
                connected = value["connected"]?.bool ?: false,
                allowsKey = methods.any { it["type"]?.string == "key" },
                environment = methods.filter { it["type"]?.string == "env" }
                    .flatMap { it["names"]?.array?.mapNotNull { name -> name.string } ?: emptyList() },
            )
        }
    }
}

data class ModelChoice(val providerID: String, val modelID: String, val name: String) {
    val key: String get() = providerID + "/" + modelID

    companion object {
        fun parse(value: JsonValue): ModelChoice = ModelChoice(
            providerID = value["providerID"]?.string ?: throw ProtocolIncompatibleException(),
            modelID = value["id"]?.string ?: throw ProtocolIncompatibleException(),
            name = value["name"]?.string ?: throw ProtocolIncompatibleException(),
        )
    }
}

data class ProviderDirectory(
    val providers: List<ProviderSummary>,
    val models: List<ModelChoice>,
    val defaults: Map<String, String>,
) {
    fun modelsOf(providerID: String): List<ModelChoice> = models.filter { it.providerID == providerID }

    val selected: ModelChoice?
        get() = providers.firstNotNullOfOrNull { provider ->
            val modelID = defaults[provider.id] ?: return@firstNotNullOfOrNull null
            models.firstOrNull { it.providerID == provider.id && it.modelID == modelID }
        }

    companion object {
        fun parse(value: JsonValue): ProviderDirectory? {
            val providers = value["providers"]?.array ?: return null
            val models = value["models"]?.array ?: return null
            val parsed = providers.map { ProviderSummary.parse(it) }
            return ProviderDirectory(
                providers = parsed.sortedBy { it.name.lowercase() },
                models = models.map { ModelChoice.parse(it) },
                defaults = (value["default"]?.objectMap ?: emptyMap()).mapNotNull { (key, item) ->
                    item.string?.let { key to it }
                }.toMap(),
            )
        }
    }
}
