package dev.miao.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.miao.core.CredentialStorage
import dev.miao.core.IdentityStorage
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Device-only storage: an AndroidKeyStore AES key wraps the material and the
 * wrapped bytes live in the app-private directory. The wrapper key never leaves
 * the Keystore, and nothing here is backed up.
 */
private class KeystoreBox(context: Context, private val file: File) {
    private val alias = "miao.storage.v1"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun load(): ByteArray? {
        if (!file.exists()) return null
        val bytes = file.readBytes()
        if (bytes.size < 13) return null
        val nonce = bytes.copyOfRange(0, 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, nonce))
        return cipher.doFinal(bytes.copyOfRange(12, bytes.size))
    }

    fun save(bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(bytes)
        val temporary = File(file.parentFile, ".storage-" + System.nanoTime())
        temporary.writeBytes(sealed)
        if (!temporary.renameTo(file)) {
            file.delete()
            if (!temporary.renameTo(file)) throw IllegalStateException("unable to persist storage")
        }
    }

    fun remove() {
        if (file.exists()) file.delete()
    }
}

class KeystoreIdentityStorage(context: Context) : IdentityStorage {
    private val box = KeystoreBox(context, File(context.filesDir, "remote/device-key.bin"))

    override fun load(): ByteArray? = box.load()

    override fun save(bytes: ByteArray) = box.save(bytes)

    override fun remove() = box.remove()
}

class KeystoreCredentialStorage(context: Context, origin: String) : CredentialStorage {
    private val box = KeystoreBox(context, File(context.filesDir, "remote/account-" + origin.hashCode().toUInt() + ".bin"))

    override fun load(): String? = box.load()?.toString(Charsets.UTF_8)

    override fun save(credential: String) = box.save(credential.toByteArray(Charsets.UTF_8))

    override fun remove() = box.remove()
}
