package com.puhui.commenttranslator

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/** Activates translation after project startup without doing network work on the UI thread. */
class TranslationStartup : ProjectActivity {
    /** Registers project listeners and restores the configured automatic policy. */
    override suspend fun execute(project: Project) { TranslationController.getInstance(project).start() }
}

/** Displays one sanitized user-facing notification; provider response bodies are never shown. */
fun notifyTranslation(project: Project?, message: String, error: Boolean) {
    NotificationGroupManager.getInstance().getNotificationGroup("Comment Translator")
        .createNotification("注释译读", message, if (error) NotificationType.WARNING else NotificationType.INFORMATION)
        .notify(project)
}
