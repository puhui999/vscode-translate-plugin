package com.puhui.commenttranslator.translation

import com.sun.net.httpserver.HttpServer
import org.junit.Assert.*
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class JvmTranslationTransportTest {
    @Test fun postsJsonToLocalServerAndDoesNotFollowRedirects() {
        LocalServer().use { local ->
            val redirected = AtomicInteger()
            local.server.createContext("/v1/chat/completions") { exchange ->
                assertEquals("POST", exchange.requestMethod)
                assertEquals("Bearer fake", exchange.requestHeaders.getFirst("Authorization"))
                assertEquals("{}", exchange.requestBody.readBytes().toString(Charsets.UTF_8))
                exchange.responseHeaders.add("Location", "${local.address}/must-not-follow")
                exchange.sendResponseHeaders(307, -1)
                exchange.close()
            }
            local.server.createContext("/must-not-follow") { redirected.incrementAndGet(); it.sendResponseHeaders(200, -1); it.close() }
            JvmTranslationTransport().use { transport ->
                val result = transport.post("${local.address}/v1/chat/completions", mapOf("Authorization" to "Bearer fake"), "{}", 2) { false }
                assertEquals(307, result.status)
                assertEquals(0, redirected.get())
            }
        }
    }

    @Test fun abortsOversizedBodiesBeforeCollectingUnlimitedData() {
        LocalServer().use { local ->
            local.server.createContext("/large") { exchange ->
                exchange.sendResponseHeaders(200, 0)
                runCatching { exchange.responseBody.use { it.write(ByteArray(2 * 1024 * 1024 + 1) { 65 }) } }
                exchange.close()
            }
            JvmTranslationTransport().use { transport ->
                val error = assertThrows(TranslationException::class.java) {
                    transport.post("${local.address}/large", emptyMap(), "{}", 3) { false }
                }
                assertEquals("RESPONSE_TOO_LARGE", error.code)
            }
        }
    }

    @Test(timeout = 5_000) fun cancelsWhileHeadersArePending() {
        LocalServer().use { local ->
            val entered = CountDownLatch(1)
            val release = CountDownLatch(1)
            local.server.createContext("/waiting") { exchange ->
                entered.countDown()
                release.await(3, TimeUnit.SECONDS)
                runCatching { exchange.sendResponseHeaders(200, -1) }
                exchange.close()
            }
            val executor = Executors.newSingleThreadExecutor()
            try {
                JvmTranslationTransport().use { transport ->
                    val cancelled = AtomicBoolean()
                    val pending = executor.submit<String> {
                        try { transport.post("${local.address}/waiting", emptyMap(), "{}", 3, cancelled::get); "unexpected success" }
                        catch (error: TranslationException) { error.code }
                    }
                    assertTrue(entered.await(2, TimeUnit.SECONDS))
                    cancelled.set(true)
                    assertEquals("CANCELLED", pending.get(1, TimeUnit.SECONDS))
                }
            } finally { release.countDown(); executor.shutdownNow() }
        }
    }

    @Test(timeout = 5_000) fun timeoutCoversStalledResponseBody() {
        LocalServer().use { local ->
            val release = CountDownLatch(1)
            local.server.createContext("/body") { exchange ->
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.write("{\"choices\":".toByteArray())
                exchange.responseBody.flush()
                release.await(3, TimeUnit.SECONDS)
                runCatching { exchange.close() }
            }
            try {
                JvmTranslationTransport().use { transport ->
                    val error = assertThrows(TranslationException::class.java) { transport.post("${local.address}/body", emptyMap(), "{}", 1) { false } }
                    assertEquals("TIMEOUT", error.code)
                }
            } finally { release.countDown() }
        }
    }

    private class LocalServer : AutoCloseable {
        val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        private val workers = Executors.newCachedThreadPool { Thread(it, "translation-mock").apply { isDaemon = true } }
        val address: String get() = "http://127.0.0.1:${server.address.port}"
        init { server.executor = workers; server.start() }
        override fun close() { server.stop(0); workers.shutdownNow() }
    }
}
