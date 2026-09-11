package com.puhui.commenttranslator

import com.intellij.ide.highlighter.JavaClassFileType
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.vfs.JarFileSystem
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiManager
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.puhui.commenttranslator.parser.CommentScanner
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Exercises supported source storage with the real VFS, documents, and installed language parsers. */
class TranslationSourceFilesTest : BasePlatformTestCase() {
    /** Local VFS refreshes and fixture document access run on the UI thread. */
    override fun runInDispatchThread(): Boolean = true

    /** The existing local source path remains eligible, including read-only files. */
    fun testLocalTextSourceIsEligible() {
        withLocalFile("Example.java", "// Original comment.\nclass Example {}".toByteArray()) { file ->
            assertTrue(file.isInLocalFileSystem)
            assertTrue(isSupportedTranslationSource(file))
            WriteCommandAction.runWriteCommandAction(project) { file.isWritable = false }
            try {
                assertTrue(isSupportedTranslationSource(file))
            } finally {
                WriteCommandAction.runWriteCommandAction(project) { file.isWritable = true }
            }
        }
    }

    /** Maven-style source archives use the exact same normalized source ranges as the editor document. */
    fun testSourceJarCommentsMatchEditorDocumentRanges() {
        val sources = mapOf(
            "demo/Example.java" to "/** Library documentation. */\r\nclass Example {\r\n  String face = \"😀\"; // Retry the request.\r\n}\r\n",
            "demo/example.xml" to "<root>\r\n  <!-- Library configuration. -->\r\n</root>\r\n"
        )
        val archive = ByteArrayOutputStream().also { bytes ->
            ZipOutputStream(bytes).use { zip ->
                for ((name, source) in sources) {
                    zip.putNextEntry(ZipEntry(name))
                    zip.write(source.toByteArray(Charsets.UTF_8))
                    zip.closeEntry()
                }
                zip.putNextEntry(ZipEntry("demo/Example.class"))
                zip.write(byteArrayOf(0xCA.toByte(), 0xFE.toByte(), 0xBA.toByte(), 0xBE.toByte()))
                zip.closeEntry()
            }
        }.toByteArray()
        withLocalFile("library-sources.jar", archive) { localJar ->
            val root = requireNotNull(JarFileSystem.getInstance().getJarRootForLocalFile(localJar))
            assertFalse(isSupportedTranslationSource(root))
            assertFalse(isSupportedTranslationSource(requireNotNull(root.findFileByRelativePath("demo/Example.class"))))
            for ((name, source) in sources) {
                val file = requireNotNull(root.findFileByRelativePath(name))
                assertFalse(file.isInLocalFileSystem)
                assertFalse(file.isWritable)
                assertTrue(isSupportedTranslationSource(file))
                ReadAction.run<RuntimeException> {
                    val document = requireNotNull(FileDocumentManager.getInstance().getDocument(file))
                    val psi = requireNotNull(PsiManager.getInstance(project).findFile(file))
                    assertSame(document, PsiDocumentManager.getInstance(project).getDocument(psi))
                    assertEquals(source.replace("\r\n", "\n"), document.text)
                    assertEquals(document.text, psi.text)
                    val blocks = CommentScanner.scan(psi)
                    assertEquals(if (name.endsWith(".java")) 2 else 1, blocks.size)
                    for (block in blocks) {
                        assertEquals(block.rawText, document.text.substring(block.startOffset, block.endOffset))
                    }
                }
            }
        }
    }

    /** Ordinary in-memory sources need no private demo flag and use the same document/parser path. */
    fun testLightSourcesAreEligibleWithoutPrivateFlags() {
        for (extension in listOf("java", "kt", "kts", "xml", "html", "htm", "xhtml", "xsl")) {
            val type = FileTypeManager.getInstance().getFileTypeByExtension(extension)
            val file = LightVirtualFile("Example.${extension.uppercase(Locale.ROOT)}", type, "// Original comment.")
            assertFalse(file.isInLocalFileSystem)
            assertTrue("Supported extension: $extension", isSupportedTranslationSource(file))
        }
        val file = LightVirtualFile("scratch.java", "// Scratch comment.\nclass Scratch {}")
        ReadAction.run<RuntimeException> {
            val document = requireNotNull(FileDocumentManager.getInstance().getDocument(file))
            val psi = requireNotNull(PsiManager.getInstance(project).findFile(file))
            assertEquals(document.text, psi.text)
            assertEquals("Scratch comment.", CommentScanner.scan(psi).single().text)
        }
    }

    /** Binary mappings cannot become eligible by borrowing a source extension. */
    fun testUnsupportedAndBinaryFilesAreRejected() {
        for (name in listOf("notes.md", "script.py", "readme.txt", "Example.class", "README")) {
            assertFalse(name, isSupportedTranslationSource(LightVirtualFile(name, "// Original comment.")))
        }
        val disguisedBinary = LightVirtualFile("Example.java", JavaClassFileType.INSTANCE, "binary")
        assertTrue(disguisedBinary.fileType.isBinary)
        assertFalse(isSupportedTranslationSource(disguisedBinary))
    }

    /** Invalid files and source-looking directory names are rejected before metadata or content access. */
    fun testDirectoriesAndDeletedFilesAreRejected() {
        withLocalFile("Example.java", "// Original comment.".toByteArray()) { file ->
            val directory = WriteCommandAction.writeCommandAction(project).compute<VirtualFile, RuntimeException> {
                file.parent.createChildDirectory(this, "Folder.java")
            }
            try {
                assertFalse(isSupportedTranslationSource(directory))
            } finally {
                WriteCommandAction.runWriteCommandAction(project) { directory.delete(this) }
            }
            WriteCommandAction.runWriteCommandAction(project) { file.delete(this) }
            assertFalse(file.isValid)
            assertFalse(isSupportedTranslationSource(file))
        }
    }

    private fun withLocalFile(name: String, bytes: ByteArray, action: (VirtualFile) -> Unit) {
        val directory = Files.createTempDirectory("translation-source-")
        val path = directory.resolve(name)
        var file: VirtualFile? = null
        try {
            Files.write(path, bytes)
            file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
            action(file)
        } finally {
            file?.takeIf { it.isValid }?.let { valid ->
                WriteCommandAction.runWriteCommandAction(project) { valid.delete(this) }
            }
            Files.deleteIfExists(path)
            Files.deleteIfExists(directory)
        }
    }
}
