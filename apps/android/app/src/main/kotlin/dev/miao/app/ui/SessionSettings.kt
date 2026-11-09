package dev.miao.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.miao.app.HostClient
import dev.miao.app.RemoteSession
import dev.miao.app.userMessage
import dev.miao.core.JsonValue
import dev.miao.core.OperationKind
import dev.miao.core.RemoteMethod
import kotlinx.coroutines.launch

private data class AgentChoice(val id: String, val description: String)

private data class ModelEntry(val id: String, val providerID: String, val name: String, val variants: List<String>) {
    val key: String get() = providerID + "/" + id
}

/** The phone may only pick from what the host advertises through `selection.list`. */
@Composable
fun SessionSettingsDialog(remote: RemoteSession, client: HostClient, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var agents by remember { mutableStateOf<List<AgentChoice>>(emptyList()) }
    var models by remember { mutableStateOf<List<ModelEntry>>(emptyList()) }
    var agent by remember { mutableStateOf<String?>(null) }
    var model by remember { mutableStateOf<ModelEntry?>(null) }
    var variant by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        try {
            val value = client.request(RemoteMethod.SelectionList, sessionID = remote.summary.id)
            val parsedAgents = (value["agents"]?.array ?: emptyList()).mapNotNull { item ->
                val id = item["id"]?.string ?: return@mapNotNull null
                AgentChoice(id, item["description"]?.string ?: "")
            }
            val parsedModels = (value["models"]?.array ?: emptyList()).mapNotNull { item ->
                val id = item["id"]?.string ?: return@mapNotNull null
                val providerID = item["providerID"]?.string ?: return@mapNotNull null
                ModelEntry(
                    id = id,
                    providerID = providerID,
                    name = item["name"]?.string ?: id,
                    variants = (item["variants"]?.array ?: emptyList()).mapNotNull { it["id"]?.string },
                )
            }
            if (parsedAgents.size > 256 || parsedModels.size > 4096) throw dev.miao.core.ProtocolIncompatibleException()
            agents = parsedAgents
            models = parsedModels
        } catch (error: Throwable) {
            failure = userMessage(error)
        } finally {
            loading = false
        }
    }

    fun apply() {
        val selectedAgent = agent
        val selectedModel = model
        if (selectedAgent == null && selectedModel == null) {
            onDismiss()
            return
        }
        busy = true
        scope.launch {
            try {
                if (selectedAgent != null) {
                    remote.command(
                        RemoteMethod.SessionSwitchAgent,
                        OperationKind.SessionSwitchAgent,
                        JsonValue.obj("agent" to JsonValue.of(selectedAgent)),
                    )
                }
                if (selectedModel != null) {
                    val fields = linkedMapOf<String, JsonValue>(
                        "id" to JsonValue.of(selectedModel.id),
                        "providerID" to JsonValue.of(selectedModel.providerID),
                    )
                    variant?.takeIf { it.isNotEmpty() }?.let { fields["variant"] = JsonValue.of(it) }
                    remote.command(
                        RemoteMethod.SessionSwitchModel,
                        OperationKind.SessionSwitchModel,
                        JsonValue.obj("model" to JsonValue.Obj(fields)),
                    )
                }
                onDismiss()
            } finally {
                busy = false
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("会话设置") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (loading) {
                    Text("正在读取会话设置…", fontSize = 12.sp)
                    return@Column
                }
                failure?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                    return@Column
                }
                if (agents.isNotEmpty()) {
                    Text("Agent", style = MaterialTheme.typography.titleSmall)
                    agents.forEach { choice ->
                        FilterChip(
                            selected = agent == choice.id,
                            onClick = { agent = if (agent == choice.id) null else choice.id },
                            label = { Text(choice.id) },
                        )
                        if (choice.description.isNotEmpty()) {
                            Text(choice.description, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                Text("模型", style = MaterialTheme.typography.titleSmall)
                models.take(120).forEach { entry ->
                    FilterChip(
                        selected = model?.key == entry.key,
                        onClick = {
                            model = if (model?.key == entry.key) null else entry
                            variant = null
                        },
                        label = { Text("${entry.name} · ${entry.providerID}") },
                    )
                }
                val variants = model?.variants ?: emptyList()
                if (variants.isNotEmpty()) {
                    Text("变体", style = MaterialTheme.typography.titleSmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        variants.forEach { id ->
                            FilterChip(
                                selected = variant == id,
                                onClick = { variant = if (variant == id) null else id },
                                label = { Text(id) },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { apply() }, modifier = Modifier.fillMaxWidth(), enabled = !busy) {
                Text(if (busy) "应用中…" else "应用")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
