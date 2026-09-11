package com.puhui.commenttranslator

import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/** Checks controller source identity and passive menu state without starting translation workers or HTTP requests. */
class TranslationControllerPlatformTest : BasePlatformTestCase() {
    /** Session documents and menu state are accessed on the UI thread, matching production actions. */
    override fun runInDispatchThread(): Boolean = true

    /** Distinct in-memory sources can share a URL while owning different documents and translation sessions. */
    fun testSameNamedLightSourcesKeepSeparateSessionsAndDocuments() {
        val controller = controller()
        val first = LightVirtualFile("Example.java", "// First source.\nclass First {}")
        val second = LightVirtualFile("Example.java", "// Second source.\nclass Second {}")
        assertEquals(first.url, second.url)
        assertFalse(first == second)

        val firstSession = requireNotNull(session(controller, first))
        val secondSession = requireNotNull(session(controller, second))

        assertNotSame(firstSession, secondSession)
        assertSame(firstSession, session(controller, first))
        assertSame(secondSession, session(controller, second))
        val firstDocument = document(firstSession)
        val secondDocument = document(secondSession)
        assertNotSame(firstDocument, secondDocument)
        assertSame(FileDocumentManager.getInstance().getDocument(first), firstDocument)
        assertSame(FileDocumentManager.getInstance().getDocument(second), secondDocument)
        assertEquals("// First source.\nclass First {}", firstDocument.text)
        assertEquals("// Second source.\nclass Second {}", secondDocument.text)
    }

    /** Inspecting an untranslated source menu reports useful availability without creating a translation session. */
    fun testMenuStateDoesNotCreateSessionsOrPretendTranslationsAreReady() {
        val controller = controller()
        val source = LightVirtualFile("Example.java", "// Original comment.\nclass Example {}")

        val state = controller.actionState(TranslationActionTarget(source, null, null))

        assertTrue(state.supported)
        assertFalse(state.running)
        assertFalse(state.hasTranslations)
        assertFalse(state.hasCurrentTranslation)
        assertTrue(state.visible)
        val sessions = TranslationController::class.java.getDeclaredField("sessions").apply { isAccessible = true }
        assertTrue((sessions.get(controller) as Map<*, *>).isEmpty())
    }

    /** Unsupported files disable source actions and never acquire a translation session. */
    fun testUnsupportedMenuTargetsRemainUnavailable() {
        val controller = controller()
        for (name in listOf("README.md", "Example.class", "notes.txt")) {
            val file = LightVirtualFile(name, "Original content.")
            assertEquals(TranslationActionState(), controller.actionState(TranslationActionTarget(file, null, null)))
            assertNull(session(controller, file))
        }
    }

    /** Private reader snapshots cannot enter scanning, even when their name still has a supported source extension. */
    fun testTranslatedReaderSnapshotIsExcludedFromSessionCreation() {
        val controller = controller()
        val original = LightVirtualFile("Example.java", "// Original comment.\nclass Example {}")
        val reader = LightVirtualFile("Snapshot.java", "// 已翻译的注释。\nclass Example {}")
        val keyField = Class.forName("com.puhui.commenttranslator.TranslationControllerKt")
            .getDeclaredField("READER_SOURCE").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val readerSource = keyField.get(null) as Key<VirtualFile>
        reader.putUserData(readerSource, original)

        assertNotNull(session(controller, original))
        assertTrue(isSupportedTranslationSource(reader))
        assertNull(session(controller, reader))
        // Reader menu actions intentionally refer back to the original file rather than translating the snapshot.
        assertEquals(controller.actionState(TranslationActionTarget(original, null, null)),
            controller.actionState(TranslationActionTarget(reader, null, null)))
    }

    private fun controller(): TranslationController = TranslationController(project).also {
        Disposer.register(testRootDisposable, it)
    }

    // Session acquisition is isolated from start()/request() so these checks never rely on configured credentials.
    private fun session(controller: TranslationController, file: VirtualFile): Any? =
        TranslationController::class.java.getDeclaredMethod("session", VirtualFile::class.java)
            .apply { isAccessible = true }.invoke(controller, file)

    private fun document(session: Any): Document = session.javaClass.getDeclaredField("document")
        .apply { isAccessible = true }.get(session) as Document
}
