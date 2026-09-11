package com.puhui.commenttranslator.cache

import com.puhui.commenttranslator.translation.PROMPT_VERSION
import com.puhui.commenttranslator.translation.ProviderConfig
import com.puhui.commenttranslator.translation.normalizeEndpoint
import org.sqlite.JDBC
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.sql.Connection
import java.util.Properties

private const val SCHEMA_VERSION = 1
private const val DEFAULT_CAPACITY = 10_000

/** Builds a content/configuration key without credentials or source file paths. */
fun cacheKey(text: String, languageId: String, config: ProviderConfig): String {
    val values = listOf(text, languageId, normalizeEndpoint(config.baseUrl), config.model, config.targetLanguage, PROMPT_VERSION, config.prompt)
    val json = values.joinToString(prefix = "[", postfix = "]", separator = ",", transform = ::jsonString)
    return MessageDigest.getInstance("SHA-256").digest(json.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

/** Serializes only nonsecret cache metadata; custom prompt contents are represented by a hash. */
fun cacheContext(languageId: String, config: ProviderConfig): String {
    val promptHash = MessageDigest.getInstance("SHA-256").digest(config.prompt.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    return listOf(languageId, normalizeEndpoint(config.baseUrl), config.model, config.targetLanguage, PROMPT_VERSION, promptHash)
        .joinToString(prefix = "[", postfix = "]", separator = ",", transform = ::jsonString)
}

// Match JSON.stringify's string escaping, including lone UTF-16 surrogates.
private fun jsonString(value: String): String = buildString {
    append('"')
    value.forEachIndexed { index, character ->
        when (character) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000C' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (character.code < 0x20 ||
                character.isHighSurrogate() && !value.getOrNull(index + 1).let { it != null && it.isLowSurrogate() } ||
                character.isLowSurrogate() && !value.getOrNull(index - 1).let { it != null && it.isHighSurrogate() }) {
                append("\\u").append(character.code.toString(16).padStart(4, '0'))
            } else append(character)
        }
    }
    append('"')
}

/** Independent JDBC cache; never point this at a database actively managed by the VS Code extension. */
class TranslationStore(
    databasePath: Path,
    private val maxEntries: Int = DEFAULT_CAPACITY,
    private val now: () -> Long = System::currentTimeMillis,
) : AutoCloseable {
    private val connection: Connection
    private var closed = false

    init {
        require(maxEntries > 0) { "Cache capacity must be positive." }
        val path = databasePath.toAbsolutePath().normalize()
        val existed = Files.exists(path)
        if (existed && (!Files.isRegularFile(path) || Files.size(path) == 0L)) {
            throw IllegalStateException("翻译缓存文件无效，已保留原文件。")
        }
        Files.createDirectories(path.parent)
        var opened: Connection? = null
        try {
            // Direct construction also works with an isolated IDE plugin classloader.
            opened = JDBC().connect("jdbc:sqlite:$path", Properties())
                ?: throw IllegalStateException("无法加载 SQLite。")
            connection = opened
            connection.createStatement().use { statement ->
                statement.execute("PRAGMA busy_timeout = 5000")
                if (existed) {
                    statement.executeQuery("PRAGMA quick_check").use { if (!it.next() || it.getString(1) != "ok") error("Invalid cache integrity") }
                    statement.executeQuery("PRAGMA user_version").use { if (!it.next() || it.getInt(1) != SCHEMA_VERSION) error("Unsupported cache schema") }
                    statement.executeQuery("SELECT cache_key, original_text, translated_text, context, created_at, last_accessed, access_order FROM translations LIMIT 0").close()
                }
                statement.execute("PRAGMA journal_mode = WAL")
            }
            transaction {
                if (!existed) connection.createStatement().use { statement ->
                    statement.execute("CREATE TABLE translations (cache_key TEXT PRIMARY KEY, original_text TEXT NOT NULL, translated_text TEXT NOT NULL, context TEXT NOT NULL, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL, access_order INTEGER NOT NULL)")
                    statement.execute("CREATE INDEX translations_access_order ON translations(access_order)")
                    statement.execute("PRAGMA user_version = $SCHEMA_VERSION")
                }
                prune()
            }
        } catch (_: Exception) {
            runCatching { opened?.close() }
            throw IllegalStateException("无法打开本地翻译缓存，已保留现有数据。")
        }
    }

    /** Returns a reusable translation and updates its LRU position; reads do not expire entries. */
    @Synchronized
    fun get(key: String): String? = transaction {
        // Acquire the SQLite write reservation before reading, avoiding a stale WAL snapshot upgrade.
        connection.prepareStatement("UPDATE translations SET last_accessed = MAX(last_accessed, ?), access_order = (SELECT COALESCE(MAX(access_order), 0) + 1 FROM translations) WHERE cache_key = ?").use {
            it.setLong(1, now())
            it.setString(2, key)
            it.executeUpdate()
        }
        connection.prepareStatement("SELECT translated_text FROM translations WHERE cache_key = ?").use {
            it.setString(1, key)
            it.executeQuery().use { rows -> if (rows.next()) rows.getString(1) else null }
        }
    }

    /** Persists a successful result; context must contain only nonsecret metadata such as [cacheContext]. */
    @Synchronized
    fun put(key: String, source: String, translation: String, context: String) {
        checkOpen()
        if (translation.isBlank()) return
        require(key.isNotEmpty()) { "Cache key must not be empty." }
        transaction {
            connection.prepareStatement("""
                INSERT INTO translations(cache_key, original_text, translated_text, context, created_at, last_accessed, access_order)
                VALUES(?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(access_order), 0) + 1 FROM translations))
                ON CONFLICT(cache_key) DO UPDATE SET original_text = excluded.original_text,
                    translated_text = excluded.translated_text, context = excluded.context,
                    created_at = excluded.created_at, last_accessed = excluded.last_accessed, access_order = excluded.access_order
            """.trimIndent()).use {
                val timestamp = now()
                it.setString(1, key)
                it.setString(2, source)
                it.setString(3, translation)
                it.setString(4, context)
                it.setLong(5, timestamp)
                it.setLong(6, timestamp)
                it.executeUpdate()
            }
            prune()
        }
    }

    /** Deletes all cached results in one durable transaction. */
    @Synchronized
    fun clear() = transaction {
        connection.createStatement().use { it.executeUpdate("DELETE FROM translations") }
        Unit
    }

    /** Closes the database connection; repeated close calls are harmless. */
    @Synchronized
    override fun close() {
        if (closed) return
        connection.close()
        closed = true
    }

    private fun prune() {
        connection.prepareStatement("DELETE FROM translations WHERE cache_key IN (SELECT cache_key FROM translations ORDER BY access_order DESC LIMIT -1 OFFSET ?)").use {
            it.setInt(1, maxEntries)
            it.executeUpdate()
        }
    }

    private fun <T> transaction(work: () -> T): T {
        checkOpen()
        try {
            connection.autoCommit = false
            val result = work()
            connection.commit()
            return result
        } catch (_: Exception) {
            runCatching { connection.rollback() }
            throw IllegalStateException("无法读写本地翻译缓存，请稍后重试。")
        } finally {
            connection.autoCommit = true
        }
    }

    private fun checkOpen() = check(!closed) { "翻译缓存已关闭。" }
}
