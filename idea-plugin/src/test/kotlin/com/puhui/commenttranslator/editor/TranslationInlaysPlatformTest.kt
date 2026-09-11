package com.puhui.commenttranslator.editor

import com.intellij.openapi.editor.FoldRegion
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Checks the display contract against real IntelliJ editor, folding, and inlay models. */
class TranslationInlaysPlatformTest : BasePlatformTestCase() {
    /** Editor UI operations and the keyboard toggle action require the event dispatch thread. */
    override fun runInDispatchThread(): Boolean = true

    /** Expanding changes only inlay height, and both clear and parent disposal remove all owned inlays. */
    fun testRenderToggleAndDisposePreserveSourceCaretAndSelection() {
        val source = "class Example {\n    /** Original documentation. */\n    int count;\n}\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val caret = source.indexOf("count")
        editor.caretModel.moveToOffset(caret)
        editor.selectionModel.setSelection(caret, caret + "count".length)
        val stamp = editor.document.modificationStamp
        val selectionStart = editor.selectionModel.selectionStart
        val selectionEnd = editor.selectionModel.selectionEnd
        val parent = Disposer.newDisposable("translation-inlays-platform-test")
        Disposer.register(testRootDisposable, parent)
        val display = TranslationInlays(editor, parent)
        val item = DisplayTranslation(
            "long-doc", source.indexOf("/**"), source.indexOf("*/") + 2,
            "/**\n" + (1..12).joinToString("\n") { " * 这是第 $it 行中文译文。" } + "\n */", "    ",
        )

        display.render(listOf(item))
        val inlay = ownedInlays().single()
        val collapsedHeight = inlay.heightInPixels
        assertEquals(Inlay.Placement.BELOW_LINE, inlay.placement)
        assertEquals(item.endOffset - 1, inlay.offset)
        assertNotNull(inlay.bounds)
        assertTrue(display.toggle(item.id))
        assertTrue(inlay.heightInPixels > collapsedHeight)
        assertFalse(display.toggle("missing-id"))
        display.render(listOf(item))
        assertSame("An unchanged snapshot should retain its expanded inlay", inlay, ownedInlays().single())
        assertTrue(display.toggle(item.id))
        assertEquals(collapsedHeight, inlay.heightInPixels)
        assertEquals(source, editor.document.text)
        assertEquals(stamp, editor.document.modificationStamp)
        assertEquals(caret, editor.caretModel.offset)
        assertEquals(selectionStart, editor.selectionModel.selectionStart)
        assertEquals(selectionEnd, editor.selectionModel.selectionEnd)

        display.clear()
        assertTrue(ownedInlays().isEmpty())
        assertFalse(inlay.isValid)
        display.render(listOf(item))
        assertEquals(1, ownedInlays().size)
        Disposer.dispose(parent)
        assertTrue(ownedInlays().isEmpty())
        display.render(listOf(item))
        assertTrue("Disposed renderers must ignore late snapshots", ownedInlays().isEmpty())
        assertEquals(source, editor.document.text)
        assertEquals(caret, editor.caretModel.offset)
        assertEquals(selectionStart, editor.selectionModel.selectionStart)
        assertEquals(selectionEnd, editor.selectionModel.selectionEnd)
    }

    /** A comment's closing delimiter remains inside its fold, so its translation hides with the comment. */
    fun testInlayHidesInsideCollapsedCommentAndReturnsAfterExpansion() {
        val source = "before\n    /**\n     * First original line.\n     * Second original line.\n     */\nafter\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        editor.caretModel.moveToOffset(0)
        val start = source.indexOf("/**")
        val end = source.indexOf("*/") + 2
        val display = TranslationInlays(editor, testRootDisposable)
        display.render(listOf(DisplayTranslation("folded-doc", start, end, "/** 翻译后的描述。 */", "    ")))
        val inlay = ownedInlays().single()
        assertNotNull(inlay.bounds)
        var region: FoldRegion? = null
        editor.foldingModel.runBatchFoldingOperation {
            region = editor.foldingModel.addFoldRegion(start, end, "original comment")
            assertNotNull(region)
            region!!.isExpanded = false
        }
        assertFalse(region!!.isExpanded)
        assertTrue(inlay.isValid)
        assertNull("The inlay anchor must not leak out through the fold's exclusive end", inlay.bounds)
        editor.foldingModel.runBatchFoldingOperation { region!!.isExpanded = true }
        assertNotNull(inlay.bounds)
        assertEquals(source, editor.document.text)
        assertEquals(0, editor.caretModel.offset)
    }

    /** Short text has no toggle, and invalid snapshots cannot create inlays at unrelated document offsets. */
    fun testShortTextAndInvalidRanges() {
        val source = "// original\nvalue\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val display = TranslationInlays(myFixture.editor, testRootDisposable)
        val short = DisplayTranslation("short", 0, source.indexOf('\n'), "// 译文", "")
        display.render(listOf(short, short, short.copy(id = "stale", endOffset = source.length + 1)))
        assertEquals(1, ownedInlays().size)
        assertFalse(display.toggle(short.id))
        display.render(emptyList())
        assertTrue(ownedInlays().isEmpty())
        assertEquals(source, myFixture.editor.document.text)
    }

    private fun ownedInlays(): List<Inlay<*>> = myFixture.editor.inlayModel
        .getBlockElementsInRange(0, myFixture.editor.document.textLength)
        .filter { it.renderer.javaClass.name.contains("TranslationInlays") }
}
