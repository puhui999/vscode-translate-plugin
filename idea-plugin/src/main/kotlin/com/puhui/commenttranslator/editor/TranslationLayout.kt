package com.puhui.commenttranslator.editor

import java.awt.Font
import java.awt.font.FontRenderContext
import java.awt.font.LineBreakMeasurer
import java.awt.font.TextAttribute
import java.awt.font.TextLayout
import java.text.AttributedString
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/** Immutable source coordinates and translated text for an editor presentation. */
data class DisplayTranslation(
    val id: String,
    val startOffset: Int,
    val endOffset: Int,
    val text: String,
    val indent: String,
    val originalText: String? = null,
)

internal data class TranslationLine(
    val text: String,
    val layout: TextLayout?,
    val baseline: Float,
    val height: Float,
)

internal data class TranslationTextLayout(
    val lines: List<TranslationLine>,
    val totalLines: Int,
    val width: Int,
    val height: Int,
    val indent: Float,
    val control: TextLayout?,
    val controlText: String?,
    val controlTop: Float,
    val controlBaseline: Float,
) {
    val canToggle: Boolean get() = control != null

    /** Returns whether a point local to this inlay hits the expand/collapse operation row. */
    fun isControlAt(x: Float, y: Float): Boolean =
        control != null && x >= indent && x <= min(width.toFloat(), indent + control.advance + 12f) &&
            y >= controlTop && y < height
}

/** Text layout without an IDE dependency, shared by measurement, painting, and hit testing. */
internal object TranslationLayout {
    private const val COLLAPSED_LINES = 4
    private const val VERTICAL_PADDING = 4f
    private const val CONTROL_GAP = 2f
    private const val RIGHT_PADDING = 8f
    private const val MIN_TEXT_WIDTH = 32f

    /** Measures all paragraphs and exposes either four body lines or the complete translation. */
    fun build(
        text: String,
        indent: String,
        width: Int,
        font: Font,
        context: FontRenderContext,
        lineHeight: Float,
        tabSize: Int,
        expanded: Boolean,
        previewLines: Int? = COLLAPSED_LINES,
    ): TranslationTextLayout {
        require(width > 0) { "Translation width must be positive" }
        require(lineHeight > 0 && lineHeight.isFinite()) { "Translation line height must be positive" }
        require(tabSize > 0) { "Tab size must be positive" }
        require(previewLines == null || previewLines > 0) { "Preview line count must be positive" }
        val spaceWidth = TextLayout(" ", font, context).advance
        val indentPixels = min(
            indentationColumns(indent, tabSize) * spaceWidth,
            max(0f, width - RIGHT_PADDING - MIN_TEXT_WIDTH),
        )
        val textWidth = max(1f, width - indentPixels - RIGHT_PADDING)
        val wrapped = ArrayList<Pair<String, TextLayout?>>()
        // Each paragraph is measured independently: LineBreakMeasurer does not preserve hard line breaks.
        for (paragraph in text.split(Regex("\r\n|\r|\n"))) {
            val expandedTabs = expandTabs(paragraph, tabSize)
            if (expandedTabs.isEmpty()) {
                wrapped.add("" to null)
                continue
            }
            val attributed = attributedText(expandedTabs, font)
            val measurer = LineBreakMeasurer(attributed.iterator, context)
            while (measurer.position < expandedTabs.length) {
                val start = measurer.position
                val layout = measurer.nextLayout(textWidth)
                check(measurer.position > start) { "Text layout made no progress" }
                wrapped.add(expandedTabs.substring(start, measurer.position) to layout)
            }
        }
        val shown = if (expanded || previewLines == null) wrapped else wrapped.take(previewLines)
        var y = VERTICAL_PADDING
        val lines = shown.map { (lineText, layout) ->
            val measuredHeight = layout?.let { it.ascent + it.descent + it.leading } ?: lineHeight
            val height = max(lineHeight, measuredHeight)
            val ascent = layout?.ascent ?: lineHeight * 0.8f
            TranslationLine(lineText, layout, y + (height - measuredHeight) / 2f + ascent, height)
                .also { y += height }
        }
        var controlText = if (previewLines != null && wrapped.size > previewLines) {
            if (expanded) "收起" else "展开（共 ${wrapped.size} 行）"
        } else null
        var control = controlText?.let { TextLayout(attributedText(it, font).iterator, context) }
        if (control != null && control.advance > textWidth) {
            controlText = if (expanded) "收起" else "展开"
            control = TextLayout(attributedText(controlText, font).iterator, context)
        }
        val controlTop = if (control != null) y + CONTROL_GAP else y
        val controlBaseline = controlTop + (control?.ascent ?: 0f)
        if (control != null) y = controlTop + max(lineHeight, control.ascent + control.descent + control.leading)
        return TranslationTextLayout(
            lines, wrapped.size, width, ceil(y + VERTICAL_PADDING).toInt(), indentPixels,
            control, controlText, controlTop, controlBaseline,
        )
    }

    /** Expands leading whitespace using the editor's configured tab stops. */
    fun indentationColumns(indent: String, tabSize: Int): Int {
        require(tabSize > 0)
        var column = 0
        for (character in indent) {
            column += when (character) {
                '\t' -> tabSize - column % tabSize
                ' ' -> 1
                else -> 0
            }
        }
        return column
    }

    /** Finds a character inside a valid source range, away from fold boundaries and trailing newlines. */
    fun anchorOffset(source: CharSequence, start: Int, end: Int): Int? {
        if (start < 0 || end > source.length || end <= start) return null
        var anchor = end - 1
        while (anchor > start && (source[anchor] == '\r' || source[anchor] == '\n')) anchor--
        if (anchor > start && Character.isLowSurrogate(source[anchor]) && Character.isHighSurrogate(source[anchor - 1])) anchor--
        return anchor
    }

    private fun expandTabs(text: String, tabSize: Int): String {
        if ('\t' !in text) return text
        val result = StringBuilder()
        var column = 0
        for (character in text) {
            if (character == '\t') {
                val spaces = tabSize - column % tabSize
                repeat(spaces) { result.append(' ') }
                column += spaces
            } else {
                result.append(character)
                if (!Character.isLowSurrogate(character)) column++
            }
        }
        return result.toString()
    }

    private fun attributedText(text: String, font: Font): AttributedString {
        val result = AttributedString(text)
        result.addAttribute(TextAttribute.FONT, font)
        // An editor's configured physical font may lack CJK glyphs. A logical font supplies platform fallbacks.
        if (font.canDisplayUpTo(text) >= 0) {
            val fallback = Font(Font.DIALOG, font.style, 1).deriveFont(font.size2D)
            var offset = 0
            while (offset < text.length) {
                val codePoint = text.codePointAt(offset)
                val end = offset + Character.charCount(codePoint)
                if (!font.canDisplay(codePoint)) result.addAttribute(TextAttribute.FONT, fallback, offset, end)
                offset = end
            }
        }
        return result
    }
}
