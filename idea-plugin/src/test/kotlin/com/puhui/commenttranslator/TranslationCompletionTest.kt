package com.puhui.commenttranslator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Regression scenarios for completion state, independent of network timing and the IDE event queue. */
class TranslationCompletionTest {
    /** Displaying initial cache hits cannot suppress automatic translation of the missing comments. */
    @Test fun initialAndPartialResultsLeaveTheFileUnfinished() {
        val completion = TranslationCompletion()
        completion.publish(10)
        completion.publish(10)
        assertEquals(-1L, completion.completedVersion)
        assertTrue(completion.needsAutomaticRun(10, false))
    }

    /** A successful current-comment request remains incomplete until the full-file request finishes. */
    @Test fun currentCommentSuccessDoesNotCompleteTheFile() {
        val completion = TranslationCompletion()
        completion.publish(20, wholeFileCompleted = false)
        assertTrue(completion.needsAutomaticRun(20, false))
        completion.publish(20, wholeFileCompleted = true)
        assertFalse(completion.needsAutomaticRun(20, false))
    }

    /** Re-entering a tab does not cancel a running request; pausing and resuming unfinished work restarts it. */
    @Test fun pausedWorkResumesButActiveWorkIsNotRestarted() {
        val completion = TranslationCompletion()
        completion.publish(30)
        assertFalse(completion.needsAutomaticRun(30, true))
        assertTrue(completion.needsAutomaticRun(30, false))
        completion.publish(30, wholeFileCompleted = true)
        assertFalse(completion.needsAutomaticRun(30, false))
    }

    /** A completed automatic budget stays complete until source, settings, or cached contents invalidate it. */
    @Test fun completedVersionSurvivesTabSwitchesAndDetectsInvalidation() {
        val completion = TranslationCompletion()
        completion.publish(40, wholeFileCompleted = true)
        completion.publish(40, wholeFileCompleted = false)
        assertFalse(completion.needsAutomaticRun(40, false))
        assertTrue(completion.needsAutomaticRun(41, false))
        completion.invalidate()
        assertTrue(completion.needsAutomaticRun(40, false))
    }
}
