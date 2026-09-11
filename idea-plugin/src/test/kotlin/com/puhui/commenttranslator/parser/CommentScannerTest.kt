package com.puhui.commenttranslator.parser

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.progress.EmptyProgressIndicator
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.junit.Assert.assertThrows

/** Uses the installed Java, Kotlin, XML and HTML parsers rather than mocked comment ranges. */
class CommentScannerTest : BasePlatformTestCase() {
    fun testJavaKindsAndExactOffsets() {
        val source = "class Demo {\n  // First line.\n  // Second line.\n  int x = 1; // Trailing.\n  /**\n   * Description.\n   * @param userId The identifier.\n   */\n  void load(String userId) {}\n}\n"
        val blocks = scan("Demo.java", source)
        assertEquals(3, blocks.size)
        assertEquals("First line.\nSecond line.", blocks[0].text)
        assertEquals("  ", blocks[0].indent)
        assertEquals("Trailing.", blocks[1].text)
        assertTrue(blocks[2].text.contains("@param userId The identifier."))
        assertTrue(blocks.all { it.languageId == "java" && source.substring(it.startOffset, it.endOffset) == it.rawText })
    }

    fun testJavaCommentLookalikesInsideStringsAndTextBlocksAreIgnored() {
        val source = "class Demo { String a = \"// fake\"; String b = \"/* fake */\"; String c = \"\"\"\n<!-- fake -->\n/* also fake */\n\"\"\"; /* Actual. */ }"
        val blocks = scan("Demo.java", source)
        assertEquals(listOf("Actual."), blocks.map { it.text })
    }

    fun testCommentsDoNotMergeAcrossCodeBlankLinesOrIndentChanges() {
        val source = "// A.\nclass Demo {}\n// B.\n\n// C.\n  // D.\n"
        assertEquals(listOf("A.", "B.", "C.", "D."), scan("Demo.java", source).map { it.text })
    }

    fun testTrailingCommentsAndInlineBlocksStaySeparate() {
        val source = "class Demo {\n  int a; // First.\n  // Second.\n  int b = /* Before value. */ 1 /* After value. */;\n}\n"
        val blocks = scan("Demo.java", source)
        assertEquals(listOf("First.", "Second.", "Before value.", "After value."), blocks.map { it.text })
        assertTrue(blocks.all { it.indent == "  " })
    }

    fun testAdjacentBlocksAreNeverMerged() {
        assertEquals(listOf("A.", "B."), scan("Demo.java", "/* A. *//* B. */ class Demo {}").map { it.text })
    }

    fun testEmptyCommentShellsDoNotCreateTranslationRequests() {
        assertEmpty(scan("Demo.java", "//\n/**/\n/** */\n/* */\nclass Demo {}"))
    }

    fun testKDocAndKotlinNestedCommentsHaveOneRangeEach() {
        val source = "/**\n * Load a user.\n * @param userId The identifier.\n */\nfun load(userId: String) {\n  val text = \"// not a comment\"\n  /* Outer /* Nested */ end. */\n}\n"
        val blocks = scan("demo.kt", source)
        assertEquals(2, blocks.size)
        assertEquals("kotlin", blocks[0].languageId)
        assertTrue(blocks[0].text.contains("@param userId"))
        assertEquals("/* Outer /* Nested */ end. */", blocks[1].rawText)
        assertEquals("Outer /* Nested */ end.", blocks[1].text)
    }

    fun testXmlAttributesAndCDataDoNotProduceComments() {
        val source = "<root title=\"&lt;!-- attribute --&gt;\"><![CDATA[<!-- not a comment -->]]><!-- Actual. --></root>"
        val blocks = scan("demo.xml", source)
        assertEquals(listOf("Actual."), blocks.map { it.text })
        assertEquals("<!-- Actual. -->", blocks.single().rawText)
        assertEquals("xml", blocks.single().languageId)
    }

    fun testMultilineXmlCommentIsNotSplitIntoLexerFragments() {
        val source = "<root>\n  <!--\n    First.\n    Second.\n  -->\n</root>"
        val blocks = scan("demo.xml", source)
        assertEquals(1, blocks.size)
        assertEquals("First.\nSecond.", blocks.single().text)
        assertEquals("  ", blocks.single().indent)
        assertEquals(source.substring(blocks.single().startOffset, blocks.single().endOffset), blocks.single().rawText)
    }

    fun testHtmlCommentsAndScriptStringsAreDistinguished() {
        val source = "<!doctype html><html><body><!-- Actual. --><script>const example = '<!-- string -->'; // Embedded JS.\n</script><style>/* Embedded CSS. */</style></body></html>"
        val blocks = scan("demo.html", source)
        assertEquals(listOf("Actual."), blocks.map { it.text })
        assertEquals("html", blocks.single().languageId)
    }

    fun testXmlDerivedFileTypesKeepXmlComments() {
        assertEquals(listOf("Actual."), scan("demo.xsl", "<stylesheet><!-- Actual. --></stylesheet>").map { it.text })
    }

    fun testSingleLineJavadocKeepsOuterIndentSeparate() {
        val source = "class Demo {\n    /** A compact description. */\n    void load() {}\n}"
        val block = scan("Demo.java", source).single()
        assertEquals("    ", block.indent)
        assertEquals("A compact description.", block.text)
        assertEquals("/** 一段说明。 */", CommentFormatter.format(block, "一段说明。"))
    }

    fun testExcludedMarkdownAndPythonFilesReturnNoComments() {
        assertEmpty(scan("demo.md", "# Title\n<!-- Markdown comment -->\n// not source\n"))
        assertEmpty(scan("demo.py", "# Python comment\nvalue = '// string'\n"))
    }

    fun testUnicodeUsesUtf16SourceOffsetsAndStableIds() {
        val source = "class Demo { String emoji = \"😀\"; /* Actual. */ }"
        val first = scan("Demo.java", source).single()
        val second = scan("Demo.java", source).single()
        assertEquals(source.indexOf("/*"), first.startOffset)
        assertEquals(source.indexOf("*/") + 2, first.endOffset)
        assertEquals(first.id, second.id)
        val changed = scan("Demo.java", source.replace("Actual", "Edited")).single()
        assertFalse(first.id == changed.id)
    }

    fun testLargeSiblingListsDoNotRequireARecursivePsiVisitor() {
        val source = (1..1200).joinToString("\n") { "int value$it; // Description $it." }
        val blocks = scan("Demo.java", "class Demo {\n$source\n}")
        assertEquals(1200, blocks.size)
        assertEquals(1200, blocks.map { it.id }.toSet().size)
    }

    fun testLongAdjacentLineGroupIsBuiltOnceWithAnExactRange() {
        val source = (1..1200).joinToString("\n") { "  // Description $it." } + "\nclass Demo {}"
        val block = scan("Demo.java", source).single()
        assertEquals(1200, block.text.lines().size)
        assertEquals(source.substring(block.startOffset, block.endOffset), block.rawText)
        assertEquals("  ", block.indent)
    }

    fun testLongSingleLineRetainsSeparateInlineCommentRanges() {
        val source = "class Demo { int x = " + (1..500).joinToString(" + ") { "1 /* Value $it. */" } + "; }"
        assertEquals(500, scan("Demo.java", source).size)
    }

    fun testCanceledReadDoesNotContinueScanning() {
        val file = myFixture.configureByText("Demo.java", "// Description.\nclass Demo {}")
        val indicator = EmptyProgressIndicator()
        assertThrows(ProcessCanceledException::class.java) {
            ProgressManager.getInstance().runProcess(Runnable {
                ReadAction.compute<List<CommentBlock>, RuntimeException> {
                    // runProcess starts the indicator and resets an earlier cancellation.
                    // Cancel the active operation immediately before entering our scanner.
                    indicator.cancel()
                    assertTrue(indicator.isCanceled)
                    CommentScanner.scan(file)
                }
            }, indicator)
        }
    }

    private fun scan(name: String, source: String): List<CommentBlock> {
        val file = myFixture.configureByText(name, source)
        return ReadAction.compute<List<CommentBlock>, RuntimeException> { CommentScanner.scan(file) }
    }
}
