package com.puhui.commenttranslator

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.puhui.commenttranslator.cache.TranslationStore
import com.puhui.commenttranslator.translation.TranslationClient
import java.nio.file.Path
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.atomic.AtomicLong

/** Shares three background workers and one persistent cache across projects in this IDE. */
@Service(Service.Level.APP)
class TranslationRuntime : Disposable {
    val workers = Executors.newFixedThreadPool(3) { runnable -> Thread(runnable, "comment-translator-worker").apply { isDaemon = true } }
    val settingsWorker = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "comment-translator-settings").apply { isDaemon = true } }
    val timer = ScheduledThreadPoolExecutor(1) { runnable -> Thread(runnable, "comment-translator-debounce").apply { isDaemon = true } }
        .apply { removeOnCancelPolicy = true }
    val client = TranslationClient()
    val cacheEpoch = AtomicLong()
    private val databaseLock = Any()
    private var database: TranslationStore? = null
    @Volatile private var closed = false

    /** Reads a translation lazily without opening SQLite on the UI thread. */
    fun cached(key: String): String? = synchronized(databaseLock) { store().get(key) }

    /** Commits only results still valid for the current cache epoch and file generation. */
    fun remember(epoch: Long, key: String, source: String, translation: String, context: String, valid: () -> Boolean) {
        synchronized(databaseLock) {
            if (epoch == cacheEpoch.get() && valid()) store().put(key, source, translation, context)
        }
    }

    /** Prevents any earlier task from repopulating the cleared database. */
    fun clearCache() { synchronized(databaseLock) { cacheEpoch.incrementAndGet(); store().clear() } }

    /** Cancels work and releases the native database and HTTP resources. */
    override fun dispose() {
        closed = true
        cacheEpoch.incrementAndGet(); timer.shutdownNow(); settingsWorker.shutdownNow(); workers.shutdownNow(); client.close()
        synchronized(databaseLock) { database?.close(); database = null }
    }

    private fun store(): TranslationStore {
        check(!closed) { "Translation runtime is closed" }
        return database ?: TranslationStore(Path.of(PathManager.getSystemPath(), "puhui-comment-translator", "translations.sqlite"))
            .also { database = it }
    }

    companion object {
        /** Returns the application-wide translation runtime. */
        fun getInstance(): TranslationRuntime = service()
    }
}
