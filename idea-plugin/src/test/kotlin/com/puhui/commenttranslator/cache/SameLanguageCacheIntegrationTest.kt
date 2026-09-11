package com.puhui.commenttranslator.cache

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.puhui.commenttranslator.translation.ProviderConfig
import com.puhui.commenttranslator.translation.TranslationClient
import com.puhui.commenttranslator.translation.TranslationItem
import com.puhui.commenttranslator.translation.TranslationResponse
import com.puhui.commenttranslator.translation.TranslationTransport
import com.puhui.commenttranslator.translation.preservesCommentStructure
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.sqlite.JDBC
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.atomic.AtomicInteger

/** Exercises unchanged-language responses through the real decoder and SQLite cache, with only HTTP mocked. */
class SameLanguageCacheIntegrationTest {
    @get:Rule val temporary = TemporaryFolder()
    private val config = ProviderConfig("https://example.test/v1", "test-model", "mock-key", prompt = "Keep API terms.")
    private val json = Gson()

    /** A same response persists the exact original string and survives reopening beside an older translation row. */
    @Test fun unchangedSourceAndExistingTranslationsBothSurviveDatabaseReopenWithoutRequests() {
        val database = database()
        val source = "读取缓存中的用户资料。\r\n@param userId 用户标识。\r\n@return 缓存的资料，或 null。"
        val item = TranslationItem("same-language-comment", source)
        val key = cacheKey(source, "java", config)
        val oldSource = "Read the user profile."
        // This key is the existing protocol-v2 golden value, independent of the new same-response decoder.
        val oldKey = "5d0602270d5e38f441bedd5285efca4aa3638433d1ed688a82a16e18ab0423b0"
        val requests = AtomicInteger()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            requests.incrementAndGet()
            assertEquals(item, requestedItem(body))
            response("""{"same":true}""")
        }, retryDelayMillis = 0).use { client ->
            TranslationStore(database).use { store ->
                store.put(oldKey, oldSource, "读取用户资料。", cacheContext("java", config))
                assertEquals(source, cachedOrTranslate(store, client, item, config))
                assertEquals(source, store.get(key))
                assertEquals(1, requests.get())
            }
        }

        JDBC().connect("jdbc:sqlite:$database", Properties()).use { connection ->
            connection.prepareStatement("SELECT original_text, translated_text FROM translations WHERE cache_key = ?").use { query ->
                query.setString(1, key)
                query.executeQuery().use { rows ->
                    assertTrue(rows.next())
                    assertEquals(source, rows.getString("original_text"))
                    assertEquals("The compact response must be materialized, not stored as a protocol marker", source, rows.getString("translated_text"))
                    assertFalse(rows.next())
                }
            }
        }

        val reopenedRequests = AtomicInteger()
        TranslationClient(TranslationTransport { _, _, _, _, _ ->
            reopenedRequests.incrementAndGet()
            throw AssertionError("A persisted cache hit must not call HTTP")
        }, retryDelayMillis = 0).use { client ->
            TranslationStore(database).use { reopened ->
                // Comment identifiers may change when the same text appears in a different file.
                assertEquals(source, cachedOrTranslate(reopened, client, item.copy(id = "another-file-id"), config))
                assertEquals(oldKey, cacheKey(oldSource, "java", config))
                assertEquals("读取用户资料。", cachedOrTranslate(reopened, client, TranslationItem("older-comment", oldSource), config))
                assertEquals(0, reopenedRequests.get())
            }
        }
    }

    /** An unchanged-language result is scoped to its original text and target language, rather than a global skip marker. */
    @Test fun changedTargetLanguageOrOriginalTextRequiresItsOwnTranslation() {
        val database = database()
        val source = TranslationItem("same", "读取缓存资料。")
        val changedSource = TranslationItem("changed", "写入缓存资料。")
        val english = config.copy(targetLanguage = "English")
        val requests = AtomicInteger()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            requests.incrementAndGet()
            val item = requestedItem(body)
            val system = JsonParser.parseString(body).asJsonObject.getAsJsonArray("messages")[0]
                .asJsonObject["content"].asString
            if (system.contains("into English.")) {
                assertEquals(source, item)
                response(json.toJson(mapOf("translations" to listOf(mapOf("id" to item.id, "text" to "Read cached profile.")))))
            } else response("""{"same":true}""")
        }, retryDelayMillis = 0).use { client ->
            TranslationStore(database).use { store ->
                assertEquals(source.text, cachedOrTranslate(store, client, source, config))
            }
            TranslationStore(database).use { reopened ->
                assertNull(reopened.get(cacheKey(source.text, "java", english)))
                assertNull(reopened.get(cacheKey(changedSource.text, "java", config)))
                assertEquals("Read cached profile.", cachedOrTranslate(reopened, client, source, english))
                assertEquals(changedSource.text, cachedOrTranslate(reopened, client, changedSource, config))
                assertEquals(3, requests.get())
                assertEquals(source.text, cachedOrTranslate(reopened, client, source, config))
                assertEquals("Read cached profile.", cachedOrTranslate(reopened, client, source, english))
                assertEquals(changedSource.text, cachedOrTranslate(reopened, client, changedSource, config))
                assertEquals("All three successful records are now independently reusable", 3, requests.get())
            }
        }
    }

    // Minimal cache-first orchestration matching the controller's boundaries; decoder, keys and database are real.
    private fun cachedOrTranslate(store: TranslationStore, client: TranslationClient, item: TranslationItem, provider: ProviderConfig): String {
        val key = cacheKey(item.text, "java", provider)
        store.get(key)?.takeIf { preservesCommentStructure(item.text, it) }?.let { return it }
        val result = client.translate(listOf(item), provider, { false }) { accepted ->
            accepted[item.id]?.let { store.put(key, item.text, it, cacheContext("java", provider)) }
        }
        return requireNotNull(result[item.id])
    }

    private fun requestedItem(body: String): TranslationItem {
        val user = JsonParser.parseString(body).asJsonObject.getAsJsonArray("messages")[1].asJsonObject["content"].asString
        val comments = JsonParser.parseString(user).asJsonObject.getAsJsonArray("comments")
        assertEquals(1, comments.size())
        return comments[0].asJsonObject.let { TranslationItem(it["id"].asString, it["text"].asString) }
    }

    private fun response(content: String): TranslationResponse = TranslationResponse(200, json.toJson(mapOf(
        "choices" to listOf(mapOf("finish_reason" to "stop", "message" to mapOf("content" to content))),
    )))

    private fun database(): Path = temporary.newFolder().toPath().resolve("translations.sqlite")
}
