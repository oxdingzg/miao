package dev.miao.core

import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The raw key never goes into preferences, checkpoint files, cloud backup or logs. */
interface IdentityStorage {
    fun load(): ByteArray?
    fun save(bytes: ByteArray)
    fun remove()
}

class FileIdentityStorage(private val file: File) : IdentityStorage {
    override fun load(): ByteArray? = if (file.exists()) file.readBytes() else null

    override fun save(bytes: ByteArray) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, ".identity-" + System.nanoTime())
        temporary.writeBytes(bytes)
        if (!temporary.renameTo(file)) {
            file.delete()
            if (!temporary.renameTo(file)) throw ClientStateException(ClientStateException.Reason.INVALID_STORAGE)
        }
    }

    override fun remove() {
        if (file.exists()) file.delete()
    }
}

class MemoryIdentityStorage : IdentityStorage {
    private var bytes: ByteArray? = null

    override fun load(): ByteArray? = bytes?.copyOf()

    override fun save(bytes: ByteArray) {
        this.bytes = bytes.copyOf()
    }

    override fun remove() {
        bytes = null
    }
}

class DeviceIdentity(private val storage: IdentityStorage) {
    private val mutex = Mutex()
    private var key: P256SigningKey? = null

    suspend fun loadOrCreate(): P256SigningKey = mutex.withLock {
        key?.let { return it }
        val existing = storage.load()
        if (existing != null) {
            val loaded = P256SigningKey.fromEncoded(existing)
            key = loaded
            return loaded
        }
        val created = P256SigningKey.generate()
        storage.save(created.raw)
        key = created
        created
    }

    suspend fun remove() = mutex.withLock {
        key = null
        storage.remove()
    }
}
