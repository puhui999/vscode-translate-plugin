package com.puhui.commenttranslator.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.puhui.commenttranslator.TranslationController
import com.puhui.commenttranslator.settings.TranslationSettings

/** Common project-aware command implementation available while indexes are building. */
abstract class TranslationAction : DumbAwareAction() {
    /** Evaluates action availability without blocking the UI thread. */
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
    /** Requires an open project for translation commands. */
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }
}

/** Translates missing comments or continues the next file budget. */
class TranslateFileAction : TranslationAction() {
    /** Starts an explicit file translation request. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).translateCurrent() } }
}

/** Translates only the comment under the source caret. */
class TranslateCommentAction : TranslationAction() {
    /** Starts an explicit current-comment request. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).translateCurrent(true) } }
}

/** Hides or restores existing translations without requesting new content. */
class ToggleVisibleAction : TranslationAction() {
    /** Switches the current source file's display policy. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).toggleVisible() } }
}

/** Controls automatic requests separately from the visibility of completed translations. */
class ToggleAutomaticAction : ToggleAction(), DumbAware {
    /** Evaluates the stored preference on a background thread. */
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
    /** Indicates whether automatic translation is currently enabled. */
    override fun isSelected(e: AnActionEvent): Boolean = TranslationSettings.getInstance().state.automatic
    /** Changes automatic policy across open IDE projects. */
    override fun setSelected(e: AnActionEvent, state: Boolean) {
        if (state != TranslationSettings.getInstance().state.automatic) e.project?.let { TranslationController.getInstance(it).toggleAutomatic() }
    }
}

/** Opens a selectable read-only snapshot of translated source. */
class ReaderAction : TranslationAction() {
    /** Opens the translated snapshot only after translations exist. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).openReader() } }
}

/** Copies a translated comment independently of source copy operations. */
class CopyTranslationAction : TranslationAction() {
    /** Copies the formatted current translation. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).copyCurrentTranslation() } }
}

/** Exposes original-text reveal and translation expansion to keyboard users. */
class ExpandTranslationAction : TranslationAction() {
    /** Toggles the original or expanded translation at the source caret in the active editor. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).expandCurrentTranslation() } }
}

/** Opens the native provider settings page. */
class SettingsAction : TranslationAction() {
    /** Shows provider configuration. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).openSettings() } }
}

/** Clears reusable translations after cancelling automatic work. */
class ClearCacheAction : TranslationAction() {
    /** Clears the local database and leaves automatic requests paused. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).clearCache() } }
}

/** Opens a network-free demonstration of native multiline comment translation. */
class DemoAction : TranslationAction() {
    /** Opens the scratch source and fixed translations. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).openDemo() } }
}
