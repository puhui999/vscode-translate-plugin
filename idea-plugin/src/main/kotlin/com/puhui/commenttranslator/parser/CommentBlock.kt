package com.puhui.commenttranslator.parser

/**
 * Immutable comment snapshot taken under a PSI read action.
 *
 * [startOffset] and [endOffset] are UTF-16 document offsets, with an exclusive end.
 * [rawText] includes comment delimiters but excludes the first line's outer [indent].
 * [text] is the translatable body; documentation tags and relative indentation remain intact.
 */
data class CommentBlock(
    val id: String,
    val startOffset: Int,
    val endOffset: Int,
    val rawText: String,
    val text: String,
    val languageId: String,
    val indent: String,
)
