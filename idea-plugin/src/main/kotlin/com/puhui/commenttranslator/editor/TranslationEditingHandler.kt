package com.puhui.commenttranslator.editor

import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.editor.Caret
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.DocCommandGroupId
import com.intellij.openapi.editor.actionSystem.EditorActionHandler

/** Reveals translated source before a destructive editor action can delete an entire custom fold. */
abstract class TranslationEditingHandler(
    private val original: EditorActionHandler,
    private val backward: Boolean,
    private val wholeLine: Boolean = false,
) : EditorActionHandler(false) {
    /** Keeps the underlying editor action's availability rules. */
    override fun isEnabledForCaret(editor: Editor, caret: Caret, dataContext: DataContext?): Boolean =
        original.isEnabled(editor, caret, dataContext)

    /** Preserves the underlying action's command and undo grouping policy. */
    override fun executeInCommand(editor: Editor, dataContext: DataContext?): Boolean = original.executeInCommand(editor, dataContext)

    /** Preserves the original action's undo group. */
    override fun getCommandGroupId(editor: Editor): DocCommandGroupId? = original.getCommandGroupId(editor)

    /** Consumes only the first destructive action touching a translated fold; ordinary editing delegates unchanged. */
    override fun doExecute(editor: Editor, caret: Caret?, dataContext: DataContext?) {
        val owner = editor.getUserData(ACTIVE_REPLACEMENTS)
        if (owner != null) {
            val carets = caret?.let(::listOf) ?: editor.caretModel.allCarets
            val ids = linkedSetOf<String>()
            val folds = editor.foldingModel.allFoldRegions.filter { it.isValid && !it.isExpanded && it.getUserData(TRANSLATED_COMMENT_ID) != null }
            for (current in carets) {
                if (current.hasSelection() || wholeLine) {
                    val start = if (current.hasSelection()) current.selectionStart else editor.document.getLineStartOffset(current.logicalPosition.line)
                    val end = if (current.hasSelection()) current.selectionEnd else editor.document.getLineEndOffset(current.logicalPosition.line)
                    folds.filter { it.startOffset < end && start < it.endOffset }
                        .forEach { ids.add(it.getUserData(TRANSLATED_COMMENT_ID)!!) }
                } else {
                    val offset = current.offset - if (backward) 1 else 0
                    if (offset >= 0 && offset < editor.document.textLength) {
                        editor.foldingModel.getCollapsedRegionAtOffset(offset)?.getUserData(TRANSLATED_COMMENT_ID)?.let(ids::add)
                    }
                }
            }
            // Check every caret before delegating: never delete at one caret while revealing another.
            var revealed = false
            ids.forEach { if (owner.reveal(it)) revealed = true }
            if (revealed) return
        }
        original.execute(editor, caret, dataContext)
    }
}

/** Protects forward deletion at the start of a translated comment. */
class TranslationDeleteHandler(original: EditorActionHandler) : TranslationEditingHandler(original, backward = false)

/** Protects backward deletion at the end of a translated comment. */
class TranslationBackspaceHandler(original: EditorActionHandler) : TranslationEditingHandler(original, backward = true)

/** Reveals a translated line before cut computes its visual-line source range. */
class TranslationCutHandler(original: EditorActionHandler) : TranslationEditingHandler(original, backward = false, wholeLine = true)

/** Reveals a translated line before delete-line computes its source range. */
class TranslationDeleteLineHandler(original: EditorActionHandler) : TranslationEditingHandler(original, backward = false, wholeLine = true)
