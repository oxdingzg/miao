package dev.miao.app.local

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * Phone photos are far larger than a model needs. Decode with a sampling hint,
 * shrink to [MAX_EDGE], then keep the small JPEG so a session file stays
 * reasonable. Returns null when the source is not a decodable image.
 */
object LocalImages {
    const val MAX_EDGE = 1024
    const val MAX_IMAGES = 4

    fun encode(context: Context, uri: Uri): String? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight)
        }
        val decoded = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
            ?: return null
        val scaled = scale(decoded)
        if (scaled !== decoded) decoded.recycle()
        return try {
            val output = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 70, output)
            Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } finally {
            scaled.recycle()
        }
    }

    fun decode(base64: String): Bitmap? {
        val bytes = try {
            Base64.decode(base64, Base64.NO_WRAP)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (bytes.isEmpty() || bytes.size > 4 * 1024 * 1024) return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    private fun sampleSize(width: Int, height: Int): Int {
        var sample = 1
        while (width / (sample * 2) >= MAX_EDGE && height / (sample * 2) >= MAX_EDGE) sample *= 2
        return sample
    }

    private fun scale(bitmap: Bitmap): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= MAX_EDGE) return bitmap
        val ratio = MAX_EDGE.toFloat() / longest
        val width = (bitmap.width * ratio).toInt().coerceAtLeast(1)
        val height = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
    }
}
