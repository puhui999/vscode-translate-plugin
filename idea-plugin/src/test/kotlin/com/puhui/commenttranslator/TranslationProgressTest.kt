package com.puhui.commenttranslator

import org.junit.Assert.*
import org.junit.Test

/** Uses a manual UI queue to exercise progress/terminal ordering without sleeps or real network requests. */
class TranslationProgressTest {
    /** Several completed comments before the UI delivery produce one complete latest snapshot. */
    @Test fun coalescesPendingSnapshotsUntilScheduledDelivery() {
        val ui = ManualUi()
        val shown = mutableListOf<List<String>>()
        val progress = TranslationProgress(ui::schedule) { true }
        progress.publish { shown += listOf("first") }
        progress.publish { shown += listOf("first", "second") }
        assertEquals(1, ui.pending)
        assertTrue(shown.isEmpty())

        ui.runNext()

        assertEquals(listOf(listOf("first", "second")), shown)
        assertNull(progress.finish())
    }

    /** An update arriving after the queued delivery begins owns a new wakeup and survives cleanup of the older snapshot. */
    @Test fun publishingDuringDeliveryAlwaysSchedulesTheNewSnapshot() {
        val ui = ManualUi()
        val shown = mutableListOf<String>()
        var publishWhileValidating = true
        lateinit var progress: TranslationProgress
        progress = TranslationProgress(ui::schedule) {
            if (publishWhileValidating) {
                publishWhileValidating = false
                progress.publish { shown += "second" }
            }
            true
        }
        progress.publish { shown += "first" }

        ui.runNext()

        assertEquals(listOf("first"), shown)
        assertEquals("The newer result must not wait for another HTTP completion", 1, ui.pending)
        ui.runNext()
        assertEquals(listOf("first", "second"), shown)
        assertEquals(0, ui.pending)
        assertNull(progress.finish())
    }

    /** Successful final publication supersedes all queued intermediate states. */
    @Test fun successCannotBeOverwrittenByAnEarlierQueuedProgressSnapshot() {
        val ui = ManualUi()
        val states = mutableListOf<String>()
        val progress = TranslationProgress(ui::schedule) { true }
        progress.publish { states += "partial" }
        progress.finish()
        states += "complete"

        ui.runAll()

        assertEquals(listOf("complete"), states)
    }

    /** If the last request fails, successes still waiting in the UI queue are flushed before the error status. */
    @Test fun failureFlushPreservesAllLatestSuccessesAndThenKeepsItsFinalStatus() {
        val ui = ManualUi()
        val states = mutableListOf<String>()
        val progress = TranslationProgress(ui::schedule) { true }
        progress.publish { states += "one success" }
        progress.publish { states += "two successes" }
        val pending = progress.finish()
        assertNotNull(pending)
        pending!!.invoke()
        states += "failed third request"

        ui.runAll()

        assertEquals(listOf("two successes", "failed third request"), states)
        assertNull(progress.finish())
    }

    /** Stopping after a UI snapshot was acquired must still make it available to the failure flush. */
    @Test fun finishDuringDeliveryRetainsTheSnapshotUntilItHasActuallyBeenApplied() {
        val ui = ManualUi()
        val shown = mutableListOf<String>()
        var pending: (() -> Unit)? = null
        lateinit var progress: TranslationProgress
        progress = TranslationProgress(ui::schedule) {
            pending = progress.finish()
            false
        }
        progress.publish { shown += "successful comment" }

        ui.runNext()

        assertTrue(shown.isEmpty())
        assertNotNull("Acquiring a pending snapshot must not consume its failure flush", pending)
        pending!!.invoke()
        assertEquals(listOf("successful comment"), shown)
    }

    /** Document changes or task cancellation make queued displays ineligible; late publishers cannot revive a finished task. */
    @Test fun invalidatedTasksNeverDisplayQueuedOrLateSnapshots() {
        val ui = ManualUi()
        val shown = mutableListOf<String>()
        var current = true
        val progress = TranslationProgress(ui::schedule) { current }
        progress.publish { shown += "stale" }
        current = false
        ui.runNext()
        progress.finish()
        progress.publish { shown += "late" }
        ui.runAll()
        assertEquals(0, ui.pending)
        assertTrue(shown.isEmpty())
    }

    /** Stopping one file cannot suppress another file's independent progress on the shared UI queue. */
    @Test fun fileProgressInstancesRemainIndependent() {
        val ui = ManualUi()
        val shown = mutableListOf<String>()
        val first = TranslationProgress(ui::schedule) { true }
        val second = TranslationProgress(ui::schedule) { true }
        first.publish { shown += "first" }
        second.publish { shown += "second" }
        first.finish()

        ui.runAll()

        assertEquals(listOf("second"), shown)
    }

    private class ManualUi {
        private val tasks = ArrayDeque<() -> Unit>()
        val pending: Int get() = tasks.size
        fun schedule(task: () -> Unit) { tasks.addLast(task) }
        fun runNext() { tasks.removeFirst().invoke() }
        fun runAll() { while (tasks.isNotEmpty()) runNext() }
    }
}
