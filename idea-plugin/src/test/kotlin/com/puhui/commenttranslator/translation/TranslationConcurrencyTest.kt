package com.puhui.commenttranslator.translation

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Verifies actual transport concurrency, caller-thread progress, and cancellation without external APIs. */
class TranslationConcurrencyTest {
    private val config = ProviderConfig("https://example.test/v1", "mock-model", "fake-test-key")

    /** Multiple files share ten transport slots rather than receiving ten slots each. */
    @Test fun twoFilesShareTheDefaultTenRequestLimit() = verifySharedLimit(10, 2)

    /** A configured smaller window bounds all files using the client. */
    @Test fun twoFilesShareConfiguredTwoRequestLimit() = verifySharedLimit(2, 2)

    private fun verifySharedLimit(limit: Int, files: Int) {
        val gate = Semaphore(0)
        val started = CountDownLatch(limit)
        val active = AtomicInteger()
        val maximum = AtomicInteger()
        val calls = AtomicInteger()
        val workers = ConcurrentHashMap.newKeySet<Thread>()
        val callers = Executors.newFixedThreadPool(files)
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            assertEquals(1, inputItems(body).size)
            workers.add(Thread.currentThread())
            maximum.accumulateAndGet(active.incrementAndGet(), ::maxOf)
            calls.incrementAndGet()
            started.countDown()
            try {
                assertTrue(gate.tryAcquire(5, TimeUnit.SECONDS))
                response(inputItems(body).map { it.id to "译文" })
            } finally { active.decrementAndGet() }
        }, 0).use { client ->
            try {
                val futures = (1..files).map { file -> callers.submit(Callable {
                    val caller = Thread.currentThread()
                    client.translate(items("file$file", 20), config.copy(maxConcurrency = limit), { false }) {
                        assertSame("Callbacks must run on their translate caller", caller, Thread.currentThread())
                        assertEquals(1, it.size)
                    }
                }) }
                assertTrue("The client should use all configured slots", started.await(5, TimeUnit.SECONDS))
                assertEquals(limit, calls.get())
                assertEquals(limit, active.get())
                gate.release(files * 20)
                futures.forEach { assertEquals(20, it.get(10, TimeUnit.SECONDS).size) }
                assertEquals(files * 20, calls.get())
                assertEquals(limit, maximum.get())
                assertEquals("Sequential requests must reuse the configured worker count", limit, workers.size)
                assertEquals(0, active.get())
            } finally {
                gate.release(files * 20)
                callers.shutdownNow()
            }
        }
    }

    /** A fast later item is published before a slow earlier request finishes. */
    @Test fun publishesEachCompletionImmediatelyOnTheOriginalCallerThread() {
        val slowEntered = CountDownLatch(1)
        val releaseSlow = CountDownLatch(1)
        val fastPublished = CountDownLatch(1)
        val callbacks = ConcurrentLinkedQueue<String>()
        val caller = Executors.newSingleThreadExecutor()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            if (item.id == "file-0") {
                slowEntered.countDown()
                assertTrue(releaseSlow.await(5, TimeUnit.SECONDS))
            } else assertTrue(slowEntered.await(5, TimeUnit.SECONDS))
            response(listOf(item.id to "译文"))
        }, 0).use { client ->
            try {
                val result = caller.submit(Callable {
                    val owner = Thread.currentThread()
                    client.translate(items("file", 2), config.copy(maxConcurrency = 2), { false }) {
                        assertSame(owner, Thread.currentThread())
                        callbacks.add(it.keys.single())
                        if (it.containsKey("file-1")) fastPublished.countDown()
                    }
                })
                assertTrue(fastPublished.await(5, TimeUnit.SECONDS))
                assertEquals(listOf("file-1"), callbacks.toList())
                assertFalse(result.isDone)
                releaseSlow.countDown()
                assertEquals(2, result.get(5, TimeUnit.SECONDS).size)
                assertEquals(listOf("file-1", "file-0"), callbacks.toList())
            } finally { releaseSlow.countDown(); caller.shutdownNow() }
        }
    }

    /** An individual failure cannot prevent later valid comments from being translated and retained. */
    @Test fun ordinaryFailureContinuesUnsentCommentsAndPreservesPublishedResults() {
        val calls = mutableListOf<String>()
        val published = linkedMapOf<String, String>()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            calls.add(item.id)
            if (item.id == "file-0") TranslationResponse(400, "private source fake-test-key")
            else response(listOf(item.id to "译文"))
        }, 0).use { client ->
            val failure = assertThrows(TranslationException::class.java) {
                client.translate(items("file", 3), config.copy(maxConcurrency = 1), { false }, published::putAll)
            }
            assertEquals("HTTP", failure.code)
            assertEquals(listOf("file-0", "file-1", "file-2"), calls)
            assertEquals(mapOf("file-1" to "译文", "file-2" to "译文"), published)
            assertEquals(published, failure.partialTranslations)
            assertFalse(failure.toString().contains("private source"))
            assertFalse(failure.toString().contains("fake-test-key"))
        }
    }

    /** Cancellation stops the two active requests and leaves all remaining comments unsent. */
    @Test fun cancellationStopsInFlightAndQueuedComments() = verifyCancellation(closeClient = false)

    /** Closing the shared client also aborts active requests and prevents any queued comment from starting. */
    @Test fun closingClientStopsInFlightAndQueuedComments() = verifyCancellation(closeClient = true)

    private fun verifyCancellation(closeClient: Boolean) {
        val entered = CountDownLatch(2)
        val exited = CountDownLatch(2)
        val cancelled = AtomicBoolean(false)
        val calls = AtomicInteger()
        val callbacks = AtomicInteger()
        val caller = Executors.newSingleThreadExecutor()
        TranslationClient(TranslationTransport { _, _, _, _, isCancelled ->
            calls.incrementAndGet()
            entered.countDown()
            try {
                val timeout = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                while (!isCancelled() && System.nanoTime() < timeout) CountDownLatch(1).await(10, TimeUnit.MILLISECONDS)
                throw TranslationException("CANCELLED", "翻译已取消。")
            } finally { exited.countDown() }
        }, 0).use { client ->
            try {
                val result = caller.submit(Callable {
                    assertThrows(TranslationException::class.java) {
                        client.translate(items("file", 100), config.copy(maxConcurrency = 2), cancelled::get) { callbacks.incrementAndGet() }
                    }
                })
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                if (closeClient) client.close() else cancelled.set(true)
                assertEquals("CANCELLED", result.get(5, TimeUnit.SECONDS).code)
                assertTrue(exited.await(5, TimeUnit.SECONDS))
                assertEquals(2, calls.get())
                assertEquals(0, callbacks.get())
            } finally { cancelled.set(true); caller.shutdownNow() }
        }
    }

    /** A second file waiting behind global capacity can be cancelled without ever calling HTTP. */
    @Test fun cancelsFileWhileAllGlobalSlotsAreOccupiedByAnotherFile() {
        val occupied = CountDownLatch(2)
        val release = CountDownLatch(1)
        val waiting = CountDownLatch(1)
        val cancelled = AtomicBoolean(false)
        val calls = ConcurrentLinkedQueue<String>()
        val callers = Executors.newFixedThreadPool(2)
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            calls.add(item.id)
            occupied.countDown()
            assertTrue(release.await(5, TimeUnit.SECONDS))
            response(listOf(item.id to "译文"))
        }, 0).use { client ->
            try {
                val first = callers.submit(Callable { client.translate(items("first", 2), config.copy(maxConcurrency = 2), { false }, {}) })
                assertTrue(occupied.await(5, TimeUnit.SECONDS))
                val second = callers.submit(Callable {
                    waiting.countDown()
                    assertThrows(TranslationException::class.java) {
                        client.translate(items("waiting", 20), config.copy(maxConcurrency = 2), cancelled::get, {})
                    }
                })
                assertTrue(waiting.await(5, TimeUnit.SECONDS))
                cancelled.set(true)
                assertEquals("CANCELLED", second.get(5, TimeUnit.SECONDS).code)
                assertTrue(calls.all { it.startsWith("first") })
                release.countDown()
                assertEquals(2, first.get(5, TimeUnit.SECONDS).size)
                assertEquals(2, calls.size)
            } finally { release.countDown(); cancelled.set(true); callers.shutdownNow() }
        }
    }

    /** Raising the live setting expands an already-running file even when it holds an older provider snapshot. */
    @Test fun increasingLiveLimitExpandsCurrentFileWithoutCancellingIt() {
        val firstEntered = CountDownLatch(1)
        val threeEntered = CountDownLatch(3)
        val release = CountDownLatch(1)
        val calls = AtomicInteger()
        val caller = Executors.newSingleThreadExecutor()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            calls.incrementAndGet()
            firstEntered.countDown()
            threeEntered.countDown()
            assertTrue(release.await(5, TimeUnit.SECONDS))
            response(inputItems(body).map { it.id to "译文" })
        }, 0).use { client ->
            try {
                client.configureConcurrency(1)
                val result = caller.submit(Callable { client.translate(items("file", 8), config.copy(maxConcurrency = 1), { false }, {}) })
                assertTrue(firstEntered.await(5, TimeUnit.SECONDS))
                assertEquals(1, calls.get())
                client.configureConcurrency(3)
                assertTrue(threeEntered.await(5, TimeUnit.SECONDS))
                assertEquals(3, calls.get())
                release.countDown()
                assertEquals(8, result.get(5, TimeUnit.SECONDS).size)
            } finally { release.countDown(); caller.shutdownNow() }
        }
    }

    /** Lowering a limit waits for old requests to finish and cannot be undone by a stale file configuration. */
    @Test fun decreasingLiveLimitWaitsForOldRequestsAndRejectsStaleHigherSnapshots() {
        val entered = CountDownLatch(3)
        val twoExited = CountDownLatch(2)
        val fourthEntered = CountDownLatch(1)
        val gate = Semaphore(0)
        val active = AtomicInteger()
        val calls = AtomicInteger()
        val caller = Executors.newSingleThreadExecutor()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val number = calls.incrementAndGet()
            val currentActive = active.incrementAndGet()
            entered.countDown()
            if (number > 3) { fourthEntered.countDown(); assertEquals(1, currentActive) }
            try {
                assertTrue(gate.tryAcquire(5, TimeUnit.SECONDS))
                response(inputItems(body).map { it.id to "译文" })
            } finally { active.decrementAndGet(); twoExited.countDown() }
        }, 0).use { client ->
            try {
                client.configureConcurrency(3)
                val result = caller.submit(Callable { client.translate(items("file", 8), config, { false }, {}) })
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                client.configureConcurrency(1)
                // Even a newly submitted stale snapshot must not restore the previous value of ten.
                assertTrue(client.translate(emptyList(), config, { false }, {}).isEmpty())
                gate.release(2)
                assertTrue(twoExited.await(5, TimeUnit.SECONDS))
                assertFalse("No replacement request can start while one old request still occupies the new limit", fourthEntered.await(200, TimeUnit.MILLISECONDS))
                gate.release(8)
                assertEquals(8, result.get(5, TimeUnit.SECONDS).size)
            } finally { gate.release(20); caller.shutdownNow() }
        }
    }

    /** Authentication failures stop remaining work while keeping translations published before the failure. */
    @Test fun authenticationFailureStopsRemainingRequestsAndRetainsEarlierSuccess() {
        val calls = mutableListOf<String>()
        val published = linkedMapOf<String, String>()
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            calls.add(item.id)
            if (item.id == "file-0") response(listOf(item.id to "译文"))
            else TranslationResponse(401, "fake-test-key")
        }, 0).use { client ->
            val failure = assertThrows(TranslationException::class.java) {
                client.translate(items("file", 20), config.copy(maxConcurrency = 1), { false }, published::putAll)
            }
            assertEquals("AUTH", failure.code)
            assertEquals(listOf("file-0", "file-1"), calls)
            assertEquals(mapOf("file-0" to "译文"), failure.partialTranslations)
            assertEquals(failure.partialTranslations, published)
        }
    }

    /** A newly opened file receives the next freed slot before the older large file can refill it. */
    @Test fun waitingFileGetsACompletionBeforeLargeFileCanRefillFreedSlots() {
        val occupied = CountDownLatch(2)
        val waiting = CountDownLatch(1)
        val secondEntered = CountDownLatch(1)
        val releaseFirst = Semaphore(0)
        val releaseSecond = CountDownLatch(1)
        val firstCalls = AtomicInteger()
        val secondProbes = AtomicInteger()
        val callers = Executors.newFixedThreadPool(2)
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            if (item.id.startsWith("large")) {
                firstCalls.incrementAndGet()
                occupied.countDown()
                assertTrue(releaseFirst.tryAcquire(5, TimeUnit.SECONDS))
            } else {
                secondEntered.countDown()
                assertTrue(releaseSecond.await(5, TimeUnit.SECONDS))
            }
            response(listOf(item.id to "译文"))
        }, 0).use { client ->
            try {
                val first = callers.submit(Callable { client.translate(items("large", 20), config.copy(maxConcurrency = 2), { false }, {}) })
                assertTrue(occupied.await(5, TimeUnit.SECONDS))
                val second = callers.submit(Callable {
                    client.translate(items("new", 1), config.copy(maxConcurrency = 2), {
                        // The third cancellation probe follows a completed capacity-wait iteration.
                        if (secondProbes.incrementAndGet() >= 3) waiting.countDown()
                        false
                    }, {})
                })
                assertTrue("The second file must have joined the capacity queue", waiting.await(5, TimeUnit.SECONDS))
                releaseFirst.release()
                assertTrue("The newer file must receive the freed slot", secondEntered.await(5, TimeUnit.SECONDS))
                assertEquals("The old file must not refill ahead of an already waiting file", 2, firstCalls.get())
                releaseSecond.countDown()
                assertEquals(1, second.get(5, TimeUnit.SECONDS).size)
                assertFalse(first.isDone)
                releaseFirst.release(20)
                assertEquals(20, first.get(5, TimeUnit.SECONDS).size)
            } finally { releaseFirst.release(30); releaseSecond.countDown(); callers.shutdownNow() }
        }
    }

    /** Cancelling the next waiting file removes it from the rotation so it cannot block another file's progress. */
    @Test fun cancelledWaitingOwnerCannotBlockRemainingFileAtTheQueueHead() {
        val occupied = CountDownLatch(2)
        val waiting = CountDownLatch(1)
        val resumed = CountDownLatch(1)
        val release = Semaphore(0)
        val cancelled = AtomicBoolean(false)
        val probes = AtomicInteger()
        val firstCalls = AtomicInteger()
        val callers = Executors.newFixedThreadPool(2)
        TranslationClient(TranslationTransport { _, _, body, _, _ ->
            val item = inputItems(body).single()
            assertTrue("A cancelled waiting file must never reach HTTP", item.id.startsWith("large"))
            if (firstCalls.incrementAndGet() > 2) resumed.countDown()
            occupied.countDown()
            assertTrue(release.tryAcquire(5, TimeUnit.SECONDS))
            response(listOf(item.id to "译文"))
        }, 0).use { client ->
            try {
                val first = callers.submit(Callable { client.translate(items("large", 8), config.copy(maxConcurrency = 2), { false }, {}) })
                assertTrue(occupied.await(5, TimeUnit.SECONDS))
                val second = callers.submit(Callable {
                    assertThrows(TranslationException::class.java) {
                        client.translate(items("cancelled", 4), config.copy(maxConcurrency = 2), {
                            if (probes.incrementAndGet() >= 3) waiting.countDown()
                            cancelled.get()
                        }, {})
                    }
                })
                assertTrue(waiting.await(5, TimeUnit.SECONDS))
                cancelled.set(true)
                assertEquals("CANCELLED", second.get(5, TimeUnit.SECONDS).code)
                release.release()
                assertTrue("A cancelled owner must not retain the next slot", resumed.await(5, TimeUnit.SECONDS))
                release.release(8)
                assertEquals(8, first.get(5, TimeUnit.SECONDS).size)
            } finally { cancelled.set(true); release.release(20); callers.shutdownNow() }
        }
    }

    private fun items(prefix: String, count: Int): List<TranslationItem> =
        (0 until count).map { TranslationItem("$prefix-$it", "Comment $prefix $it") }
}
