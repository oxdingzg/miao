package dev.miao.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.miao.app.AppModel
import dev.miao.app.HostClient
import dev.miao.app.ModelChoice
import kotlinx.coroutines.launch

@Composable
fun AccountDialog(model: AppModel, onDismiss: () -> Unit) {
    var origin by rememberSaveable { mutableStateOf(model.accountURL) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var showEnrollment by rememberSaveable { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (model.accountSignedIn) "中继账号" else "登录中继") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (!model.accountSignedIn) {
                    Text("中继地址（留空使用默认 ${model.defaultAccountURL}）", fontSize = 12.sp)
                    OutlinedTextField(
                        value = origin,
                        onValueChange = { origin = it },
                        label = { Text("HTTPS 中继地址") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it },
                        label = { Text("邮箱") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("密码") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    model.accountError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
                    Button(
                        onClick = {
                            model.signIn(origin, email, password)
                            password = ""
                        },
                        enabled = !model.accountBusy && email.isNotBlank() && password.isNotBlank(),
                    ) { Text(if (model.accountBusy) "登录中…" else "登录") }
                    return@Column
                }
                Text(model.accountURL, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
                model.accountError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { model.refreshDirectory() }) { Text("刷新电脑") }
                    OutlinedButton(onClick = { model.signOut() }, enabled = !model.accountBusy) { Text("退出登录") }
                }
                if (model.discoveredHosts.isNotEmpty()) {
                    Text("账号电脑", style = MaterialTheme.typography.titleSmall)
                    model.discoveredHosts.forEach { host ->
                        Text("${host.name} · " + if (host.online) "在线" else "离线", fontSize = 12.sp)
                    }
                }
                HorizontalDivider()
                Row {
                    Text("同账号设备注册", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { showEnrollment = !showEnrollment }) {
                        Text(if (showEnrollment) "收起" else "展开")
                    }
                }
                if (!showEnrollment) return@Column
                Row {
                    Checkbox(
                        checked = model.enrollmentSignerConsent,
                        onCheckedChange = { model.enrollmentSignerConsent = it },
                    )
                    Text("我确认在电脑上把此设备选为账号签名设备", fontSize = 12.sp)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { model.initializeAccountSigner() },
                        enabled = model.enrollmentSignerConsent && !model.enrollmentBusy,
                    ) { Text("初始化签名设备") }
                    OutlinedButton(onClick = { model.createEnrollmentRequest() }, enabled = !model.enrollmentBusy) {
                        Text("生成注册码")
                    }
                }
                if (model.enrollmentSigner.isNotEmpty()) {
                    Text("签名公钥：${model.enrollmentSigner}", fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                }
                if (model.enrollmentRequest.isNotEmpty()) {
                    Text("本机注册码（交给已信任设备）", fontSize = 11.sp)
                    Text(model.enrollmentRequest, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                }
                OutlinedTextField(
                    value = model.enrollmentIncoming,
                    onValueChange = { model.enrollmentIncoming = it },
                    label = { Text("新设备注册码（批准用）") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 4,
                )
                OutlinedButton(onClick = { model.approveEnrollmentRequest() }, enabled = !model.enrollmentBusy) {
                    Text("批准新设备")
                }
                if (model.enrollmentResponse.isNotEmpty()) {
                    Text("批准结果（交给新设备）", fontSize = 11.sp)
                    Text(model.enrollmentResponse, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
                }
                OutlinedTextField(
                    value = model.enrollmentApproved,
                    onValueChange = { model.enrollmentApproved = it },
                    label = { Text("新设备：粘贴批准结果") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 4,
                )
                OutlinedTextField(
                    value = model.enrollmentPin,
                    onValueChange = { model.enrollmentPin = it },
                    label = { Text("批准设备的签名公钥") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Row {
                    Checkbox(
                        checked = model.enrollmentIndependentPin,
                        onCheckedChange = { model.enrollmentIndependentPin = it },
                    )
                    Text("我已通过独立渠道核对签名公钥", fontSize = 12.sp)
                }
                OutlinedButton(onClick = { model.receiveEnrollmentApproval() }, enabled = !model.enrollmentBusy) {
                    Text("完成注册")
                }
                model.enrollmentError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
                if (model.enrollmentComplete) Text("注册完成", color = MaterialTheme.colorScheme.primary, fontSize = 12.sp)
                if (model.enrollmentBusy) Text("处理中…", fontSize = 12.sp)
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

@Composable
fun PairingDialog(model: AppModel, initialLink: String, onDismiss: () -> Unit) {
    var link by rememberSaveable { mutableStateOf(initialLink) }
    var label by rememberSaveable { mutableStateOf("Android 设备") }
    val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
        result.contents?.let { link = it }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("配对电脑") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it },
                    label = { Text("配对链接（miao://pair#…）") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 3,
                )
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("设备名称") },
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        scanLauncher.launch(
                            ScanOptions().apply {
                                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                setPrompt("扫描电脑上的配对二维码")
                                setBeepEnabled(false)
                                setOrientationLocked(false)
                            },
                        )
                    }) { Text("扫描二维码") }
                    Button(
                        onClick = { model.pair(link, label) },
                        enabled = link.isNotBlank() && !model.pairingBusy(),
                    ) { Text("开始配对") }
                }
                model.pairing?.let { Text(it, fontSize = 13.sp) }
                model.fingerprint?.let {
                    Text("设备指纹：$it", fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                model.cancelPairing()
                onDismiss()
            }) { Text("取消") }
        },
    )
}

@Composable
fun ProvidersDialog(client: HostClient, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var keyProvider by remember { mutableStateOf<String?>(null) }
    var apiKey by remember { mutableStateOf("") }

    if (keyProvider != null) {
        AlertDialog(
            onDismissRequest = { keyProvider = null },
            title = { Text("连接密钥") },
            text = {
                Column {
                    Text("密钥只通过加密信道发送一次，不会保存到本机。", fontSize = 12.sp)
                    OutlinedTextField(
                        value = apiKey,
                        onValueChange = { apiKey = it },
                        label = { Text("API Key") },
                        visualTransformation = PasswordVisualTransformation(),
                        singleLine = true,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val provider = keyProvider
                    keyProvider = null
                    if (provider != null) scope.launch { client.connectProviderKey(provider, apiKey) }
                    apiKey = ""
                }) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = {
                    keyProvider = null
                    apiKey = ""
                }) { Text("取消") }
            },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Providers and models") },
        text = {
            Column(
                modifier = Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                client.providersError?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
                val directory = client.providers
                if (directory == null) {
                    Text("正在读取…", fontSize = 12.sp)
                    return@Column
                }
                directory.providers.forEach { provider ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(provider.name, style = MaterialTheme.typography.titleSmall)
                            Text(
                                (if (provider.connected) "已连接" else "未连接") +
                                    if (provider.allowsKey) " · 可用密钥" else "",
                                fontSize = 11.sp,
                            )
                            if (provider.editable) {
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    OutlinedButton(onClick = { keyProvider = provider.id }) { Text("连接密钥") }
                                    OutlinedButton(onClick = {
                                        scope.launch { client.disconnectProvider(provider.id) }
                                    }) { Text("断开") }
                                }
                            }
                        }
                    }
                }
                HorizontalDivider()
                Text("默认模型", style = MaterialTheme.typography.titleSmall)
                directory.selected?.let { Text("当前：${it.name}", fontSize = 12.sp) }
                directory.providers.forEach { provider ->
                    val models = directory.modelsOf(provider.id)
                    if (models.isEmpty()) return@forEach
                    Text(provider.name, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    models.take(12).forEach { model: ModelChoice ->
                        val selected = directory.selected?.key == model.key
                        TextButton(onClick = {
                            scope.launch { client.setDefaultModel(model) }
                        }) { Text((if (selected) "✓ " else "") + model.name) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}
