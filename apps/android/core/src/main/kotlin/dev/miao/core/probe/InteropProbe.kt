// Test-only peer for checking the TypeScript wire contract.
// It deliberately trusts the test input key and must never be used as an Agent.
package dev.miao.core.probe

import dev.miao.core.ApprovedHost
import dev.miao.core.AuthorizedHost
import dev.miao.core.CanonicalJson
import dev.miao.core.ChannelException
import dev.miao.core.ClientHello
import dev.miao.core.DeviceGrant
import dev.miao.core.HostHandshake
import dev.miao.core.HubAccountException
import dev.miao.core.HubPushNotice
import dev.miao.core.JsonValue
import dev.miao.core.P256SigningKey
import dev.miao.core.PushContext
import dev.miao.core.PushContextBinding
import dev.miao.core.PushContextPayload
import dev.miao.core.RemotePermission
import dev.miao.core.RemoteTarget
import kotlinx.coroutines.runBlocking

fun main() {
    val identity = P256SigningKey.generate()
    emit(JsonValue.obj("signingKey" to JsonValue.of(identity.publicKeyEncoded)))

    val clientHello = ClientHello.fromJson(CanonicalJson.parse(readLine() ?: fail("missing client hello")))
    val accepted = HostHandshake.accept(
        identity = identity,
        target = RemoteTarget(clientHello.hostID, clientHello.runtimeID),
        connectionID = "interop-connection-000000",
        client = clientHello,
        trustedDeviceKey = clientHello.signingKey,
    )
    emit(accepted.hello.asJson())

    val packet = readLine() ?: fail("missing sealed packet")
    val plaintext = runBlocking { accepted.session.open(packet) }
    val reply = runBlocking { accepted.session.seal("Kotlin result".toByteArray()) }
    emit(
        JsonValue.obj(
            "packet" to JsonValue.of(reply),
            "plaintext" to JsonValue.of(String(plaintext, Charsets.UTF_8)),
        ),
    )

    val push = CanonicalJson.parse(readLine() ?: fail("missing push context"))
    val binding = PushContextBinding(
        hostID = push["binding"]?.get("hostID")?.string ?: fail("binding.hostID"),
        runtimeID = push["binding"]?.get("runtimeID")?.string ?: fail("binding.runtimeID"),
        grantID = push["binding"]?.get("grantID")?.string ?: fail("binding.grantID"),
        grantVersion = push["binding"]?.get("grantVersion")?.long ?: fail("binding.grantVersion"),
        deviceID = push["binding"]?.get("deviceID")?.string ?: fail("binding.deviceID"),
        signalID = push["binding"]?.get("signalID")?.string ?: fail("binding.signalID"),
    )
    val pinnedHostKey = push["pinnedHostKey"]?.string ?: fail("pinnedHostKey")
    val context = push["context"]?.string ?: fail("context")
    val opened = PushContext.open(context, identity, pinnedHostKey, binding)

    val notice = HubPushNotice(binding = binding, context = context, kind = "attention")
    check(notice.resolve(identity, authorizedHost(binding, pinnedHostKey, opened)) == opened) { "resolve mismatch" }
    for (change in listOf("version", "permissions", "project", "expiry", "revoked")) {
        try {
            notice.resolve(identity, authorizedHost(binding, pinnedHostKey, opened, change))
            fail("resolve accepted $change")
        } catch (_: HubAccountException) {
        }
    }
    try {
        PushContext.open(context, identity, identity.publicKeyEncoded, binding)
        fail("accepted a foreign pinned host key")
    } catch (_: ChannelException) {
    }
    try {
        PushContext.open(context, identity, pinnedHostKey, binding.copy(signalID = "signal-" + "0".repeat(24)))
        fail("accepted a substituted signal")
    } catch (_: ChannelException) {
    }
    emit(opened.toJson())
}

private fun authorizedHost(
    binding: PushContextBinding,
    pinnedHostKey: String,
    payload: PushContextPayload,
    change: String? = null,
): AuthorizedHost {
    val grant = DeviceGrant(
        id = binding.grantID,
        version = binding.grantVersion.toInt(),
        publicKey = binding.deviceID,
        label = "Phone",
        permissions = listOf(RemotePermission.Read),
        projectIDs = listOf(payload.projectID),
        sessionIDs = emptyList(),
        createdAt = 0,
        expiresAt = payload.expiresAt,
        revokedAt = null,
    )
    val changed = when (change) {
        "version" -> grant.copy(version = binding.grantVersion.toInt() + 1)
        "permissions" -> grant.copy(permissions = listOf(RemotePermission.Prompt))
        "project" -> grant.copy(projectIDs = listOf("other-project"))
        "expiry" -> grant.copy(expiresAt = 0)
        "revoked" -> grant.copy(revokedAt = 1)
        else -> grant
    }
    val host = ApprovedHost.create(
        label = "Computer",
        hubURL = "https://relay.example.invalid",
        target = RemoteTarget(binding.hostID, binding.runtimeID),
        publicKey = pinnedHostKey,
        grantID = binding.grantID,
        grantVersion = binding.grantVersion.toInt(),
    )
    return AuthorizedHost(host, changed)
}

private fun PushContextPayload.toJson(): JsonValue = JsonValue.obj(
    "sessionID" to JsonValue.of(sessionID),
    "projectID" to JsonValue.of(projectID),
    "expiresAt" to JsonValue.of(expiresAt),
)

private fun emit(value: JsonValue) {
    println(CanonicalJson.encode(value))
}

private fun readLine(): String? = kotlin.io.readLine()

private fun fail(message: String): Nothing = throw IllegalStateException(message)
