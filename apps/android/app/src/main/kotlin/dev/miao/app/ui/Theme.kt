package dev.miao.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Light = lightColorScheme(
    primary = Color(0xFF3F6212),
    secondary = Color(0xFF5B5F2B),
    tertiary = Color(0xFF3E6374),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFB5D680),
    secondary = Color(0xFFC4C8A0),
    tertiary = Color(0xFFA5CDE0),
)

@Composable
fun MiaoTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
