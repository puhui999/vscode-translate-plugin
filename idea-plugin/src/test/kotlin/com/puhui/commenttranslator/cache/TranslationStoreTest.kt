package com.puhui.commenttranslator.cache

import com.puhui.commenttranslator.translation.ProviderConfig
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.sqlite.JDBC
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class TranslationStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val config = ProviderConfig("https://example.test/v1", "test-model", "fake-secret", prompt = "Keep API terms.")
    private fun path(): Path = temporary.newFolder().toPath().resolve("translations.sqlite")

    @Test fun cacheKeysMatchJavaScriptGoldenVectorsAndNeverDependOnCredentials() {
        assertEquals("5d0602270d5e38f441bedd5285efca4aa3638433d1ed688a82a16e18ab0423b0", cacheKey("Read the user profile.", "java", config))
        assertEquals("92fe1790224ab7fa29c214e2e6fff1be1b86b1d42837e0d898d4b6e405910977", cacheKey("Read 😀 \"x\"\\\n\u2028\u2029\uD800", "java", config))
        val key = cacheKey("Text", "java", config)
        assertEquals(key, cacheKey("Text", "java", config.copy(apiKey = "changed")))
        assertEquals(key, cacheKey("Text", "java", config.copy(baseUrl = "https://example.test:443/v1/chat/completions/")))
        assertNotEquals(key, cacheKey("Changed", "java", config))
        assertNotEquals(key, cacheKey("Text", "kotlin", config))
        listOf(config.copy(baseUrl = "https://other.test/v1"), config.copy(model = "other"), config.copy(targetLanguage = "English"), config.copy(prompt = "Other terms")).forEach {
            assertNotEquals(key, cacheKey("Text", "java", it))
        }
        assertFalse(cacheContext("java", config).contains(config.apiKey))
        assertFalse(cacheContext("java", config).contains(config.prompt))
    }

    @Test fun storesActualSourceAndTranslationAndPersistsAcrossReopen() {
        val database = path()
        val key = cacheKey("Original source", "java", config)
        TranslationStore(database).use {
            assertNull(it.get(key))
            it.put(key, "Original source", "原文译文", cacheContext("java", config))
            assertEquals("原文译文", it.get(key))
        }
        TranslationStore(database).use { assertEquals("原文译文", it.get(key)) }
        JDBC().connect("jdbc:sqlite:$database", Properties()).use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery("SELECT original_text, translated_text, context FROM translations").use { result ->
                    assertTrue(result.next())
                    assertEquals("Original source", result.getString(1))
                    assertEquals("原文译文", result.getString(2))
                    assertFalse(result.getString(3).contains(config.apiKey))
                }
            }
        }
    }

    @Test fun evictsByAccessOrderEvenWithIdenticalTimestamps() {
        TranslationStore(path(), maxEntries = 2, now = { 10L }).use {
            it.put("a", "A", "甲", "context")
            it.put("b", "B", "乙", "context")
            assertEquals("甲", it.get("a"))
            it.put("c", "C", "丙", "context")
            assertNull(it.get("b"))
            assertEquals("甲", it.get("a"))
            assertEquals("丙", it.get("c"))
            it.put("a", "A", "更新甲", "context")
            assertEquals("更新甲", it.get("a"))
            assertEquals("丙", it.get("c"))
        }
    }

    @Test fun clearIsDurableAndEmptyResponsesCannotEraseSuccess() {
        val database = path()
        TranslationStore(database).use {
            it.put("a", "A", "甲", "context")
            it.put("a", "A", " \n ", "context")
            it.put("empty", "B", "", "context")
            assertEquals("甲", it.get("a"))
            assertNull(it.get("empty"))
            it.clear()
            assertNull(it.get("a"))
        }
        TranslationStore(database).use { assertNull(it.get("a")) }
    }

    @Test fun separateConnectionsSeeCommittedWritesAndCannotResurrectClearedRows() {
        val database = path()
        TranslationStore(database).use { first ->
            TranslationStore(database).use { second ->
                first.put("a", "A", "甲", "context")
                second.put("b", "B", "乙", "context")
                assertEquals("甲", second.get("a"))
                assertEquals("乙", first.get("b"))
                first.clear()
                assertNull(second.get("a"))
                assertNull(second.get("b"))
            }
        }
        TranslationStore(database).use { assertNull(it.get("a")) }
    }

    @Test(timeout = 10_000) fun concurrentConnectionsKeepEachOthersTransactions() {
        val database = path()
        TranslationStore(database).use { first ->
            TranslationStore(database).use { second ->
                val executor = Executors.newFixedThreadPool(2)
                try {
                    val tasks = listOf(first, second).mapIndexed { writer, store -> executor.submit {
                        repeat(40) { index ->
                            val key = "$writer-$index"
                            store.put(key, "Source $key", "译文 $key", "context")
                            assertEquals("译文 $key", store.get(key))
                        }
                    } }
                    tasks.forEach { it.get(8, TimeUnit.SECONDS) }
                    repeat(40) { index ->
                        assertEquals("译文 0-$index", second.get("0-$index"))
                        assertEquals("译文 1-$index", first.get("1-$index"))
                    }
                } finally { executor.shutdownNow() }
            }
        }
    }

    @Test fun refusesCorruptEmptyAndUnsupportedDatabasesWithoutReplacingThem() {
        val corrupt = path()
        val bytes = "not a database fake-private-content".toByteArray()
        Files.write(corrupt, bytes)
        assertThrows(IllegalStateException::class.java) { TranslationStore(corrupt) }
        assertArrayEquals(bytes, Files.readAllBytes(corrupt))
        val empty = path()
        Files.createFile(empty)
        assertThrows(IllegalStateException::class.java) { TranslationStore(empty) }
        assertEquals(0L, Files.size(empty))
        val unsupported = path()
        JDBC().connect("jdbc:sqlite:$unsupported", Properties()).use { connection ->
            connection.createStatement().use { it.execute("PRAGMA user_version = 99") }
        }
        val before = Files.readAllBytes(unsupported)
        assertThrows(IllegalStateException::class.java) { TranslationStore(unsupported) }
        assertArrayEquals(before, Files.readAllBytes(unsupported))
    }

    @Test fun closesIdempotentlyAndRejectsUseAfterClose() {
        val store = TranslationStore(path())
        store.close()
        store.close()
        assertThrows(IllegalStateException::class.java) { store.get("a") }
        assertThrows(IllegalStateException::class.java) { store.put("a", "A", "甲", "context") }
        assertThrows(IllegalStateException::class.java) { store.clear() }
        assertThrows(IllegalArgumentException::class.java) { TranslationStore(path(), maxEntries = 0) }
    }
}
