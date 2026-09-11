package com.puhui.commenttranslator

import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.Presentation
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.CustomFoldRegion
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.FoldRegion
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseEventArea
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.puhui.commenttranslator.editor.DisplayTranslation
import com.puhui.commenttranslator.editor.TranslationReplacements
import java.awt.event.MouseEvent

/** Checks menu targeting against real editor documents and translated folding regions. */
class TranslationActionTargetTest : BasePlatformTestCase() {
    /** Editor creation, caret movement, and folding require the event dispatch thread. */
    override fun runInDispatchThread(): Boolean = true

    /** A popup over a translated comment uses its source range while the old caret stays elsewhere. */
    fun testRightClickOnTranslatedFoldTargetsCommentWithoutMovingCaret() {
        val source = "    /** Original documentation. */\nclass Example {}\n"
        myFixture.configureByText(PlainTextFileType.INSTANCE, source)
        val editor = myFixture.editor
        val caret = source.indexOf("Example")
        editor.caretModel.moveToOffset(caret)
        val start = source.indexOf("/**")
        val end = source.indexOf("*/") + 2
        TranslationReplacements(editor, testRootDisposable).render(listOf(
            DisplayTranslation("popup-doc", start, end, "/** 中文文档。 */", "    ", source.substring(start, end)),
        ))
        val fold = editor.foldingModel.allFoldRegions.single { it is CustomFoldRegion }
        val stamp = editor.document.modificationStamp

        // The renderer has no direct mapping from a translated glyph to an original character.
        // A deliberately different logical position ensures the fold itself determines the target.
        TranslationActionTarget.recordPopup(mouse(editor, caret, fold = fold))
        val target = TranslationActionTarget.from(action(editor))

        assertSame(editor, target.editor)
        assertSame(myFixture.file.virtualFile, target.file)
        assertEquals(fold.startOffset, target.offset)
        assertEquals(caret, editor.caretModel.offset)
        assertTrue(fold.isValid)
        assertFalse(fold.isExpanded)
        assertEquals(stamp, editor.document.modificationStamp)
        assertEquals(source, editor.document.text)
    }

    /** A context-menu action belongs to its supplied editor, even when another file is selected. */
    fun testEventEditorAndItsDocumentTakePriorityOverUnrelatedFileContext() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "selected editor\n")
        val selectedEditor = myFixture.editor
        val selectedFile = myFixture.file.virtualFile
        val otherFile = myFixture.addFileToProject("context.txt", "// Context comment\nother editor\n").virtualFile
        val otherDocument = FileDocumentManager.getInstance().getDocument(otherFile)!!
        val contextEditor = EditorFactory.getInstance().createEditor(otherDocument, project)
        try {
            selectedEditor.caretModel.moveToOffset(2)
            contextEditor.caretModel.moveToOffset(5)

            val target = TranslationActionTarget.from(action(contextEditor, file = selectedFile))

            assertSame(contextEditor, target.editor)
            assertSame(otherFile, target.file)
            assertEquals(5, target.offset)
            assertEquals(2, selectedEditor.caretModel.offset)
        } finally {
            EditorFactory.getInstance().releaseEditor(contextEditor)
        }
    }

    /** A document change invalidates a stored popup offset before an action can reuse it. */
    fun testChangedDocumentFallsBackToCurrentCaretInsteadOfStalePopup() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "// Original comment\nvalue\n")
        val editor = myFixture.editor
        editor.caretModel.moveToOffset(editor.document.text.indexOf("value"))
        TranslationActionTarget.recordPopup(mouse(editor, 3))
        assertEquals(3, TranslationActionTarget.from(action(editor)).offset)

        WriteCommandAction.runWriteCommandAction(project) {
            editor.document.insertString(0, "prefix\n")
        }
        val caret = editor.document.text.indexOf("value")
        editor.caretModel.moveToOffset(caret)

        assertEquals(caret, TranslationActionTarget.from(action(editor)).offset)
    }

    /** Keyboard invocation uses the caret rather than a previously opened right-click menu. */
    fun testKeyboardShortcutDoesNotReusePopupLocation() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "// Comment\nvalue\n")
        val editor = myFixture.editor
        val caret = editor.document.text.indexOf("value")
        editor.caretModel.moveToOffset(caret)
        TranslationActionTarget.recordPopup(mouse(editor, 3))
        assertEquals(3, TranslationActionTarget.from(action(editor)).offset)

        val target = TranslationActionTarget.from(action(editor, place = ActionPlaces.KEYBOARD_SHORTCUT))

        assertEquals(caret, target.offset)
        assertEquals(caret, editor.caretModel.offset)
    }

    /** Clicking normally clears the preceding popup location, including for a later keyboard-opened menu. */
    fun testLeftClickClearsStoredPopupLocation() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "// Comment\nvalue\n")
        val editor = myFixture.editor
        val caret = editor.document.text.indexOf("value")
        editor.caretModel.moveToOffset(caret)
        TranslationActionTarget.recordPopup(mouse(editor, 3))
        assertEquals(3, TranslationActionTarget.from(action(editor)).offset)

        TranslationActionTarget.recordPopup(mouse(editor, caret, button = MouseEvent.BUTTON1))

        assertEquals(caret, TranslationActionTarget.from(action(editor)).offset)
        assertEquals(caret, editor.caretModel.offset)
    }

    /** macOS control-click is a popup trigger even when its physical mouse button is the left button. */
    fun testPlatformPopupTriggerRecordsLocationWithoutRightMouseButton() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "// Comment\nvalue\n")
        val editor = myFixture.editor
        val caret = editor.document.text.indexOf("value")
        editor.caretModel.moveToOffset(caret)

        TranslationActionTarget.recordPopup(mouse(editor, 3, button = MouseEvent.BUTTON1, popupTrigger = true))

        assertEquals(3, TranslationActionTarget.from(action(editor)).offset)
        assertEquals(caret, editor.caretModel.offset)
    }

    /** A file context remains usable when the action does not originate from an editor. */
    fun testFileContextWithoutEditorHasNoInventedCaretPosition() {
        myFixture.configureByText(PlainTextFileType.INSTANCE, "// Comment\n")
        val file = myFixture.file.virtualFile

        val target = TranslationActionTarget.from(action(null, file, ActionPlaces.PROJECT_VIEW_POPUP))

        assertSame(file, target.file)
        assertNull(target.editor)
        assertNull(target.offset)
    }

    private fun action(
        editor: Editor?,
        file: VirtualFile? = null,
        place: String = ActionPlaces.EDITOR_POPUP,
    ): AnActionEvent {
        val context = SimpleDataContext.builder().add(CommonDataKeys.PROJECT, project)
        if (editor != null) context.add(CommonDataKeys.EDITOR, editor)
        if (file != null) context.add(CommonDataKeys.VIRTUAL_FILE, file)
        return AnActionEvent.createFromDataContext(place, Presentation(), context.build())
    }

    private fun mouse(
        editor: Editor,
        offset: Int,
        fold: FoldRegion? = null,
        button: Int = MouseEvent.BUTTON3,
        popupTrigger: Boolean = button == MouseEvent.BUTTON3,
    ): EditorMouseEvent = EditorMouseEvent(
        editor,
        MouseEvent(editor.contentComponent, MouseEvent.MOUSE_PRESSED, 0L, 0, 0, 0, 1, popupTrigger, button),
        EditorMouseEventArea.EDITING_AREA,
        offset,
        editor.offsetToLogicalPosition(offset),
        editor.offsetToVisualPosition(offset),
        true,
        fold,
        null,
        null,
    )
}
