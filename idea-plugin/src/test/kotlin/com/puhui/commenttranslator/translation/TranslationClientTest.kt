package com.puhui.commenttranslator.translation

import com.google.gson.Gson
import com.google.gson.JsonParser
import org.junit.Assert.*
import org.junit.Test
import org.junit.After
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.ConcurrentLinkedQueue

class TranslationClientTest {
    private val config = ProviderConfig("https://example.test/v1", "arbitrary-model", "fake-test-key")
    private val clients = mutableListOf<TranslationClient>()

    @After fun closeClients() { clients.forEach(TranslationClient::close) }

    private fun client(transport: TranslationTransport, retryDelayMillis: Long = 0): TranslationClient =
        TranslationClient(transport, retryDelayMillis).also(clients::add)

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

    @Test fun sendsOneCommentPerRequestAndMapsDuplicateTextById() {
        val calls = ConcurrentLinkedQueue<List<TranslationItem>>()
        val client = client(TranslationTransport { endpoint, headers, body, _, _ ->
            assertEquals("https://example.test/v1/chat/completions", endpoint)
            assertEquals("Bearer fake-test-key", headers["Authorization"])
            val request = JsonParser.parseString(body).asJsonObject
            assertEquals("arbitrary-model", request["model"].asString)
            assertFalse(request["stream"].asBoolean)
            assertEquals("json_object", request.getAsJsonObject("response_format")["type"].asString)
            assertEquals(0.2, request["temperature"].asDouble, 0.0)
            assertFalse(request.has("thinking"))
            assertFalse(request.has("max_tokens"))
            assertEquals(2, request.getAsJsonArray("messages").size())
            val sent = inputItems(body)
            assertEquals(1, sent.size)
            calls.add(sent)
            response(listOf(sent.single().id to if (sent.single().id == "a") "第一条" else "第二条"))
        })
        val callbacks = mutableListOf<Map<String, String>>()
        val result = client.translate(items + TranslationItem("repeat", items[0].text), config, { false }, callbacks::add)
        assertEquals(items.toSet(), calls.map { it.single() }.toSet())
        assertEquals(2, calls.size)
        assertEquals(mapOf("a" to "第一条", "b" to "第二条", "repeat" to "第一条"), result)
        assertEquals(2, callbacks.size)
        assertTrue(callbacks.contains(mapOf("a" to "第一条", "repeat" to "第一条")))
        assertTrue(callbacks.contains(mapOf("b" to "第二条")))
    }

    @Test fun limitsEachSerializedCommentAndContinuesPastOversizedItems() {
        val requests = ConcurrentLinkedQueue<List<TranslationItem>>()
        val client = client(TranslationTransport { _, _, body, _, _ ->
            val parts = inputItems(body)
            requests.add(parts)
            val user = JsonParser.parseString(body).asJsonObject.getAsJsonArray("messages")[1].asJsonObject["content"].asString
            assertTrue(user.length <= 105)
            assertEquals(1, parts.size)
            response(parts.map { it.id to "译文" })
        })
        client.translate((1..5).map { TranslationItem("id$it", "Comment $it with \"quotes\" and \\ path") }, config.copy(maxBatchChars = 105), { false }, {})
        assertEquals(5, requests.size)
        requests.clear()
        val error = assertThrows(TranslationException::class.java) {
            client.translate(listOf(TranslationItem("huge", "x".repeat(1_000))) + items, config.copy(maxBatchChars = 105), { false }, {})
        }
        assertEquals("ITEM_TOO_LARGE", error.code)
        assertEquals(items.toSet(), requests.map { it.single() }.toSet())
        assertEquals(mapOf("a" to "译文", "b" to "译文"), error.partialTranslations)
    }

    @Test fun retriesOnlyStructurallyInvalidCommentAndPublishesValidText() {
        val source = listOf(TranslationItem("a", "Ordinary text"), TranslationItem("b", "@param userId User ID."))
        val requests = ConcurrentLinkedQueue<String>()
        val attempts = AtomicInteger()
        val client = client(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            requests.add(item.id)
            if (item.id == "a") response(listOf("a" to "普通文本"))
            else if (attempts.incrementAndGet() == 1) response(listOf("b" to "@param 用户 用户标识。"))
            else response(listOf("b" to "@param userId 用户标识。"))
        })
        val callbacks = mutableListOf<Map<String, String>>()
        val result = client.translate(source, config, { false }, callbacks::add)
        assertEquals(1, requests.count { it == "a" })
        assertEquals(2, requests.count { it == "b" })
        assertTrue(callbacks.contains(mapOf("a" to "普通文本")))
        assertTrue(callbacks.contains(mapOf("b" to "@param userId 用户标识。")))
        assertEquals(2, result.size)
    }

    @Test fun rejectsDuplicateAndUnknownResponseIdsWhileRetainingVerifiedPartialResults() {
        val calls = AtomicInteger()
        val duplicateClient = client(TranslationTransport { _, _, body, _, _ ->
            calls.incrementAndGet()
            val item = inputItems(body).single()
            if (item.id == "a") response(listOf("a" to "第一条"))
            else response(listOf("b" to "冲突一", "b" to "冲突二"))
        })
        val duplicate = assertThrows(TranslationException::class.java) { duplicateClient.translate(items, config, { false }, {}) }
        assertEquals("MISSING_TRANSLATIONS", duplicate.code)
        assertEquals(mapOf("a" to "第一条"), duplicate.partialTranslations)
        assertEquals(3, calls.get())
        val unknown = assertThrows(TranslationException::class.java) {
            client(TranslationTransport { _, _, body, _, _ ->
                val item = inputItems(body).single()
                response(listOf(item.id to "有效译文", "other" to "无关"))
            }).translate(items, config, { false }, {})
        }
        assertEquals("INVALID_IDS", unknown.code)
        assertEquals(mapOf("a" to "有效译文", "b" to "有效译文"), unknown.partialTranslations)
    }

    @Test fun limitsMalformedAndPersistentMissingRepairsForEachComment() {
        val malformedCalls = AtomicInteger()
        val malformed = assertThrows(TranslationException::class.java) {
            client(TranslationTransport { _, _, _, _, _ -> malformedCalls.incrementAndGet(); TranslationResponse(200, "not-json") })
                .translate(listOf(items[0]), config, { false }, {})
        }
        assertEquals("INVALID_RESPONSE", malformed.code)
        assertEquals(3, malformedCalls.get())
        val missingCalls = AtomicInteger()
        val missing = assertThrows(TranslationException::class.java) {
            client(TranslationTransport { _, _, _, _, _ -> missingCalls.incrementAndGet(); response(emptyList()) })
                .translate(items, config, { false }, {})
        }
        assertEquals("MISSING_TRANSLATIONS", missing.code)
        assertEquals(4, missingCalls.get())
    }

    @Test fun repairsTruncatedResponsesAndAcceptsFencedJsonInTextMode() {
        val attempts = AtomicInteger()
        val result = client(TranslationTransport { _, _, body, _, _ ->
            assertFalse(JsonParser.parseString(body).asJsonObject.has("response_format"))
            val sent = inputItems(body)
            assertEquals(1, sent.size)
            if (attempts.incrementAndGet() == 1) response(emptyList(), "length")
            else response(sent.map { it.id to "译文" }, fenced = true)
        }).translate(items.take(1), config.copy(responseFormat = "text"), { false }, {})
        assertEquals(2, attempts.get())
        assertEquals(mapOf("a" to "译文"), result)
    }

    @Test fun acceptsNaturalChineseJavadocWithoutUnnecessaryRepairs() {
        val calls = AtomicInteger()
        val callbacks = mutableListOf<Map<String, String>>()
        val translated = client(TranslationTransport { _, _, body, _, _ ->
            calls.incrementAndGet()
            val item = inputItems(body).single()
            assertEquals(ChatClientJavadocFixture.source, item.text)
            response(listOf(item.id to ChatClientJavadocFixture.translation))
        }).translate(listOf(TranslationItem("javadoc", ChatClientJavadocFixture.source)), config, { false }, callbacks::add)
        assertEquals(1, calls.get())
        assertEquals(mapOf("javadoc" to ChatClientJavadocFixture.translation), translated)
        assertEquals(listOf(translated), callbacks)
    }

    @Test fun distinguishesTruncatedModelOutputFromInvalidJsonAfterBoundedRepair() {
        val calls = AtomicInteger()
        val failure = assertThrows(TranslationException::class.java) {
            client(TranslationTransport { _, _, _, _, _ ->
                calls.incrementAndGet()
                response(emptyList(), "length")
            }).translate(items.take(1), config, { false }, {})
        }
        assertEquals("OUTPUT_TRUNCATED", failure.code)
        assertTrue(failure.message!!.contains("长度限制"))
        assertEquals(3, calls.get())
        assertTrue(failure.partialTranslations.isEmpty())
    }

    @Test fun distinguishesChangedDocumentationFromMissingTranslationsAndKeepsSuccessfulSiblings() {
        val calls = AtomicInteger()
        val failure = assertThrows(TranslationException::class.java) {
            client(TranslationTransport { _, _, body, _, _ ->
                calls.incrementAndGet()
                val item = inputItems(body).single()
                response(listOf(item.id to if (item.id == "doc") "@param changed 错误参数。" else "普通译文。"))
            }).translate(listOf(TranslationItem("doc", "@param userId User ID."), items[0]), config, { false }, {})
        }
        assertEquals("INVALID_STRUCTURE", failure.code)
        assertTrue(failure.message!!.contains("引用目标"))
        assertEquals(mapOf("a" to "普通译文。"), failure.partialTranslations)
        assertEquals(3, calls.get())
    }

    @Test fun sendsOnlyExplicitThinkingOverridesAndConfiguredTemperature() {
        for (mode in listOf("provider", "disabled", "enabled")) {
            client(TranslationTransport { _, _, body, _, _ ->
                val request = JsonParser.parseString(body).asJsonObject
                assertEquals(1.25, request["temperature"].asDouble, 0.0)
                if (mode == "provider") assertFalse(request.has("thinking"))
                else assertEquals(mode, request.getAsJsonObject("thinking")["type"].asString)
                response(inputItems(body).map { it.id to "译文" })
            }).translate(items.take(1), config.copy(model = "deepseek-v4-flash", thinkingMode = mode, temperature = 1.25), { false }, {})
        }
    }

    @Test fun rejectsInvalidConcurrencyResponseTemperatureAndThinkingBeforeHttp() {
        val calls = AtomicInteger()
        val client = client(TranslationTransport { _, _, _, _, _ -> calls.incrementAndGet(); response(emptyList()) })
        val invalid = listOf(
            config.copy(maxConcurrency = 0), config.copy(maxConcurrency = 65),
            config.copy(responseFormat = "json_schema"), config.copy(thinkingMode = "unknown"),
            config.copy(temperature = Double.NaN), config.copy(temperature = Double.POSITIVE_INFINITY),
            config.copy(temperature = -0.1), config.copy(temperature = 2.1),
        )
        for (configuration in invalid) assertEquals("INVALID_CONFIG", assertThrows(TranslationException::class.java) {
            client.translate(items, configuration, { false }, {})
        }.code)
        assertEquals("INVALID_CONFIG", assertThrows(TranslationException::class.java) { client.configureConcurrency(0) }.code)
        assertEquals(0, calls.get())
    }

    @Test fun rejectsNonJsonLenientSyntaxAndNonStringResponseFields() {
        val brokenBodies = listOf(
            "{choices:[{message:{content:'oops'}}]}",
            "{\"choices\":[{\"message\":{\"content\":{}}}]}",
            "{\"choices\":[{\"message\":{\"content\":\"{}\",\"refusal\":\"no\"}}]}",
        )
        brokenBodies.forEach { body ->
            val failure = assertThrows(TranslationException::class.java) {
                client(TranslationTransport { _, _, _, _, _ -> TranslationResponse(200, body) })
                    .translate(items.take(1), config, { false }, {})
            }
            assertEquals("INVALID_RESPONSE", failure.code)
        }
    }

    @Test fun limitsHttpRetriesAndSanitizesProviderFailures() {
        listOf(401 to "AUTH", 403 to "AUTH", 307 to "REDIRECT", 400 to "HTTP", 429 to "RATE_LIMIT", 503 to "HTTP_RETRYABLE").forEach { (status, code) ->
            var calls = 0
            val client = client(TranslationTransport { _, _, _, _, _ -> calls++; TranslationResponse(status, "fake-test-key private source") }, 0)
            val failure = assertThrows(TranslationException::class.java) { client.translate(items.take(1), config, { false }, {}) }
            assertEquals(code, failure.code)
            assertEquals(if (status == 429 || status == 503) 3 else 1, calls)
            assertFalse(failure.toString().contains("fake-test-key"))
            assertNull(failure.cause)
        }
        val network = assertThrows(TranslationException::class.java) {
            client(TranslationTransport { _, _, _, _, _ -> throw IOException("fake-test-key private source") }, 0)
                .translate(items.take(1), config, { false }, {})
        }
        assertEquals("NETWORK", network.code)
        assertFalse(network.toString().contains("private source"))
        assertFalse(config.toString().contains(config.apiKey))
    }

    @Test fun neverPublishesLateResponsesAndNeverCallsTransportAfterCancellation() {
        val cancelled = AtomicBoolean(false)
        var calls = 0
        var callbacks = 0
        val client = client(TranslationTransport { _, _, _, _, _ ->
            calls++
            cancelled.set(true)
            response(items.map { it.id to "迟到" })
        })
        val first = assertThrows(TranslationException::class.java) { client.translate(items, config.copy(maxConcurrency = 1), cancelled::get) { callbacks++ } }
        assertEquals("CANCELLED", first.code)
        assertTrue(first.partialTranslations.isEmpty())
        assertEquals(0, callbacks)
        assertThrows(TranslationException::class.java) { client.translate(items, config.copy(maxConcurrency = 1), cancelled::get) {} }
        assertEquals(1, calls)
    }

    @Test fun rejectsDuplicateInputIdsAndSkipsEmptyRequests() {
        var calls = 0
        val client = client(TranslationTransport { _, _, _, _, _ -> calls++; response(emptyList()) })
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
        val client = client(transport)
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
