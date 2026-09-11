package com.puhui.commenttranslator

/** Tracks full-file completion separately from the version of results already available for display. */
internal class TranslationCompletion {
    var completedVersion: Long = -1L
        private set

    /** Partial/cache results and current-comment requests never complete an entire file. */
    fun publish(version: Long, wholeFileCompleted: Boolean = false) {
        if (wholeFileCompleted) completedVersion = version
    }

    /** Invalidates completion after source, provider configuration, or cache contents change. */
    fun invalidate() { completedVersion = -1L }

    /** Resumes unfinished work without restarting an already running request or repeating a completed file. */
    fun needsAutomaticRun(version: Long, requestRunning: Boolean): Boolean = completedVersion != version && !requestRunning
}
