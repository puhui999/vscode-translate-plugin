package com.puhui.commenttranslator.editor

import com.intellij.codeInsight.documentation.render.DocRenderManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.CustomFoldRegion
import com.intellij.openapi.editor.FoldRegion
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Verifies replacement folds using the actual IntelliJ editor implementation. */
class TranslationReplacementsPlatformTest : BasePlatformTestCase() {
    /** Folding, caret changes, and layout run on the UI thread. */
    override fun runInDispatchThread(): Boolean = true

    /** A whole-line comment reserves every translated row and leaves source/editor state intact. */
    fun testWholeLineReplacementShowsCompleteTranslationAndRestoresOnClearAndDispose() {
        val source = "class Example {\n    /** Original docs. */\n    int value;\n}\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val caret = source.indexOf("value")
        editor.caretModel.moveToOffset(caret)
        editor.selectionModel.setSelection(caret, caret + 5)
        val stamp = editor.document.modificationStamp
        val parent = Disposer.newDisposable("replacement-test")
        Disposer.register(testRootDisposable, parent)
        val display = TranslationReplacements(editor, parent)
        val item = item(source, "/**", "*/", "/**\n" + (1..12).joinToString("\n") { " * 完整译文 $it" } + "\n */")
        display.render(listOf(item))
        val fold = owned().single() as CustomFoldRegion
        assertTrue(fold.heightInPixels >= 14 * editor.lineHeight)
        assertEquals(editor.document.getLineStartOffset(1), fold.startOffset)
        assertEquals(item.id, fold.getUserData(TRANSLATED_COMMENT_ID))
        assertEquals(source, editor.document.text)
        assertEquals(stamp, editor.document.modificationStamp)
        assertEquals(caret, editor.caretModel.offset)
        assertEquals(caret, editor.selectionModel.selectionStart)
        assertEquals(caret + 5, editor.selectionModel.selectionEnd)
        display.render(listOf(item))
        assertSame(fold, owned().single())
        display.clear()
        assertTrue(owned().isEmpty())
        assertFalse(fold.isValid)
        display.render(listOf(item))
        assertEquals(1, owned().size)
        Disposer.dispose(parent)
        assertTrue(owned().isEmpty())
        display.render(listOf(item))
        assertTrue(owned().isEmpty())
        assertEquals(source, editor.document.text)
    }

    /** File-start and indented delimiter boundary carets must not suppress a single-line doc translation. */
    fun testSingleLineDocAtCaretBoundaryFallsBackWithoutMovingCaret() {
        val source = "    /** Original docs. */\nclass Example {}\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val display = TranslationReplacements(editor, testRootDisposable)
        val item = item(source, "/**", "*/", "/** 中文描述。 */")
        editor.caretModel.moveToOffset(0)
        display.render(listOf(item))
        assertTrue(owned().single() is CustomFoldRegion)
        display.clear()
        editor.caretModel.moveToOffset(item.startOffset)
        display.render(listOf(item))
        val fold = owned().single()
        assertFalse(fold is CustomFoldRegion)
        assertEquals(item.startOffset, fold.startOffset)
        assertEquals(item.endOffset, fold.endOffset)
        assertEquals(item.startOffset, editor.caretModel.offset)
        assertTrue(display.toggle(item.id))
        assertTrue(display.toggle(item.id))
        assertTrue("An explicit toggle at the indented delimiter can restore multiline presentation", owned().single() is CustomFoldRegion)
        assertEquals(0, editor.caretModel.offset)
        assertEquals(source, editor.document.text)
    }

    /** Inline blocks and line-end comments replace only their precise source span. */
    fun testInlineAndMixedMultilineCommentsCannotHideCode() {
        val source = "int x = 1; // Original trailing comment\ncall(/* Original\n block */ value);\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val display = TranslationReplacements(editor, testRootDisposable)
        val trailingStart = source.indexOf("//")
        val trailingEnd = source.indexOf('\n')
        val trailing = DisplayTranslation("trailing", trailingStart, trailingEnd, "// 行尾译文", "",
            source.substring(trailingStart, trailingEnd))
        val block = item(source, "/*", "*/", "/* 完整的\n 译文 */")
        display.render(listOf(trailing, block))
        assertEquals(2, owned().size)
        for (fold in owned()) {
            assertFalse(fold is CustomFoldRegion)
            val expected = listOf(trailing, block).single { it.id == fold.getUserData(TRANSLATED_COMMENT_ID) }
            assertEquals(expected.startOffset, fold.startOffset)
            assertEquals(expected.endOffset, fold.endOffset)
            assertFalse(fold.placeholderText.contains('\n'))
        }
        assertFalse(editor.foldingModel.isOffsetCollapsed(source.indexOf("value")))
        assertFalse(editor.foldingModel.isOffsetCollapsed(source.indexOf("int")))
        assertEquals(source, editor.document.text)
    }

    /** An explicit reveal survives new snapshots; a later explicit toggle can collapse from inside source. */
    fun testRevealIsStickyAndExplicitToggleCanRestoreFromInteriorCaret() {
        val source = "// Original comment\nvalue\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val item = DisplayTranslation("line", 0, source.indexOf('\n'), "// 中文注释", "", source.substringBefore('\n'))
        val display = TranslationReplacements(editor, testRootDisposable)
        display.render(listOf(item))
        assertTrue(display.toggle(item.id))
        assertTrue(owned().isEmpty())
        editor.caretModel.moveToOffset(6)
        display.render(listOf(item))
        assertTrue(owned().isEmpty())
        assertTrue(display.toggle(item.id))
        assertEquals(1, owned().size)
        assertEquals(0, editor.caretModel.offset)
        assertFalse(display.toggle("missing"))
        assertEquals(source, editor.document.text)
    }

    /** Background rendering preserves both interior editing carets and selected original comments. */
    fun testInteriorCaretAndSelectionProtectOriginalUntilSafe() {
        val source = "// Original comment\nvalue\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val item = DisplayTranslation("line", 0, source.indexOf('\n'), "// 中文注释", "", source.substringBefore('\n'))
        val display = TranslationReplacements(editor, testRootDisposable)
        editor.caretModel.moveToOffset(6)
        display.render(listOf(item))
        assertTrue(owned().isEmpty())
        assertEquals(6, editor.caretModel.offset)
        editor.caretModel.moveToOffset(source.indexOf("value"))
        editor.selectionModel.setSelection(3, 10)
        display.render(listOf(item))
        assertTrue(owned().isEmpty())
        assertFalse(display.toggle(item.id))
        assertEquals(3, editor.selectionModel.selectionStart)
        assertEquals(10, editor.selectionModel.selectionEnd)
        editor.selectionModel.removeSelection()
        val secondary = editor.caretModel.addCaret(editor.offsetToVisualPosition(6))
        assertNotNull(secondary)
        display.render(listOf(item))
        assertTrue("Every caret must protect its original source", owned().isEmpty())
        editor.caretModel.removeCaret(secondary!!)
        display.render(listOf(item))
        assertEquals(1, owned().size)
    }

    /** Changing source invalidates stale translations but does not erase the user's editing choice. */
    fun testSourceValidationAndEditingChoiceSurviveChangedCommentIdentifier() {
        val source = "// Original comment\nvalue\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val original = source.substringBefore('\n')
        val item = DisplayTranslation("old", 0, original.length, "// 中文注释", "", original)
        val display = TranslationReplacements(editor, testRootDisposable)
        display.render(listOf(item))
        assertTrue(display.toggle(item.id))
        WriteCommandAction.runWriteCommandAction(project) { editor.document.insertString(3, "Changed ") }
        display.render(listOf(item))
        assertTrue(owned().isEmpty())
        display.render(emptyList())
        val changed = editor.document.text.substringBefore('\n')
        val fresh = item.copy(id = "new", endOffset = changed.length, originalText = changed)
        display.render(listOf(fresh))
        assertTrue("A rescan must not hide source that the user is editing", owned().isEmpty())
        assertTrue(display.toggle(fresh.id))
        assertEquals(1, owned().size)
        assertEquals("// Changed Original comment\nvalue\n", editor.document.text)
    }

    /** Custom translation folds coexist with native doc folds, which remain owned by the editor. */
    fun testNativeOrdinaryDocumentationFoldSurvivesReplacementAndClear() {
        val source = "/**\n * Original documentation.\n */\nclass Example {}\n"
        myFixture.configureByText("Example.java", source)
        val editor = myFixture.editor
        editor.caretModel.moveToOffset(source.indexOf("class"))
        val item = item(source, "/**", "*/", "/**\n * 文档译文。\n */")
        var native: FoldRegion? = null
        editor.foldingModel.runBatchFoldingOperation {
            native = editor.foldingModel.addFoldRegion(item.startOffset, item.endOffset, "native documentation")
        }
        assertNotNull(native)
        val display = TranslationReplacements(editor, testRootDisposable)
        display.render(listOf(item))
        assertEquals(1, owned().size)
        assertTrue(owned().single() is CustomFoldRegion)
        assertTrue(native!!.isValid)
        display.clear()
        assertTrue(native!!.isValid)
        assertTrue(editor.foldingModel.allFoldRegions.any { it === native })
        assertEquals(source, editor.document.text)
    }

    /** Documentation rendering is disabled only in this editor and its effective setting is restored. */
    fun testRenderedDocumentationSettingIsTemporarilySuspendedAndRestored() {
        val source = "/** Original documentation. */\nclass Example {}\n"
        myFixture.configureByText("Example.java", source)
        val editor = myFixture.editor
        DocRenderManager.setDocRenderingEnabled(editor, true)
        assertTrue(DocRenderManager.isDocRenderingEnabled(editor))
        val display = TranslationReplacements(editor, testRootDisposable)
        display.render(listOf(item(source, "/**", "*/", "/** 文档译文。 */")))
        assertFalse(DocRenderManager.isDocRenderingEnabled(editor))
        display.clear()
        assertTrue(DocRenderManager.isDocRenderingEnabled(editor))
        display.render(listOf(item(source, "/**", "*/", "/** 文档译文。 */")))
        assertFalse(DocRenderManager.isDocRenderingEnabled(editor))
        display.render(emptyList())
        assertTrue("Hiding translations also restores native rendered documentation", DocRenderManager.isDocRenderingEnabled(editor))
        DocRenderManager.setDocRenderingEnabled(editor, null)
    }

    /** Translation remains inside an enclosing native code fold instead of leaking over collapsed code. */
    fun testOuterCodeFoldHidesAndRestoresReplacement() {
        val source = "class Example {\n    // Original comment\n    int value;\n}\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val start = source.indexOf("//")
        val end = source.indexOf('\n', start)
        val display = TranslationReplacements(editor, testRootDisposable)
        display.render(listOf(DisplayTranslation("inner", start, end, "// 中文注释", "    ", source.substring(start, end))))
        val translated = owned().single() as CustomFoldRegion
        assertNotNull(translated.location)
        var outer: FoldRegion? = null
        editor.foldingModel.runBatchFoldingOperation {
            outer = editor.foldingModel.addFoldRegion(source.indexOf('{'), source.indexOf('}') + 1, "{...}")
            assertNotNull(outer)
            outer!!.isExpanded = false
        }
        assertNull(translated.location)
        editor.foldingModel.runBatchFoldingOperation { outer!!.isExpanded = true }
        assertNotNull(translated.location)
        assertEquals(source, editor.document.text)
    }

    private fun item(source: String, opening: String, closing: String, text: String): DisplayTranslation {
        val start = source.indexOf(opening)
        val end = source.indexOf(closing, start) + closing.length
        val lineStart = source.lastIndexOf('\n', start - 1) + 1
        val indent = source.substring(lineStart, start).takeWhile { it == ' ' || it == '\t' }
        return DisplayTranslation("$start:$end", start, end, text, indent, source.substring(start, end))
    }

    private fun owned(): List<FoldRegion> = myFixture.editor.foldingModel.allFoldRegions
        .filter { it.getUserData(TRANSLATED_COMMENT_ID) != null }
}
