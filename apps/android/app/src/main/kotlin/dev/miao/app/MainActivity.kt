package dev.miao.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.miao.app.ui.MiaoRoot
import dev.miao.app.ui.MiaoTheme
import dev.miao.core.ClientScenePhase

class MainActivity : ComponentActivity() {
    private val model: AppModel by lazy { AppModel(applicationContext) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MiaoTheme {
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                DisposableEffect(lifecycle) {
                    val observer = LifecycleEventObserver { _, event ->
                        when (event) {
                            Lifecycle.Event.ON_START -> model.scenePhase(ClientScenePhase.ACTIVE)
                            Lifecycle.Event.ON_STOP -> model.scenePhase(ClientScenePhase.BACKGROUND)
                            else -> Unit
                        }
                    }
                    lifecycle.addObserver(observer)
                    onDispose { lifecycle.removeObserver(observer) }
                }
                LaunchedEffect(Unit) { model.load() }
                LaunchedEffect(Unit) { handleLink(intent) }
                MiaoRoot(model)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    private fun handleLink(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        if (data.startsWith("miao://pair")) model.incomingPairLink = data
    }
}
