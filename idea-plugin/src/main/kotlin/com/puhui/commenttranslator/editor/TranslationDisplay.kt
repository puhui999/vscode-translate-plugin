package com.puhui.commenttranslator.editor

import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Key

/** Identifies only translation-owned folds when resolving keyboard actions at a collapsed comment. */
internal val TRANSLATED_COMMENT_ID = Key.create<String>("puhui.translated-comment-id")

/** Locates the live replacement owner for editor actions that must reveal hidden source before editing. */
internal val ACTIVE_REPLACEMENTS = Key.create<TranslationReplacements>("puhui.active-replacements")

/** Owns one editor's translated presentation without changing its source document. */
interface TranslationDisplay : Disposable {
    /** Displays a validated snapshot of comments and their translations. */
    fun render(items: List<DisplayTranslation>)
    /** Removes owned visual elements and restores the original presentation. */
    fun clear()
    /** Toggles the comment's original text or expanded translation in this editor. */
    fun toggle(id: String): Boolean
}
