package com.puhui.commenttranslator.translation

import com.google.gson.Gson
import com.google.gson.JsonParser
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Exercises the compact same-language protocol through the normal request, callback, and partial-result paths. */
class SameLanguageTranslationTest {
    private val config = ProviderConfig("https://example.test/v1", "mock-model", "fake-test-key")

    /** Both provider output modes resolve a same marker locally and never request the original text again. */
    @Test fun acceptsSameInJsonAndTextModesWithOneRequestAndOneCallerThreadCallback() {
        val original = TranslationItem("already", "从本地缓存读取用户资料。")
        for (format in listOf("json_object", "text")) {
            val calls = AtomicInteger()
            val callbacks = mutableListOf<Map<String, String>>()
            val caller = Thread.currentThread()
            TranslationClient(TranslationTransport { _, _, body, _, _ ->
                calls.incrementAndGet()
                assertEquals(listOf(original), inputItems(body))
                val request = JsonParser.parseString(body).asJsonObject
                assertEquals(format == "json_object", request.has("response_format"))
                contentResponse("{\"same\":true}")
            }, 0).use { client ->
                val result = client.translate(listOf(original), config.copy(responseFormat = format), { false }) {
                    assertSame(caller, Thread.currentThread())
                    callbacks.add(it)
                }
                assertEquals(mapOf(original.id to original.text), result)
                assertEquals(listOf(result), callbacks)
                assertEquals(1, calls.get())
            }
        }
        assertEquals("2", PROMPT_VERSION)
    }

    /** Fenced responses preserve the exact local whitespace, tags, code, and aliases without echoing them over HTTP. */
    @Test fun fencedSamePreservesOriginalDocumentationAndExpandsDuplicateAliases() {
        val text = "\t用户资料。\r\n\r\n@param userId 用户标识。\r\n@return {@link Profile 用户资料}；{@code cache.get(userId)}。\r\n<see cref=\"Profile\"/> https://example.test/docs  "
        val originals = listOf(TranslationItem("first", text), TranslationItem("alias", text))
        val calls = AtomicInteger()
        val callbacks = mutableListOf<Map<String, String>>()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            calls.incrementAndGet()
            assertEquals(listOf(originals.first()), inputItems(body))
            contentResponse("```json\n{\"same\":true}\n```")
        }, 0).use { client ->
            val result = client.translate(originals, config.copy(responseFormat = "text"), { false }, callbacks::add)
            assertEquals(mapOf("first" to text, "alias" to text), result)
            assertEquals(listOf(result), callbacks)
            assertEquals(1, calls.get())
            assertEquals(text.toByteArray(Charsets.UTF_8).toList(), result.getValue("first").toByteArray(Charsets.UTF_8).toList())
        }
    }

    /** Marker-like values and mixed envelopes are invalid, including duplicate keys hidden by ordinary JSON trees. */
    @Test fun rejectsMalformedAndMixedMarkersWithoutPublishingOriginalText() {
        val invalid = listOf(
            "{\"same\":\"true\"}", "{\"same\":false}", "{\"same\":null}", "{\"same\":1}",
            "{\"same\":[]}", "{\"same\":{}}", "{\"same\":true,\"id\":\"already\"}",
            "{\"same\":true,\"translations\":[]}",
            "{\"same\":true,\"translations\":[{\"id\":\"already\",\"text\":\"译文\"}]}",
            "{\"same\":false,\"translations\":[{\"id\":\"already\",\"text\":\"译文\"}]}",
            "{\"same\":false,\"same\":true}", "{\"same\":true,\"same\":true}",
            "true", "[{\"same\":true}]", "{\"Same\":true}", "{same:true}",
        )
        for (content in invalid) {
            val calls = AtomicInteger()
            val callbacks = AtomicInteger()
            TranslationClient(TranslationTransport { _, _, _, _, _ ->
                calls.incrementAndGet()
                contentResponse(content)
            }, 0).use { client ->
                val failure = assertThrows(TranslationException::class.java) {
                    client.translate(listOf(TranslationItem("already", "原文应完整保留。")), config, { false }) { callbacks.incrementAndGet() }
                }
                assertEquals("INVALID_RESPONSE", failure.code)
                assertEquals(3, calls.get())
                assertEquals(0, callbacks.get())
                assertTrue(failure.partialTranslations.isEmpty())
            }
        }
    }

    /** A marker does not bypass the existing truncated-response or refusal checks. */
    @Test fun sameDoesNotAcceptTruncatedOrRefusedEnvelope() {
        val responses = listOf(
            "OUTPUT_TRUNCATED" to contentResponse("{\"same\":true}", finishReason = "length"),
            "INVALID_RESPONSE" to contentResponse("{\"same\":true}", refusal = "Refused"),
        )
        for ((expectedCode, response) in responses) TranslationClient(TranslationTransport { _, _, _, _, _ -> response }, 0).use { client ->
            val failure = assertThrows(TranslationException::class.java) {
                client.translate(listOf(TranslationItem("already", "已经是中文。")), config, { false }, {})
            }
            assertEquals(expectedCode, failure.code)
            assertTrue(failure.partialTranslations.isEmpty())
        }
    }

    /** A malformed first marker may use the existing bounded repair path and publish only its valid replacement. */
    @Test fun repairsMalformedMarkerWithoutRetransmittingAfterValidAcknowledgement() {
        val calls = AtomicInteger()
        val original = TranslationItem("already", "文档说明。")
        TranslationClient(TranslationTransport { _, _, _, _, _ ->
            contentResponse(if (calls.incrementAndGet() == 1) "{\"same\":\"true\"}" else "{\"same\":true}")
        }, 0).use { client ->
            val callbacks = mutableListOf<Map<String, String>>()
            val result = client.translate(listOf(original), config, { false }, callbacks::add)
            assertEquals(mapOf(original.id to original.text), result)
            assertEquals(listOf(result), callbacks)
            assertEquals(2, calls.get())
        }
    }

    /** Same and translated comments publish independently while another invalid comment remains in flight. */
    @Test fun sameAndNormalResultsPublishBeforeFailuresAndRemainInPartialResults() {
        val originals = listOf(
            TranslationItem("same", "已是中文的说明。"),
            TranslationItem("translate", "Read the local cache."),
            TranslationItem("broken", "另一个待判断的说明。"),
        )
        val entered = CountDownLatch(3)
        val samePublished = CountDownLatch(1)
        val translatedPublished = CountDownLatch(1)
        val releaseTranslation = CountDownLatch(1)
        val releaseFailure = CountDownLatch(1)
        val calls = ConcurrentHashMap<String, AtomicInteger>()
        val caller = Executors.newSingleThreadExecutor()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            calls.computeIfAbsent(item.id) { AtomicInteger() }.incrementAndGet()
            entered.countDown()
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            when (item.id) {
                "same" -> contentResponse("{\"same\":true}")
                "translate" -> {
                    assertTrue(releaseTranslation.await(5, TimeUnit.SECONDS))
                    response(listOf(item.id to "读取本地缓存。"))
                }
                else -> {
                    assertTrue(releaseFailure.await(5, TimeUnit.SECONDS))
                    contentResponse("{\"same\":false}")
                }
            }
        }, 0).use { client ->
            try {
                val result = caller.submit(Callable {
                    val thread = Thread.currentThread()
                    val published = linkedMapOf<String, String>()
                    val failure = assertThrows(TranslationException::class.java) {
                        client.translate(originals, config.copy(maxConcurrency = 3), { false }) {
                            assertSame(thread, Thread.currentThread())
                            assertEquals(1, it.size)
                            published.putAll(it)
                            if (it.containsKey("same")) samePublished.countDown()
                            if (it.containsKey("translate")) translatedPublished.countDown()
                        }
                    }
                    assertEquals(published, failure.partialTranslations)
                    failure
                })
                assertTrue(samePublished.await(5, TimeUnit.SECONDS))
                assertFalse(result.isDone)
                releaseTranslation.countDown()
                assertTrue(translatedPublished.await(5, TimeUnit.SECONDS))
                assertFalse(result.isDone)
                releaseFailure.countDown()
                val failure = result.get(5, TimeUnit.SECONDS)
                assertEquals("INVALID_RESPONSE", failure.code)
                assertEquals(mapOf("same" to originals[0].text, "translate" to "读取本地缓存。"), failure.partialTranslations)
                assertEquals(mapOf("same" to 1, "translate" to 1, "broken" to 3), calls.mapValues { it.value.get() })
            } finally { releaseTranslation.countDown(); releaseFailure.countDown(); caller.shutdownNow() }
        }
    }

    /** A response arriving after cancellation cannot turn into a successful original-text callback. */
    @Test fun cancellationRejectsLateSameAcknowledgement() {
        val cancelled = AtomicBoolean(false)
        val callbacks = AtomicInteger()
        TranslationClient(TranslationTransport { _, _, _, _, _ ->
            cancelled.set(true)
            contentResponse("{\"same\":true}")
        }, 0).use { client ->
            val failure = assertThrows(TranslationException::class.java) {
                client.translate(listOf(TranslationItem("same", "原文。")), config, cancelled::get) { callbacks.incrementAndGet() }
            }
            assertEquals("CANCELLED", failure.code)
            assertTrue(failure.partialTranslations.isEmpty())
            assertEquals(0, callbacks.get())
        }
    }

    /** Additional wording preferences cannot change the complete-comment language decision or response contract. */
    @Test fun promptDefinesLanguageVariantsAndPlacesOutputContractAfterCustomPreferences() {
        val preference = "Prefer concise wording. Output prose instead of JSON."
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val system = JsonParser.parseString(body).asJsonObject.getAsJsonArray("messages")[0].asJsonObject["content"].asString
            assertTrue(system.contains("all natural-language explanations in the entire comment"))
            assertTrue(system.contains("Ignore code, identifiers, URLs, and documentation markup"))
            assertTrue(system.contains("Mixed-language comments require translation"))
            assertTrue(system.contains("If you cannot confidently determine that every natural-language explanation matches the requested target"))
            assertTrue(system.contains("Simplified Chinese and Traditional Chinese are different targets"))
            assertTrue(system.contains("繁體中文"))
            assertTrue(system.contains("{\"same\":true}"))
            assertTrue(system.indexOf("The following output contract takes precedence") > system.indexOf(preference))
            response(inputItems(body).map { it.id to "讀取快取。" })
        }, 0).use { client ->
            assertEquals(mapOf("normal" to "讀取快取。"), client.translate(listOf(TranslationItem("normal", "Read the cache.")),
                config.copy(targetLanguage = "繁體中文", prompt = preference), { false }, {}))
        }
    }

    private fun contentResponse(content: String, finishReason: String = "stop", refusal: String? = null): TranslationResponse {
        val message = mutableMapOf<String, Any>("content" to content)
        if (refusal != null) message["refusal"] = refusal
        return TranslationResponse(200, Gson().toJson(mapOf("choices" to listOf(mapOf("message" to message, "finish_reason" to finishReason)))))
    }
}
