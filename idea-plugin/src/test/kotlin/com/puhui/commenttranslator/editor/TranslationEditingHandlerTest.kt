package com.puhui.commenttranslator.editor

import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Caret
import com.intellij.openapi.editor.CustomFoldRegion
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.FoldRegion
import com.intellij.openapi.editor.actionSystem.EditorActionHandler
import com.intellij.openapi.editor.actions.BackspaceAction
import com.intellij.openapi.editor.actions.DeleteAction
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Exercises editing guards against real editor folds and the native character deletion handlers. */
class TranslationEditingHandlerTest : BasePlatformTestCase() {
    /** Folding and editor action execution require the event dispatch thread. */
    override fun runInDispatchThread(): Boolean = true

    /** Forward delete first reveals a custom comment, then delegates normal single-character deletion. */
    fun testDeleteAtCustomFoldStartRevealsBeforeDeleting() {
        val source = "/* Original\n * comment.\n */\nvalue\n"
        val item = prepare(source, 0, source.indexOf("*/") + 2, 0)
        assertTrue(owned().single() is CustomFoldRegion)
        val original = RecordingHandler(DeleteAction().handler)
        val guard = TranslationDeleteHandler(original)
        val stamp = myFixture.editor.document.modificationStamp

        execute(guard)

        assertRevealedWithoutEdit(source, 0, original)
        assertEquals(stamp, myFixture.editor.document.modificationStamp)
        execute(guard)
        assertEquals(1, original.calls)
        assertEquals(source.removeRange(item.startOffset, item.startOffset + 1), myFixture.editor.document.text)
    }

    /** Backspace at a custom fold's end cannot remove its hidden document range on the first press. */
    fun testBackspaceAtCustomFoldEndRevealsBeforeDeleting() {
        val source = "/* Original\n * comment.\n */\nvalue\n"
        val end = source.indexOf("*/") + 2
        prepare(source, 0, end, end)
        assertTrue(owned().single() is CustomFoldRegion)
        val original = RecordingHandler(BackspaceAction().handler)
        val guard = TranslationBackspaceHandler(original)

        execute(guard)

        assertRevealedWithoutEdit(source, end, original)
        execute(guard)
        assertEquals(1, original.calls)
        assertEquals(source.removeRange(end - 1, end), myFixture.editor.document.text)
        assertEquals(end - 1, myFixture.editor.caretModel.offset)
    }

    /** Empty-selection cut must reveal before its delegate can calculate an entire folded visual line. */
    fun testCutAtCustomFoldStartRevealsWithoutCallingDestructiveDelegate() {
        val source = "/* Original\n * comment.\n */\nvalue\n"
        prepare(source, 0, source.indexOf("*/") + 2, 0)
        val original = RecordingHandler()

        execute(TranslationCutHandler(original))

        assertRevealedWithoutEdit(source, 0, original)
    }

    /** Delete-line likewise reveals the source before running any line deletion. */
    fun testDeleteLineAtCustomFoldEndRevealsWithoutCallingDelegate() {
        val source = "/* Original\n * comment.\n */\nvalue\n"
        val end = source.indexOf("*/") + 2
        prepare(source, 0, end, end)
        val original = RecordingHandler()

        execute(TranslationDeleteLineHandler(original))

        assertRevealedWithoutEdit(source, end, original)
    }

    /** A fold at any caret prevents partial deletion at the other carets during that first action. */
    fun testSecondaryCaretAtTranslationProtectsAllCaretsAtomically() {
        val source = "// Original comment.\nalpha\n"
        val codeOffset = source.indexOf("alpha")
        prepare(source, 0, source.indexOf('\n'), codeOffset)
        val editor = myFixture.editor
        assertNotNull(editor.caretModel.addCaret(editor.offsetToVisualPosition(0)))
        val offsets = editor.caretModel.allCarets.map { it.offset }.sorted()
        val original = RecordingHandler(DeleteAction().handler)
        val guard = TranslationDeleteHandler(original)

        execute(guard)

        assertEquals(0, original.calls)
        assertEquals(source, editor.document.text)
        assertEquals(offsets, editor.caretModel.allCarets.map { it.offset }.sorted())
        assertTrue(owned().isEmpty())
        execute(guard)
        assertEquals(1, original.calls)
        var expected = source
        offsets.sortedDescending().forEach { expected = expected.removeRange(it, it + 1) }
        assertEquals(expected, editor.document.text)
    }

    /** An editor without translation-owned folds retains native editing behaviour. */
    fun testNoOwnedFoldDelegatesNormally() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "abc\n")
        val editor = myFixture.editor
        editor.caretModel.moveToOffset(1)
        val original = RecordingHandler(DeleteAction().handler)

        execute(TranslationDeleteHandler(original))

        assertEquals(1, original.calls)
        assertEquals("ac\n", editor.document.text)
        assertEquals(1, editor.caretModel.offset)
        assertTrue(owned().isEmpty())
    }

    /** Ordinary inline placeholders receive the same reveal-first guard without affecting neighbouring code. */
    fun testInlineFoldWithExplicitCaretRevealsBeforeDeleting() {
        val source = "int value = /* Original comment. */ 1;\n"
        val start = source.indexOf("/*")
        prepare(source, start, source.indexOf("*/") + 2, start)
        assertFalse(owned().single() is CustomFoldRegion)
        val original = RecordingHandler(DeleteAction().handler)
        val guard = TranslationDeleteHandler(original)
        val caret = myFixture.editor.caretModel.primaryCaret

        execute(guard, caret)

        assertRevealedWithoutEdit(source, start, original)
        execute(guard, caret)
        assertEquals(1, original.calls)
        assertEquals(source.removeRange(start, start + 1), myFixture.editor.document.text)
        assertSame(caret, original.lastCaret)
    }

    /** A selection crossing a translated fold is revealed without changing its bounds or deleting any source. */
    fun testSelectionIntersectingFoldRevealsBeforeDestructiveAction() {
        val source = "// Original comment.\nalpha\n"
        val end = source.indexOf('\n')
        prepare(source, 0, end, 0)
        val editor = myFixture.editor
        editor.selectionModel.setSelection(0, end + 2)
        val caretOffset = editor.caretModel.offset
        val original = RecordingHandler()

        execute(TranslationDeleteHandler(original))

        assertRevealedWithoutEdit(source, caretOffset, original)
        assertEquals(0, editor.selectionModel.selectionStart)
        assertEquals(end + 2, editor.selectionModel.selectionEnd)
    }

    /** Programmatic editor actions may omit the context just like the native handler API permits. */
    fun testMissingDataContextDelegatesNormally() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "abc\n")
        myFixture.editor.caretModel.moveToOffset(1)
        val original = RecordingHandler(DeleteAction().handler)
        WriteCommandAction.runWriteCommandAction(project) {
            TranslationDeleteHandler(original).execute(myFixture.editor, null, null)
        }
        assertEquals(1, original.calls)
        assertEquals("ac\n", myFixture.editor.document.text)
    }

    private fun prepare(source: String, start: Int, end: Int, caretOffset: Int): DisplayTranslation {
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        editor.caretModel.moveToOffset(caretOffset)
        val item = DisplayTranslation("guard-comment", start, end, "/* 中文译文。 */", "", source.substring(start, end))
        TranslationReplacements(editor, testRootDisposable).render(listOf(item))
        assertEquals(1, owned().size)
        return item
    }

    private fun execute(handler: EditorActionHandler, caret: Caret? = null) {
        WriteCommandAction.runWriteCommandAction(project) {
            handler.execute(myFixture.editor, caret, DataContext.EMPTY_CONTEXT)
        }
    }

    private fun assertRevealedWithoutEdit(source: String, caretOffset: Int, original: RecordingHandler) {
        assertEquals(0, original.calls)
        assertEquals(source, myFixture.editor.document.text)
        assertEquals(caretOffset, myFixture.editor.caretModel.offset)
        assertTrue(owned().isEmpty())
    }

    private fun owned(): List<FoldRegion> = myFixture.editor.foldingModel.allFoldRegions
        .filter { it.getUserData(TRANSLATED_COMMENT_ID) != null }

    private class RecordingHandler(private val delegate: EditorActionHandler? = null) : EditorActionHandler(false) {
        var calls = 0
        var lastCaret: Caret? = null

        override fun doExecute(editor: Editor, caret: Caret?, dataContext: DataContext?) {
            calls++
            lastCaret = caret
            delegate?.execute(editor, caret, dataContext)
        }
    }
}
