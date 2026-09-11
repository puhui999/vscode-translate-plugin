package com.puhui.commenttranslator.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.Font
import java.awt.font.FontRenderContext
import java.awt.geom.AffineTransform

/** Exercises wrapping and interaction geometry without launching an IDE or making network requests. */
class TranslationLayoutTest {
    private val font = Font(Font.MONOSPACED, Font.PLAIN, 14)
    private val context = FontRenderContext(AffineTransform(), true, true)

    private fun layout(text: String, width: Int = 420, expanded: Boolean = false, indent: String = "") =
        TranslationLayout.build(text, indent, width, font, context, 18f, 4, expanded)

    /** Short translations remain a single borderless text row without an unnecessary control. */
    @Test fun shortTranslationNeedsNoToggle() {
        val result = layout("// 返回当前用户。")
        assertEquals(1, result.lines.size)
        assertEquals("// 返回当前用户。", result.lines.single().text)
        assertFalse(result.canToggle)
        assertNull(result.controlText)
        assertTrue(result.height > 18)
    }

    /** A narrower viewport wraps content without dropping any words. */
    @Test fun viewportWidthChangesWrappingWithoutLosingContent() {
        val text = "A translation containing several words that must stay complete after the editor becomes narrower."
        val wide = layout(text, 800, true)
        val narrow = layout(text, 140, true)
        assertTrue(narrow.totalLines > wide.totalLines)
        assertEquals(text, narrow.lines.joinToString("") { it.text })
        assertTrue(narrow.lines.all { it.layout == null || it.layout.advance <= narrow.width + 0.1f })
    }

    /** Expanded rendering exposes the entire translation, while collapsed rendering uses four body rows. */
    @Test fun longTranslationHasFourRowsAndCanExpandCompletely() {
        val text = (1..11).joinToString("\n") { "译文第 $it 行" }
        val collapsed = layout(text)
        val expanded = layout(text, expanded = true)
        assertEquals(4, collapsed.lines.size)
        assertEquals(11, collapsed.totalLines)
        assertEquals("展开（共 11 行）", collapsed.controlText)
        assertEquals(11, expanded.lines.size)
        assertEquals(text, expanded.lines.joinToString("\n") { it.text })
        assertEquals("收起", expanded.controlText)
        assertTrue(expanded.height > collapsed.height)
    }

    /** Four exact rows do not need an expand control. */
    @Test fun exactlyFourRowsRemainUnadorned() {
        val result = layout("一\n二\n三\n四")
        assertEquals(4, result.lines.size)
        assertFalse(result.canToggle)
    }

    /** Source replacements always expose every row and never append an inlay-only operation line. */
    @Test fun replacementLayoutHasNoPreviewLimitOrControls() {
        val text = (1..15).joinToString("\n") { " * 完整译文第 $it 行。" }
        val result = TranslationLayout.build(text, "    ", 420, font, context, 18f, 4,
            expanded = false, previewLines = null)
        assertEquals(15, result.lines.size)
        assertEquals(text, result.lines.joinToString("\n") { it.text })
        assertFalse(result.canToggle)
        assertNull(result.controlText)
    }

    /** CRLF, blank paragraphs, and a trailing blank line survive layout. */
    @Test fun hardLineBreaksAndBlankLinesArePreserved() {
        val result = layout("/**\r\n * 第一段。\r\n\r\n * 第二段。\r\n */\r\n", expanded = true)
        assertEquals(listOf("/**", " * 第一段。", "", " * 第二段。", " */", ""), result.lines.map { it.text })
        assertTrue(result.lines.zipWithNext().all { (left, right) -> right.baseline > left.baseline })
    }

    /** Code-like indentation uses tab stops and stays outside the wrapped prose. */
    @Test fun tabIndentationIsMeasuredByStops() {
        assertEquals(8, TranslationLayout.indentationColumns(" \t\t", 4))
        assertEquals(6, TranslationLayout.indentationColumns("\t  ", 4))
        val spaces = layout("第一行\n第二行", indent = "    ")
        val tab = layout("第一行\n第二行", indent = "\t")
        assertEquals(spaces.indent, tab.indent, 0.001f)
        assertTrue(tab.indent > 0)
    }

    /** Deep source indentation leaves a readable region in a narrow split. */
    @Test fun narrowSplitDoesNotAllocateAllWidthToIndentation() {
        val result = layout("这是需要显示的译文", width = 100, indent = "\t".repeat(30))
        assertTrue(result.indent >= 0)
        assertTrue(result.indent < result.width - 20)
        assertTrue(result.lines.isNotEmpty())
    }

    /** A click on prose cannot trigger the expand/collapse control. */
    @Test fun onlyControlRowIsInteractive() {
        val result = layout((1..8).joinToString("\n") { "第 $it 行" }, indent = "  ")
        assertFalse(result.isControlAt(result.indent + 2, result.lines.first().baseline))
        assertFalse(result.isControlAt(result.indent - 1, result.controlTop + 1))
        assertTrue(result.isControlAt(result.indent + 2, result.controlTop + 1))
        assertFalse(result.isControlAt(result.width + 1f, result.controlTop + 1))
        assertFalse(result.isControlAt(result.indent + 2, result.height + 1f))
    }

    /** Very long unbroken words are wrapped, and Unicode surrogate pairs remain intact. */
    @Test fun longWordsAndEmojiMakeProgressWithoutCorruption() {
        val text = "supercalifragilisticexpialidocious".repeat(4) + "😀中文🚀".repeat(8)
        val result = layout(text, width = 60, expanded = true)
        assertEquals(text, result.lines.joinToString("") { it.text })
        assertTrue(result.lines.size > 4)
        assertTrue(result.lines.all { line ->
            line.text.isNotEmpty() && !Character.isLowSurrogate(line.text.first()) && !Character.isHighSurrogate(line.text.last())
        })
    }

    /** Font zoom increases reserved height to prevent overlapping the following source line. */
    @Test fun fontZoomRecomputesHeight() {
        val small = layout("第一行\n第二行")
        val large = TranslationLayout.build("第一行\n第二行", "", 420, font.deriveFont(26f), context, 32f, 4, false)
        assertTrue(large.height > small.height)
        assertTrue(large.lines.last().baseline < large.height)
    }

    /** Empty input remains measurable, even though the host filters it from rendering. */
    @Test fun emptyTextDoesNotCallTextLayoutWithAnEmptyIterator() {
        val result = layout("")
        assertEquals(1, result.lines.size)
        assertNull(result.lines.single().layout)
        assertFalse(result.canToggle)
    }

    /** The anchor lies inside the comment so normal code folding hides its translation. */
    @Test fun anchorIsInsideExclusiveCommentBoundary() {
        val source = "class A {\n  /** docs */\n  int value;\n}"
        val start = source.indexOf("/**")
        val end = source.indexOf("*/") + 2
        val anchor = TranslationLayout.anchorOffset(source, start, end)
        assertEquals(end - 1, anchor)
        assertTrue(anchor!! >= start && anchor < end)
        assertEquals('/', source[anchor])
    }

    /** A supplied line ending does not move the block onto the following source line. */
    @Test fun anchorSkipsTrailingLineEndingsAndDoesNotSplitSurrogates() {
        assertEquals(7, TranslationLayout.anchorOffset("// docs.\r\n", 0, 10))
        assertEquals(3, TranslationLayout.anchorOffset("// 😀", 0, 5))
    }

    /** Invalid or stale source ranges are rejected rather than attached to unrelated code. */
    @Test fun invalidAnchorsAreRejected() {
        assertNull(TranslationLayout.anchorOffset("abc", -1, 2))
        assertNull(TranslationLayout.anchorOffset("abc", 2, 2))
        assertNull(TranslationLayout.anchorOffset("abc", 1, 5))
        assertNotNull(TranslationLayout.anchorOffset("abc", 0, 3))
    }
}
