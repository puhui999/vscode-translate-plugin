package com.puhui.commenttranslator

/** Coalesces request snapshots through an injected UI scheduler without dropping updates during delivery. */
internal class TranslationProgress(
    private val schedule: (() -> Unit) -> Unit,
    private val isCurrent: () -> Boolean,
) {
    private val lock = Any()
    private var latest: (() -> Unit)? = null
    private var queued = false
    @Volatile private var finished = false

    /** Keeps the latest snapshot and schedules at most one pending UI delivery. */
    fun publish(update: () -> Unit) {
        val enqueue = synchronized(lock) {
            if (finished) return
            latest = update
            if (queued) false else { queued = true; true }
        }
        if (enqueue) schedule(::deliver)
    }

    /** Stops deferred delivery and returns the latest pending snapshot for an optional failure flush. */
    fun finish(): (() -> Unit)? = synchronized(lock) {
        finished = true
        latest.also { latest = null }
    }

    private fun deliver() {
        val newest = synchronized(lock) {
            // Releasing the queue slot and reading its snapshot together prevents a lost wakeup.
            queued = false
            latest
        }
        if (!finished && isCurrent()) {
            newest?.invoke()
            synchronized(lock) {
                // An update published during delivery owns its own scheduled delivery.
                if (latest === newest) latest = null
            }
        }
    }
}
