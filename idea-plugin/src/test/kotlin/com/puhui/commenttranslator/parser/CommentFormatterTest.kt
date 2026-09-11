package com.puhui.commenttranslator.parser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Exercises shell reconstruction independently of an IDE or network provider. */
class CommentFormatterTest {
    @Test fun `single line comment retains its marker`() {
        assertFormat("// Load a profile.", "加载资料。", "// 加载资料。")
    }

    @Test fun `line comment without gap keeps its exact prefix`() {
        assertFormat("//Load a profile.", "加载资料。", "//加载资料。")
    }

    @Test fun `line comments may expand onto more display rows`() {
        assertFormat("// Load a profile.", "加载资料。\n缓存会复用。", "// 加载资料。\n// 缓存会复用。")
    }

    @Test fun `mixed line markers are retained when body lines correspond`() {
        assertFormat("/// Summary.\n//! Warning.\n// Detail.", "概要。\n警告。\n详情。", "/// 概要。\n//! 警告。\n// 详情。")
    }

    @Test fun `source and translation blank lines remain visible`() {
        assertFormat("// First.\n//\n// Second.", "第一。\n第二。", "// 第一。\n//\n// 第二。")
        assertFormat("// First.\n// Second.", "第一。\n\n第二。", "// 第一。\n//\n// 第二。")
    }

    @Test fun `outer space indentation is owned by the renderer`() {
        assertFormat("// First.\n    // Second.", "第一。\n第二。", "// 第一。\n// 第二。", "    ")
    }

    @Test fun `outer tabs and internal code indentation remain distinct`() {
        assertFormat("/**\n\t * Example:\n\t *     call();\n\t */", "示例：\n调用();", "/**\n * 示例：\n *     调用();\n */", "\t")
    }

    @Test fun `compact block comment retains opening and closing gaps`() {
        assertFormat("/* Description. */", "说明。", "/* 说明。 */")
        assertFormat("/*Description.*/", "说明。", "/*说明。*/")
    }

    @Test fun `compact documentation comment is not expanded unnecessarily`() {
        assertFormat("/** Description. */", "说明。", "/** 说明。 */")
    }

    @Test fun `compact documentation comment can display multiple lines`() {
        assertFormat("/** Description. */", "说明。\n第二行。", "/** 说明。\n * 第二行。 */")
    }

    @Test fun `documentation tags and identifiers are kept verbatim`() {
        assertFormat("/**\n * Description.\n *\n * @param userId The identifier.\n * @return The user.\n */",
            "说明。\n\n@param userId 标识符。\n@return 用户。",
            "/**\n * 说明。\n *\n * @param userId 标识符。\n * @return 用户。\n */")
    }

    @Test fun `custom and inline documentation tags survive reconstruction`() {
        assertFormat("/** See {@link User} and {@code value}. @custom demo */",
            "参见 {@link User} 和 {@code value}。 @custom 示例",
            "/** 参见 {@link User} 和 {@code value}。 @custom 示例 */")
    }

    @Test fun `multiline block without stars does not gain stars`() {
        assertFormat("/*\n  First.\n  Second.\n*/", "第一。\n第二。\n第三。", "/*\n  第一。\n  第二。\n  第三。\n*/")
    }

    @Test fun `documentation close on final prose row stays there`() {
        assertFormat("/**\n * Description. */", "说明。", "/**\n * 说明。 */")
    }

    @Test fun `special bang block opener remains unchanged`() {
        assertFormat("/*! Important. */", "重要。", "/*! 重要。 */")
    }

    @Test fun `xml comments keep angle delimiters`() {
        assertFormat("<!-- Description. -->", "说明。", "<!-- 说明。 -->")
    }

    @Test fun `multiline xml preserves indentation and accepts extra rows`() {
        assertFormat("<!--\n      First.\n      Second.\n    -->", "第一。\n第二。\n第三。",
            "<!--\n  第一。\n  第二。\n  第三。\n-->", "    ")
    }

    @Test fun `markup in an xml comment body remains plain text`() {
        assertFormat("<!-- Use <cache enabled=\"true\"/>. -->", "使用 <cache enabled=\"true\"/>。", "<!-- 使用 <cache enabled=\"true\"/>。 -->")
    }

    @Test fun `wrapped model replies do not double the shell`() {
        assertFormat("// English.", "// 中文。", "// 中文。")
        assertFormat("/** English. */", "/** 中文。 */", "/** 中文。 */")
        assertFormat("<!-- English. -->", "<!-- 中文。 -->", "<!-- 中文。 -->")
    }

    @Test fun `different comment family in a reply is not silently stripped`() {
        assertFormat("// English.", "<!-- 中文。 -->", "// <!-- 中文。 -->")
    }

    @Test fun `display newlines normalize CRLF and CR`() {
        assertFormat("/**\r\n * First.\r\n * Second.\r\n */", "第一。\r第二。", "/**\n * 第一。\n * 第二。\n */")
    }

    @Test fun `unicode and emoji remain intact`() {
        assertFormat("// Smile 😀.", "欢迎 👨‍👩‍👧‍👦，café。", "// 欢迎 👨‍👩‍👧‍👦，café。")
    }

    @Test fun `unknown shells retain original text`() {
        assertFormat("=begin\nDescription.\n=end", "说明。", "=begin\nDescription.\n=end")
    }

    @Test fun `empty translations retain the original comment`() {
        assertFormat("/** Original. */", "  \n", "/** Original. */")
        assertFormat("/** Original. */", "/** */", "/** Original. */")
    }

    @Test fun `nested block delimiters must survive a translation`() {
        assertFormat("/* Outer /* Inner */ end. */", "外层内容。", "/* Outer /* Inner */ end. */")
        assertFormat("/* Outer /* Inner */ end. */", "外层 /* 内层 */ 结束。", "/* 外层 /* 内层 */ 结束。 */")
    }

    @Test fun `unexpected XML terminators cannot break the restored shell`() {
        assertFormat("<!-- Original. -->", "中途 --> 错误。", "<!-- Original. -->")
    }

    @Test fun `unfinished block comments remain unfinished`() {
        assertFormat("/* Unfinished description.", "尚未完成的说明。", "/* 尚未完成的说明。")
        assertFormat("<!-- Unfinished description.", "尚未完成的说明。", "<!-- 尚未完成的说明。")
    }

    @Test fun `body extraction retains tags and code indentation`() {
        assertEquals("Example:\n    call();\n\n@param id The identifier.",
            CommentSyntax.body("/**\n    * Example:\n    *     call();\n    *\n    * @param id The identifier.\n    */", "   "))
        assertEquals("First.\nSecond.", CommentSyntax.body("// First.\n  // Second.", "  "))
        assertEquals("", CommentSyntax.body("/**/", ""))
        assertEquals("", CommentSyntax.body("<!-- -->", ""))
        assertNull(CommentSyntax.body("not a comment", ""))
    }

    private fun assertFormat(raw: String, translation: String, expected: String, indent: String = "") {
        val block = CommentBlock("test", 0, raw.length, raw, CommentSyntax.body(raw, indent).orEmpty(), "java", indent)
        assertEquals(expected, CommentFormatter.format(block, translation))
        assertEquals(raw, block.rawText)
    }
}
