package com.puhui.commenttranslator.translation

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Callable
import java.util.concurrent.Future
import java.util.concurrent.FutureTask
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Shares a bounded number of request workers across every file using one translation client. */
internal class TranslationScheduler : AutoCloseable {
    private val lock = Any()
    private val tasks = mutableSetOf<ScheduledTask<*>>()
    private val waitingOwners = linkedSetOf<Any>()
    private var limit = 10
    private var explicitLimit = false
    private var closed = false
    private val sequence = AtomicInteger()
    private val executor = ThreadPoolExecutor(10, 64, 30, TimeUnit.SECONDS, ArrayBlockingQueue(64), ThreadFactory {
        Thread(it, "comment-translator-http-${sequence.incrementAndGet()}").apply { isDaemon = true }
    }).apply { allowCoreThreadTimeOut(true) }

    /** Gives runtime configuration priority over older provider snapshots still attached to file requests. */
    fun configure(limit: Int) = synchronized(lock) {
        updateLimit(limit)
        explicitLimit = true
    }

    /** Lets standalone clients honor their provider configuration until a runtime limit is explicitly installed. */
    fun prepare(limit: Int) = synchronized(lock) {
        if (!explicitLimit) updateLimit(limit)
    }

    /** Reads the current live window so raising the limit also benefits a file already in progress. */
    fun currentLimit(): Int = synchronized(lock) { limit }

    /** Grants one slot to the next waiting file; an active file rejoins the tail when it needs another slot. */
    fun <T> trySubmit(owner: Any, work: () -> T, completed: (Future<T>) -> Unit): Future<T>? = synchronized(lock) {
        if (closed) return null
        waitingOwners.add(owner)
        if (tasks.size >= limit || waitingOwners.first() !== owner) return null
        waitingOwners.remove(owner)
        val task = ScheduledTask(work, completed)
        tasks.add(task)
        try {
            executor.execute(task)
        } catch (error: RuntimeException) {
            tasks.remove(task)
            task.cancel(false)
            throw error
        }
        task
    }

    /** Removes a file that is full, finished, or cancelled so it cannot block free slots at the head of the queue. */
    fun withdraw(owner: Any) = synchronized(lock) { waitingOwners.remove(owner); Unit }

    /** Cancels queued and in-flight work while keeping occupied slots until each worker has actually stopped. */
    override fun close() {
        val pending = synchronized(lock) {
            if (closed) return
            closed = true
            waitingOwners.clear()
            tasks.toList()
        }
        pending.forEach { it.cancel(true) }
        // Cancelled tasks removed from the executor queue still need their finally block to release ownership.
        executor.shutdownNow().forEach { it.run() }
    }

    private fun updateLimit(limit: Int) {
        this.limit = limit
        if (executor.corePoolSize != limit) executor.corePoolSize = limit
    }

    private inner class ScheduledTask<T>(work: () -> T, private val completed: (Future<T>) -> Unit) : FutureTask<T>(Callable(work)) {
        override fun run() {
            try {
                super.run()
            } finally {
                synchronized(lock) { tasks.remove(this) }
                completed(this)
            }
        }
    }
}
