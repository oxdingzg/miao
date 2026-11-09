package dev.miao.core

/** A transport snapshot. Deliberately not persisted: checkpoints contain durable history only. */
class LiveSessionProjection private constructor(
    private val messageID: String?,
    private val parts: List<JsonValue>,
) {
    constructor(value: JsonValue?) : this(
        messageID = value?.let { readMessageID(it) },
        parts = value?.let { readParts(it) } ?: emptyList(),
    )

    fun displaying(messages: List<Map<String, JsonValue>>): List<Map<String, JsonValue>> = messages.map { message ->
        val id = message["id"]?.string
        if (id != messageID || message["type"]?.string != "assistant" || message["time"]?.get("completed") != null) {
            return@map message
        }
        val content = (message["content"]?.array ?: emptyList()).map { part ->
            val partMap = part.objectMap ?: return@map part
            val live = parts.firstOrNull { it["id"] == partMap["id"] && it["kind"] == partMap["type"] }
            if (live == null || partMap["text"]?.string != "") return@map part
            val text = live["text"]?.string ?: ""
            val replaced = if (live["truncated"]?.bool == true) {
                text + "\n实时预览已达长度上限，完整内容将在完成后同步。"
            } else {
                text
            }
            JsonValue.Obj(partMap.toMutableMap().also { it["text"] = JsonValue.of(replaced) })
        }
        JsonValue.Obj(message.toMutableMap().also { it["content"] = JsonValue.Arr(content) })
            .objectMap ?: message
    }

    companion object {
        private const val MAX_REVISION = 9_007_199_254_740_991L
        private const val MAX_PART_BYTES = 256 * 1024
        private const val MAX_TOTAL_BYTES = 4 * 1024 * 1024

        private fun readMessageID(value: JsonValue): String? {
            val epoch = value["epoch"]?.string
            if (epoch.isNullOrEmpty() || epoch.length > 64) throw ProtocolIncompatibleException()
            val revision = value["revision"]?.long ?: throw ProtocolIncompatibleException()
            if (revision < 0 || revision > MAX_REVISION) throw ProtocolIncompatibleException()
            val raw = value["parts"]?.array ?: throw ProtocolIncompatibleException()
            if (raw.size > 32) throw ProtocolIncompatibleException()
            val messageID = value["messageID"]?.takeUnless { it == JsonValue.Null }?.string
            if (messageID != null && (messageID.isEmpty() || messageID.length > 256)) throw ProtocolIncompatibleException()
            var bytes = 0
            val seen = mutableSetOf<String>()
            for (part in raw) {
                val id = part["id"]?.string
                val kind = part["kind"]?.string
                val text = part["text"]?.string
                if (id.isNullOrEmpty() || id.length > 256 || kind !in setOf("text", "reasoning") || text == null) {
                    throw ProtocolIncompatibleException()
                }
                if (text.length > MAX_PART_BYTES || part["truncated"]?.bool == null) throw ProtocolIncompatibleException()
                if (!seen.add(kind + ":" + id)) throw ProtocolIncompatibleException()
                bytes += text.length
            }
            if (bytes > MAX_TOTAL_BYTES) throw ProtocolIncompatibleException()
            if (messageID == null && raw.isNotEmpty()) throw ProtocolIncompatibleException()
            return messageID
        }

        private fun readParts(value: JsonValue): List<JsonValue> = value["parts"]?.array ?: emptyList()
    }
}
