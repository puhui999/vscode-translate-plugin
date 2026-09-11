package com.puhui.commenttranslator.translation

import com.google.gson.Gson
import com.google.gson.JsonParser
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

class TranslationClientTest {
    private val config = ProviderConfig("https://example.test/v1", "arbitrary-model", "fake-test-key")
    private val items = listOf(TranslationItem("a", "First comment"), TranslationItem("b", "Second comment"))

    @Test fun normalizesBaseAndCompleteEndpointsWithoutForcingAProvider() {
        val cases = mapOf(
            "https://EXAMPLE.test:443/" to "https://example.test/v1/chat/completions",
            "http://192.168.1.10:8000/api/v2/" to "http://192.168.1.10:8000/api/v2/chat/completions",
            "http://[::1]:1234/v1" to "http://[::1]:1234/v1/chat/completions",
            "https://example.test/v1/chat/completions/" to "https://example.test/v1/chat/completions",
        )
        cases.forEach { (source, expected) -> assertEquals(expected, normalizeEndpoint(source)) }
        listOf("invalid", "file:///tmp/models", "https://user:key@example.test/v1", "https://example.test/v1?key=x", "https://example.test/v1?", "https://example.test/v1#", "https://example.test:99999").forEach {
            assertEquals("INVALID_CONFIG", assertThrows(TranslationException::class.java) { normalizeEndpoint(it) }.code)
        }
    }

    @Test fun sendsOneJsonMessageAndMapsReorderedResultsAndDuplicateTextById() {
        val calls = mutableListOf<List<TranslationItem>>()
        val client = TranslationClient(TranslationTransport { endpoint, headers, body, _, _ ->
            assertEquals("https://example.test/v1/chat/completions", endpoint)
            assertEquals("Bearer fake-test-key", headers["Authorization"])
            val request = JsonParser.parseString(body).asJsonObject
            assertEquals("arbitrary-model", request["model"].asString)
            assertFalse(request["stream"].asBoolean)
            assertFalse(request.has("response_format"))
            assertFalse(request.has("max_tokens"))
            assertEquals(2, request.getAsJsonArray("messages").size())
            calls += inputItems(body)
            response(listOf("b" to "第二条", "a" to "第一条"))
        })
        val batches = mutableListOf<Map<String, String>>()
        val result = client.translate(items + TranslationItem("repeat", items[0].text), config, { false }, batches::add)
        assertEquals(listOf(items), calls)
        assertEquals(mapOf("a" to "第一条", "b" to "第二条", "repeat" to "第一条"), result)
        assertEquals(listOf(result), batches)
    }

    @Test fun splitsBySerializedJsonBudgetIncludingEscapesAndDoesNotSendOversizedItems() {
        val requests = mutableListOf<List<TranslationItem>>()
        val client = TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val parts = inputItems(body)
            requests += parts
            val user = JsonParser.parseString(body).asJsonObject.getAsJsonArray("messages")[1].asJsonObject["content"].asString
            assertTrue(user.length <= 105)
            response(parts.map { it.id to "译文" })
        })
        client.translate((1..5).map { TranslationItem("id$it", "Comment $it with \"quotes\" and \\ path") }, config.copy(maxBatchChars = 105), { false }, {})
        assertEquals(5, requests.size)
        requests.clear()
        val error = assertThrows(TranslationException::class.java) {
            client.translate(items + TranslationItem("huge", "x".repeat(1_000)), config.copy(maxBatchChars = 105), { false }, {})
        }
        assertEquals("ITEM_TOO_LARGE", error.code)
        assertTrue(requests.isEmpty())
    }

    @Test fun retriesOnlyMissingOrStructurallyInvalidIdsAndPublishesOnlyValidText() {
        val source = listOf(TranslationItem("a", "Ordinary text"), TranslationItem("b", "@param userId User ID."))
        val requests = mutableListOf<List<TranslationItem>>()
        val client = TranslationClient(TranslationTransport { _, _, body, _, _ ->
            requests += inputItems(body)
            if (requests.size == 1) response(listOf("a" to "普通文本", "b" to "@param 用户 用户标识。"))
            else response(listOf("b" to "@param userId 用户标识。"))
        })
        val batches = mutableListOf<Map<String, String>>()
        val result = client.translate(source, config, { false }, batches::add)
        assertEquals(listOf(source, listOf(source[1])), requests)
        assertEquals(listOf(mapOf("a" to "普通文本"), mapOf("b" to "@param userId 用户标识。")), batches)
        assertEquals(2, result.size)
    }

    @Test fun rejectsDuplicateAndUnknownResponseIdsWhileRetainingVerifiedPartialResults() {
        var calls = 0
        val duplicateClient = TranslationClient(TranslationTransport { _, _, _, _, _ ->
            calls++
            response(listOf("a" to "第一条", "b" to "冲突一", "b" to "冲突二"))
        })
        val duplicate = assertThrows(TranslationException::class.java) { duplicateClient.translate(items, config, { false }, {}) }
        // The retry response also contains a, which is unknown in its b-only retry batch.
        assertEquals("INVALID_IDS", duplicate.code)
        assertEquals(mapOf("a" to "第一条"), duplicate.partialTranslations)
        assertEquals(2, calls)
        val unknown = assertThrows(TranslationException::class.java) {
            TranslationClient(TranslationTransport { _, _, _, _, _ -> response(listOf("a" to "第一条", "other" to "无关")) })
                .translate(items, config, { false }, {})
        }
        assertEquals("INVALID_IDS", unknown.code)
        assertEquals(mapOf("a" to "第一条"), unknown.partialTranslations)
    }

    @Test fun limitsMalformedAndPersistentMissingRepairs() {
        var malformedCalls = 0
        val malformed = assertThrows(TranslationException::class.java) {
            TranslationClient(TranslationTransport { _, _, _, _, _ -> malformedCalls++; TranslationResponse(200, "not-json") })
                .translate(listOf(items[0]), config, { false }, {})
        }
        assertEquals("INVALID_RESPONSE", malformed.code)
        assertEquals(3, malformedCalls)
        var missingCalls = 0
        val missing = assertThrows(TranslationException::class.java) {
            TranslationClient(TranslationTransport { _, _, _, _, _ -> missingCalls++; response(emptyList()) })
                .translate(items, config, { false }, {})
        }
        assertEquals("MISSING_TRANSLATIONS", missing.code)
        assertEquals(2, missingCalls)
    }

    @Test fun splitsTruncatedResponsesAndAcceptsFencedJsonInTextMode() {
        val calls = mutableListOf<List<TranslationItem>>()
        val result = TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val sent = inputItems(body)
            calls += sent
            if (sent.size > 1) response(emptyList(), "length")
            else response(sent.map { it.id to "译文" }, fenced = true)
        }).translate(items, config, { false }, {})
        assertEquals(listOf(items, listOf(items[0]), listOf(items[1])), calls)
        assertEquals(2, result.size)
    }

    @Test fun rejectsNonJsonLenientSyntaxAndNonStringResponseFields() {
        val brokenBodies = listOf(
            "{choices:[{message:{content:'oops'}}]}",
            "{\"choices\":[{\"message\":{\"content\":{}}}]}",
            "{\"choices\":[{\"message\":{\"content\":\"{}\",\"refusal\":\"no\"}}]}",
        )
        brokenBodies.forEach { body ->
            val failure = assertThrows(TranslationException::class.java) {
                TranslationClient(TranslationTransport { _, _, _, _, _ -> TranslationResponse(200, body) })
                    .translate(items.take(1), config, { false }, {})
            }
            assertEquals("INVALID_RESPONSE", failure.code)
        }
    }

    @Test fun limitsHttpRetriesAndSanitizesProviderFailures() {
        listOf(401 to "AUTH", 403 to "AUTH", 307 to "REDIRECT", 400 to "HTTP", 429 to "RATE_LIMIT", 503 to "HTTP_RETRYABLE").forEach { (status, code) ->
            var calls = 0
            val client = TranslationClient(TranslationTransport { _, _, _, _, _ -> calls++; TranslationResponse(status, "fake-test-key private source") }, 0)
            val failure = assertThrows(TranslationException::class.java) { client.translate(items, config, { false }, {}) }
            assertEquals(code, failure.code)
            assertEquals(if (status == 429 || status == 503) 3 else 1, calls)
            assertFalse(failure.toString().contains("fake-test-key"))
            assertNull(failure.cause)
        }
        val network = assertThrows(TranslationException::class.java) {
            TranslationClient(TranslationTransport { _, _, _, _, _ -> throw IOException("fake-test-key private source") }, 0)
                .translate(items, config, { false }, {})
        }
        assertEquals("NETWORK", network.code)
        assertFalse(network.toString().contains("private source"))
        assertFalse(config.toString().contains(config.apiKey))
    }

    @Test fun neverPublishesLateResponsesAndNeverCallsTransportAfterCancellation() {
        val cancelled = AtomicBoolean(false)
        var calls = 0
        var callbacks = 0
        val client = TranslationClient(TranslationTransport { _, _, _, _, _ ->
            calls++
            cancelled.set(true)
            response(items.map { it.id to "迟到" })
        })
        val first = assertThrows(TranslationException::class.java) { client.translate(items, config, cancelled::get) { callbacks++ } }
        assertEquals("CANCELLED", first.code)
        assertTrue(first.partialTranslations.isEmpty())
        assertEquals(0, callbacks)
        assertThrows(TranslationException::class.java) { client.translate(items, config, cancelled::get) {} }
        assertEquals(1, calls)
    }

    @Test fun rejectsDuplicateInputIdsAndSkipsEmptyRequests() {
        var calls = 0
        val client = TranslationClient(TranslationTransport { _, _, _, _, _ -> calls++; response(emptyList()) })
        assertTrue(client.translate(emptyList(), config, { false }, {}).isEmpty())
        assertEquals("INVALID_INPUT", assertThrows(TranslationException::class.java) {
            client.translate(listOf(items[0], items[0]), config, { false }, {})
        }.code)
        assertEquals(0, calls)
    }

    @Test fun closesItsOwnedTransportAndRejectsNewWork() {
        var transportClosed = false
        val transport = object : TranslationTransport, AutoCloseable {
            override fun post(endpoint: String, headers: Map<String, String>, body: String, timeoutSeconds: Int, isCancelled: () -> Boolean) = response(emptyList())
            override fun close() { transportClosed = true }
        }
        val client = TranslationClient(transport)
        client.close()
        assertTrue(transportClosed)
        assertEquals("CANCELLED", assertThrows(TranslationException::class.java) { client.translate(items, config, { false }, {}) }.code)
    }
}

internal fun inputItems(body: String): List<TranslationItem> {
    val content = JsonParser.parseString(body).asJsonObject.getAsJsonArray("messages")[1].asJsonObject["content"].asString
    return JsonParser.parseString(content).asJsonObject.getAsJsonArray("comments").map {
        TranslationItem(it.asJsonObject["id"].asString, it.asJsonObject["text"].asString)
    }
}

internal fun response(translations: List<Pair<String, String>>, finishReason: String = "stop", fenced: Boolean = false): TranslationResponse {
    val gson = Gson()
    var content = gson.toJson(mapOf("translations" to translations.map { (id, text) -> mapOf("id" to id, "text" to text) }))
    if (fenced) content = "```json\n$content\n```"
    return TranslationResponse(200, gson.toJson(mapOf("choices" to listOf(mapOf("message" to mapOf("content" to content), "finish_reason" to finishReason)))))
}
