package dev.miao.core

/**
 * Durable full-value boundaries, never provider work. A page replaces state only
 * after every event succeeds.
 */
data class SessionTimeline(
    val messages: List<Map<String, JsonValue>> = emptyList(),
    val cursor: Long = 0,
    val title: String = "",
    val revert: JsonValue? = null,
) {
    fun toJson(): JsonValue = JsonValue.obj(
        "messages" to JsonValue.Arr(messages.map { JsonValue.Obj(it) }),
        "cursor" to JsonValue.of(cursor),
        "title" to JsonValue.of(title),
        "revert" to (revert ?: JsonValue.Null),
    )

    fun apply(page: JsonValue, sessionID: String): SessionTimeline {
        val events = page["data"]?.array ?: throw ProtocolIncompatibleException()
        if (events.size > 100 || page["hasMore"]?.bool == null) throw ProtocolIncompatibleException()
        var next = this
        for (event in events) {
            val durable = event["durable"] ?: throw ProtocolIncompatibleException()
            val sequence = durable["seq"]?.long ?: throw ProtocolIncompatibleException()
            if (sequence <= next.cursor || sequence > MAX_SEQUENCE) throw ProtocolIncompatibleException()
            if (durable["aggregateID"]?.string != sessionID) throw ProtocolIncompatibleException()
            if (event["data"]?.get("sessionID")?.string != sessionID) throw ProtocolIncompatibleException()
            val type = event["type"]?.string ?: throw ProtocolIncompatibleException()
            val version = durable["version"]?.long ?: throw ProtocolIncompatibleException()
            val allowedVersion = version == 1L || (version == 2L && type in setOf("session.next.step.ended", "session.next.step.failed"))
            if (!allowedVersion) throw ProtocolIncompatibleException()
            val data = event["data"]?.objectMap ?: throw ProtocolIncompatibleException()
            next = next.update(type, data, event["metadata"]).copy(cursor = sequence)
        }
        if (next.messages.size > 10_000) throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
        return next
    }

    private fun update(type: String, data: Map<String, JsonValue>, metadata: JsonValue?): SessionTimeline {
        val timestamp = data["timestamp"] ?: JsonValue.of(0)
        fun required(key: String): String =
            data[key]?.string?.takeIf { it.isNotEmpty() } ?: throw ProtocolIncompatibleException()

        fun base(id: String, kind: String): MutableMap<String, JsonValue> = linkedMapOf(
            "id" to JsonValue.of(id),
            "type" to JsonValue.of(kind),
            "time" to JsonValue.obj("created" to timestamp),
            "metadata" to (metadata ?: JsonValue.Null),
        )

        var next = this
        when (type) {
            "session.next.created" -> next = next.copy(title = data["info"]?.get("title")?.string ?: title)
            "session.next.info.updated" -> next = next.copy(title = data["title"]?.string ?: title)
            "session.next.prompt.admitted", "session.next.moved", "session.next.retried",
            "session.next.compaction.started",
            -> Unit

            "session.next.revert.staged" -> next = next.copy(revert = data["revert"])
            "session.next.revert.cleared" -> next = next.copy(revert = null)
            "session.next.revert.committed" -> {
                val id = required("messageID")
                val index = next.messages.indexOfFirst { it["id"]?.string == id }
                if (index >= 0) next = next.copy(messages = next.messages.subList(0, index))
                next = next.copy(revert = null)
            }

            "session.next.prompted" -> {
                val value = base(required("messageID"), "user")
                data["prompt"]?.objectMap?.forEach { (key, item) -> value[key] = item }
                next = next.append(value)
            }

            "session.next.agent.switched", "session.next.model.switched" -> {
                val field = if (type == "session.next.agent.switched") "agent" else "model"
                val value = base(required("messageID"), field + "-switched")
                data[field]?.let { value[field] = it }
                next = next.append(value)
            }

            "session.next.context.updated", "session.next.synthetic" -> {
                val value = base(required("messageID"), if (type == "session.next.synthetic") "synthetic" else "system")
                data["text"]?.let { value["text"] = it }
                if (type == "session.next.synthetic") {
                    data["sessionID"]?.let { value["sessionID"] = it }
                    data["metadata"]?.let { value["metadata"] = it }
                }
                next = next.append(value)
            }

            "session.next.shell.started" -> {
                val value = base(required("messageID"), "shell")
                data["callID"]?.let { value["callID"] = it }
                data["command"]?.let { value["command"] = it }
                value["output"] = JsonValue.of("")
                next = next.append(value)
            }

            "session.next.shell.ended" -> {
                val id = required("callID")
                val index = next.messages.indexOfLast { it["type"]?.string == "shell" && it["callID"]?.string == id }
                if (index >= 0) {
                    val value = next.messages[index].toMutableMap()
                    value["output"] = data["output"] ?: JsonValue.Null
                    val time = (value["time"]?.objectMap ?: emptyMap()).toMutableMap()
                    time["completed"] = timestamp
                    value["time"] = JsonValue.Obj(time)
                    next = next.copy(messages = next.messages.toMutableList().also { it[index] = value })
                }
            }

            "session.next.step.started" -> {
                val lastAssistant = next.messages.indexOfLast { it["type"]?.string == "assistant" }
                if (lastAssistant >= 0) {
                    val value = next.messages[lastAssistant].toMutableMap()
                    if (value["time"]?.get("completed") == null) {
                        val time = (value["time"]?.objectMap ?: emptyMap()).toMutableMap()
                        time["completed"] = timestamp
                        value["time"] = JsonValue.Obj(time)
                        next = next.copy(messages = next.messages.toMutableList().also { it[lastAssistant] = value })
                    }
                }
                val value = linkedMapOf(
                    "id" to JsonValue.of(required("assistantMessageID")),
                    "type" to JsonValue.of("assistant"),
                    "time" to JsonValue.obj("created" to timestamp),
                    "agent" to (data["agent"] ?: JsonValue.Null),
                    "model" to (data["model"] ?: JsonValue.Null),
                    "content" to JsonValue.Arr(emptyList()),
                )
                data["snapshot"]?.let { value["snapshot"] = JsonValue.obj("start" to it) }
                next = next.append(value)
            }

            "session.next.step.ended", "session.next.step.failed" -> {
                val id = required("assistantMessageID")
                val failed = type == "session.next.step.failed"
                next = next.updateAssistant(id) { value ->
                    val time = (value["time"]?.objectMap ?: emptyMap()).toMutableMap()
                    time["completed"] = timestamp
                    value["time"] = JsonValue.Obj(time)
                    if (failed) {
                        value["finish"] = JsonValue.of("error")
                        data["error"]?.let { value["error"] = it }
                    } else {
                        for (key in listOf("finish", "cost", "tokens", "ttft")) data[key]?.let { value[key] = it }
                        if (data["snapshot"] != null || data["files"] != null) {
                            val snapshot = (value["snapshot"]?.objectMap ?: emptyMap()).toMutableMap()
                            snapshot["end"] = data["snapshot"] ?: JsonValue.Null
                            snapshot["files"] = data["files"] ?: JsonValue.Null
                            value["snapshot"] = JsonValue.Obj(snapshot)
                        }
                    }
                }
            }

            "session.next.text.started", "session.next.reasoning.started", "session.next.tool.input.started" -> {
                val kind = when (type) {
                    "session.next.text.started" -> "text"
                    "session.next.reasoning.started" -> "reasoning"
                    else -> "tool"
                }
                val id = required(
                    when (kind) {
                        "text" -> "textID"
                        "reasoning" -> "reasoningID"
                        else -> "callID"
                    },
                )
                val part = linkedMapOf<String, JsonValue>("type" to JsonValue.of(kind), "id" to JsonValue.of(id))
                if (kind == "tool") {
                    data["name"]?.let { part["name"] = it }
                    part["time"] = JsonValue.obj("created" to timestamp)
                    part["state"] = JsonValue.obj("status" to JsonValue.of("pending"), "input" to JsonValue.of(""))
                } else {
                    part["text"] = JsonValue.of("")
                    if (kind == "reasoning") {
                        part["time"] = JsonValue.obj("created" to timestamp)
                        part["providerMetadata"] = data["providerMetadata"] ?: JsonValue.Null
                    }
                }
                val messageID = required("assistantMessageID")
                next = next.updateAssistant(messageID) { value ->
                    val content = (value["content"]?.array ?: emptyList()).toMutableList()
                    content += JsonValue.Obj(part)
                    value["content"] = JsonValue.Arr(content)
                }
            }

            "session.next.text.ended", "session.next.reasoning.ended", "session.next.tool.input.ended",
            "session.next.tool.called", "session.next.tool.progress", "session.next.tool.success",
            "session.next.tool.failed",
            -> {
                val kind = when (type) {
                    "session.next.text.ended" -> "text"
                    "session.next.reasoning.ended" -> "reasoning"
                    else -> "tool"
                }
                val id = required(
                    when (kind) {
                        "text" -> "textID"
                        "reasoning" -> "reasoningID"
                        else -> "callID"
                    },
                )
                val messageID = required("assistantMessageID")
                next = next.updateAssistant(messageID) { value ->
                    val parts = (value["content"]?.array ?: emptyList()).toMutableList()
                    val index = parts.indexOfLast { it["id"]?.string == id && it["type"]?.string == kind }
                    if (index < 0) return@updateAssistant
                    val part = parts[index].objectMap?.toMutableMap() ?: return@updateAssistant
                    if (kind != "tool") {
                        data["text"]?.let { part["text"] = it }
                        if (kind == "reasoning") {
                            val time = (part["time"]?.objectMap ?: emptyMap()).toMutableMap()
                            time["created"] = time["created"] ?: timestamp
                            time["completed"] = timestamp
                            part["time"] = JsonValue.Obj(time)
                            data["providerMetadata"]?.let { part["providerMetadata"] = it }
                        }
                    } else {
                        var state = (part["state"]?.objectMap ?: emptyMap()).toMutableMap()
                        val time = (part["time"]?.objectMap ?: emptyMap()).toMutableMap()
                        when (type) {
                            "session.next.tool.input.ended" ->
                                if (state["status"]?.string == "pending") data["text"]?.let { state["input"] = it }

                            "session.next.tool.called" -> {
                                state = linkedMapOf(
                                    "status" to JsonValue.of("running"),
                                    "input" to (data["input"] ?: JsonValue.obj()),
                                    "structured" to JsonValue.obj(),
                                    "content" to JsonValue.Arr(emptyList()),
                                )
                                data["provider"]?.let { part["provider"] = it }
                                time["ran"] = timestamp
                            }

                            "session.next.tool.progress" ->
                                if (state["status"]?.string == "running") {
                                    data["structured"]?.let { state["structured"] = it }
                                    data["content"]?.let { state["content"] = it }
                                }

                            "session.next.tool.success", "session.next.tool.failed" -> {
                                val failed = type == "session.next.tool.failed"
                                val status = state["status"]?.string
                                if (status == "running" || (failed && status == "pending")) {
                                    val provider = part["provider"]
                                    val final = linkedMapOf<String, JsonValue>(
                                        "status" to JsonValue.of(if (failed) "error" else "completed"),
                                        "input" to (state["input"] ?: JsonValue.obj()),
                                        "structured" to (if (failed) state["structured"] ?: JsonValue.obj() else data["structured"] ?: JsonValue.obj()),
                                        "content" to (if (failed) state["content"] ?: JsonValue.Arr(emptyList()) else data["content"] ?: JsonValue.Arr(emptyList())),
                                    )
                                    if (failed) data["error"]?.let { final["error"] = it }
                                    data["result"]?.let { final["result"] = it }
                                    if (!failed) final["outputPaths"] = data["outputPaths"] ?: JsonValue.Arr(emptyList())
                                    state = final
                                    time["completed"] = timestamp
                                    val executed = provider?.get("executed")?.bool == true || data["provider"]?.get("executed")?.bool == true
                                    part["provider"] = JsonValue.obj(
                                        "executed" to JsonValue.of(executed),
                                        "metadata" to (provider?.get("metadata") ?: JsonValue.Null),
                                        "resultMetadata" to (data["provider"]?.get("metadata") ?: JsonValue.Null),
                                    )
                                }
                            }

                            else -> Unit
                        }
                        part["state"] = JsonValue.Obj(state)
                        part["time"] = JsonValue.Obj(time)
                    }
                    parts[index] = JsonValue.Obj(part)
                    value["content"] = JsonValue.Arr(parts)
                }
            }

            "session.next.compaction.ended" -> {
                val value = base(required("messageID"), "compaction")
                data["text"]?.let { value["summary"] = it }
                data["recent"]?.let { value["recent"] = it }
                data["reason"]?.let { value["reason"] = it }
                next = next.append(value)
            }

            else -> throw ProtocolIncompatibleException()
        }
        return next
    }

    private fun append(value: Map<String, JsonValue>): SessionTimeline {
        val id = value["id"] ?: throw ProtocolIncompatibleException()
        if (messages.any { it["id"] == id }) throw ProtocolIncompatibleException()
        return copy(messages = messages + value)
    }

    private fun updateAssistant(id: String, update: (MutableMap<String, JsonValue>) -> Unit): SessionTimeline {
        val index = messages.indexOfLast { it["id"]?.string == id && it["type"]?.string == "assistant" }
        if (index < 0) return this
        val value = messages[index].toMutableMap()
        update(value)
        return copy(messages = messages.toMutableList().also { it[index] = value })
    }

    companion object {
        private const val MAX_SEQUENCE = 9_007_199_254_740_991L

        fun fromJson(value: JsonValue): SessionTimeline {
            val messages = (value["messages"]?.array ?: throw ProtocolIncompatibleException()).map {
                it.objectMap ?: throw ProtocolIncompatibleException()
            }
            if (messages.size > 10_000) throw ClientStateException(ClientStateException.Reason.LIMIT_EXCEEDED)
            return SessionTimeline(
                messages = messages,
                cursor = value["cursor"]?.long ?: throw ProtocolIncompatibleException(),
                title = value["title"]?.string ?: "",
                revert = value["revert"]?.takeUnless { it == JsonValue.Null },
            )
        }
    }
}
