package com.puhui.commenttranslator

import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.ide.DataManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.Consumer
import java.awt.event.MouseEvent

const val TRANSLATION_WIDGET_ID = "PuhuiCommentTranslatorStatus"

/** Adds an unobtrusive file-level progress indicator with a native actions menu. */
class TranslationStatusFactory : StatusBarWidgetFactory {
    /** Identifies this widget factory. */
    override fun getId(): String = TRANSLATION_WIDGET_ID
    /** Names the status widget in IDE settings. */
    override fun getDisplayName(): String = "注释译读"
    /** Creates one widget for the current project. */
    override fun createWidget(project: Project): StatusBarWidget = TranslationStatus(project)
}

private class TranslationStatus(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    /** Identifies this status widget instance. */
    override fun ID(): String = TRANSLATION_WIDGET_ID
    /** Uses the native status bar text presentation. */
    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this
    /** Returns the current file's translation progress. */
    override fun getText(): String = if (project.isDisposed) "译读" else TranslationController.getInstance(project).statusText()
    /** Aligns the compact text with neighbouring status items. */
    override fun getAlignment(): Float = 0.5f
    /** Explains the status and its action menu. */
    override fun getTooltipText(): String = "注释译读：点击配置、重试、显示译文或打开阅读快照。"
    /** Opens the same command group used by the editor context menu. */
    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { event ->
        val group = ActionManager.getInstance().getAction("CommentTranslator.Menu") as? ActionGroup
        if (group != null && !project.isDisposed) JBPopupFactory.getInstance().createActionGroupPopup(
            "注释译读", group, DataManager.getInstance().getDataContext(event.component), JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true
        ).show(RelativePoint(event))
    }
}
