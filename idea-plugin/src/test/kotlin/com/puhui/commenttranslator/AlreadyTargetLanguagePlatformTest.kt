package com.puhui.commenttranslator

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.puhui.commenttranslator.editor.TRANSLATED_COMMENT_ID
import com.puhui.commenttranslator.parser.CommentScanner
import com.puhui.commenttranslator.settings.TranslationSettings

/** Verifies that cached unchanged bodies preserve real editor source and reader formatting. */
class AlreadyTargetLanguagePlatformTest : BasePlatformTestCase() {
    /** Runs source presentation and action state checks on the IDE dispatch thread. */
    override fun runInDispatchThread(): Boolean = true

    /** Already-target results create no duplicate folds/inlays and expose no ineffective translation actions. */
    fun testUnchangedResultsKeepSourceAndMenusUntouchedInBothModes() {
        val source = "class Example {\n\t/**  已是中文的说明。  */\n\tint value; // 中文行尾说明。\n}\n"
        myFixture.configureByText("Example.java", source)
        val blocks = CommentScanner.scan(myFixture.file)
        assertEquals(2, blocks.size)
        val controller = controller()
        val state = results(controller, blocks.associate { it.id to it.text })
        for (mode in listOf("replacement", "inlays")) {
            TranslationSettings.getInstance().update(TranslationSettings.getInstance().state.copy(displayMode = mode))
            render(controller, state)
            assertTrue(ownedFolds().isEmpty())
            assertTrue(myFixture.editor.inlayModel.getBlockElementsInRange(0, source.length).isEmpty())
            val menu = controller.actionState(target(blocks.first().startOffset + 3))
            assertTrue(menu.supported)
            assertFalse(menu.hasTranslations)
            assertFalse(menu.hasCurrentTranslation)
            assertEquals(source, myFixture.editor.document.text)
        }
    }

    /** A newly cached same-language result removes an earlier translation's fold instead of leaving it stale. */
    fun testUnchangedSnapshotRemovesEarlierReplacement() {
        val source = "class Example {\n    /** 已是目标语言。 */\n    int value;\n}\n"
        myFixture.configureByText("Example.java", source)
        myFixture.editor.caretModel.moveToOffset(source.indexOf("value"))
        val block = CommentScanner.scan(myFixture.file).single()
        val controller = controller()
        val state = results(controller, mapOf(block.id to "先前的改写结果。"))
        render(controller, state)
        assertEquals(1, ownedFolds().size)
        results(controller, mapOf(block.id to block.text))
        render(controller, state)
        assertTrue(ownedFolds().isEmpty())
        assertEquals(source, myFixture.editor.document.text)
    }

    /** Mixed-language snapshots replace only actual translations, retaining exact tags, blank lines and indentation elsewhere. */
    fun testReaderLeavesUnchangedDocumentationAndXmlByteForByte() {
        val sources = listOf(
            "Example.java" to "class Example {\n\t/**\n\t *  中文说明。\n\t *\n\t * @see String\n\t */\n\tint value;\n\t// English description.\n\tint other;\n}\n",
            "example.xml" to "<root>\n\t<!--  中文说明。\n\n\t 保留空白与标签 <see name=\"Thing\"/>。  -->\n\t<value/>\n\t<!-- English description. -->\n</root>\n",
        )
        for ((name, source) in sources) {
            myFixture.configureByText(name, source)
            val blocks = CommentScanner.scan(myFixture.file)
            assertEquals(2, blocks.size)
            val changed = blocks.single { it.text == "English description." }
            val unchanged = blocks.single { it !== changed }
            val controller = controller()
            val state = results(controller, blocks.associate { it.id to if (it === changed) "中文译文。" else it.text })
            render(controller, state)
            assertFalse(controller.actionState(target(unchanged.startOffset + 4)).hasCurrentTranslation)
            assertTrue(controller.actionState(target(changed.startOffset + 4)).hasCurrentTranslation)
            val originalFile = myFixture.file.virtualFile
            val originalDocument = myFixture.editor.document
            controller.openReader(target(changed.startOffset))
            val reader = FileEditorManager.getInstance(project).selectedFiles.single()
            assertNotSame(originalFile, reader)
            assertFalse(reader.isWritable)
            assertEquals(source.replace("English description.", "中文译文。"),
                FileDocumentManager.getInstance().getDocument(reader)!!.text)
            assertEquals(source, originalDocument.text)
            FileEditorManager.getInstance(project).closeFile(reader)
        }
    }

    private fun controller(): TranslationController {
        val settings = TranslationSettings.getInstance()
        val previous = settings.state.copy()
        settings.update(previous.copy(automatic = false, displayMode = "replacement"))
        Disposer.register(testRootDisposable) { settings.update(previous) }
        return TranslationController(project).also { Disposer.register(testRootDisposable, it) }
    }

    private fun target(offset: Int) = TranslationActionTarget(myFixture.file.virtualFile, myFixture.editor, offset)

    private fun results(controller: TranslationController, translations: Map<String, String>): Any {
        val state = TranslationController::class.java.getDeclaredMethod("session", VirtualFile::class.java)
            .apply { isAccessible = true }.invoke(controller, myFixture.file.virtualFile)!!
        fun set(name: String, value: Any) { state.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(state, value) }
        set("blocks", CommentScanner.scan(myFixture.file))
        set("translations", translations)
        set("version", myFixture.editor.document.modificationStamp)
        return state
    }

    private fun render(controller: TranslationController, state: Any) {
        TranslationController::class.java.getDeclaredMethod("render", state.javaClass).apply { isAccessible = true }.invoke(controller, state)
    }

    private fun ownedFolds() = myFixture.editor.foldingModel.allFoldRegions.filter { it.getUserData(TRANSLATED_COMMENT_ID) != null }
}
