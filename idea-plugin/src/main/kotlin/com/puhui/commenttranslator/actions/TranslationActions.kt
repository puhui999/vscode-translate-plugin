package com.puhui.commenttranslator.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.puhui.commenttranslator.TranslationActionTarget
import com.puhui.commenttranslator.TranslationActionState
import com.puhui.commenttranslator.TranslationController
import com.puhui.commenttranslator.settings.TranslationSettings

/** Common project-aware command implementation available while indexes are building. */
abstract class TranslationAction : DumbAwareAction() {
    /** Reads lightweight editor state on the UI thread without PSI scans or network work. */
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
    /** Requires a project; file-oriented actions additionally inspect the actual menu context. */
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }

    protected fun contextState(e: AnActionEvent): TranslationActionState = e.project?.let {
        TranslationController.getInstance(it).actionState(TranslationActionTarget.from(e))
    } ?: TranslationActionState()
}

/** Translates missing comments or continues the next file budget. */
class TranslateFileAction : TranslationAction() {
    /** Shows when automatic work is already in progress and makes the manual retry purpose explicit. */
    override fun update(e: AnActionEvent) {
        val state = contextState(e)
        e.presentation.isEnabled = state.supported && !state.running
        e.presentation.text = if (state.running) "正在翻译当前文件…" else "检查 / 继续翻译当前文件"
        e.presentation.description = "打开文件会自动翻译；此操作用于重试或继续，已有缓存直接复用。"
    }
    /** Starts an explicit file translation request. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).translateCurrent(target = TranslationActionTarget.from(e)) } }
}

/** Translates only the comment under the source caret. */
class TranslateCommentAction : TranslationAction() {
    /** Avoids offering a duplicate request while the file is already translating. */
    override fun update(e: AnActionEvent) {
        val state = contextState(e)
        e.presentation.isEnabled = state.supported && !state.running
        e.presentation.description = "翻译光标或右键所指的注释；已有译文直接复用。"
    }
    /** Starts an explicit current-comment request. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).translateCurrent(true, TranslationActionTarget.from(e)) } }
}

/** Hides or restores existing translations without requesting new content. */
class ToggleVisibleAction : TranslationAction() {
    /** Exposes the next visible effect and disables the operation until there are translations. */
    override fun update(e: AnActionEvent) {
        val state = contextState(e)
        e.presentation.isEnabled = state.hasTranslations
        e.presentation.text = if (state.visible) "隐藏当前文件译文" else "显示当前文件译文"
        e.presentation.description = if (state.hasTranslations) "只改变显示，不重复请求 AI。" else "等待当前文件生成译文。"
    }
    /** Switches the current source file's display policy. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).toggleVisible(TranslationActionTarget.from(e)) } }
}

/** Controls automatic requests separately from the visibility of completed translations. */
class ToggleAutomaticAction : ToggleAction(), DumbAware {
    /** Reads the stored preference consistently with the other menu actions. */
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT
    /** Keeps the global toggle unavailable when no project is open. */
    override fun update(e: AnActionEvent) { super.update(e); e.presentation.isEnabled = e.project != null }
    /** Indicates whether automatic translation is currently enabled. */
    override fun isSelected(e: AnActionEvent): Boolean = TranslationSettings.getInstance().state.automatic
    /** Changes automatic policy across open IDE projects. */
    override fun setSelected(e: AnActionEvent, state: Boolean) {
        if (state != TranslationSettings.getInstance().state.automatic) e.project?.let { TranslationController.getInstance(it).toggleAutomatic() }
    }
}

/** Opens a selectable read-only snapshot of translated source. */
class ReaderAction : TranslationAction() {
    /** Offers a snapshot only when the invoked file has current translations. */
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = contextState(e).hasTranslations
        e.presentation.description = "使用当前文件已有译文打开只读快照。"
    }
    /** Opens the translated snapshot only after translations exist. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).openReader(TranslationActionTarget.from(e)) } }
}

/** Copies a translated comment independently of source copy operations. */
class CopyTranslationAction : TranslationAction() {
    /** Requires a translation at the clicked location, even if the caret is elsewhere. */
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = contextState(e).hasCurrentTranslation }
    /** Copies the formatted current translation. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).copyCurrentTranslation(TranslationActionTarget.from(e)) } }
}

/** Exposes original-text reveal and translation expansion to keyboard users. */
class ExpandTranslationAction : TranslationAction() {
    /** Requires a translated comment in the actual action context. */
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = contextState(e).hasCurrentTranslation }
    /** Toggles the original or expanded translation at the source caret in the active editor. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).expandCurrentTranslation(TranslationActionTarget.from(e)) } }
}

/** Opens the native provider settings page. */
class SettingsAction : TranslationAction() {
    /** Shows provider configuration. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).openSettings() } }
}

/** Clears reusable translations while preserving the automatic preference. */
class ClearCacheAction : TranslationAction() {
    /** Clears the database and resumes open files when automatic translation is enabled. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).clearCache() } }
}

/** Opens a network-free demonstration of native multiline comment translation. */
class DemoAction : TranslationAction() {
    /** Opens the scratch source and fixed translations. */
    override fun actionPerformed(e: AnActionEvent) { e.project?.let { TranslationController.getInstance(it).openDemo() } }
}
