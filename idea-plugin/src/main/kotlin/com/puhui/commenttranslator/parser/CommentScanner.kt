package com.puhui.commenttranslator.parser

import com.intellij.lang.Language
import com.intellij.lang.LanguageParserDefinitions
import com.intellij.openapi.progress.ProgressManager
import com.intellij.psi.PsiComment
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.tree.TokenSet
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.Locale

/** Finds comments using installed PSI and language lexers, never by scanning source strings with comment regexes. */
object CommentScanner {
    /**
     * Scans a valid Java, Kotlin, XML, or HTML file inside the caller's read action.
     * Returned snapshots retain exact source ranges and group only adjacent standalone line comments.
     */
    fun scan(file: PsiFile): List<CommentBlock> {
        ProgressManager.checkCanceled()
        if (!file.isValid) return emptyList()
        val fileLanguageId = languageId(file.language) ?: return emptyList()
        val source = file.text
        if (source.isEmpty()) return emptyList()
        val lines = SourceLines(source)
        val ranges = mutableListOf<CommentRange>()
        val tokens = mutableMapOf<Language, TokenSet>()
        val roots = (listOf(file) + file.viewProvider.allFiles).distinct()
        for (root in roots) {
            if (languageId(root.language) == null || root.textLength != source.length) continue
            val rootTokens = commentTokens(root.language, tokens)
            val stack = ArrayDeque<PsiElement>()
            stack.addLast(root)
            var visited = 0
            while (stack.isNotEmpty()) {
                if (++visited % 256 == 0) ProgressManager.checkCanceled()
                val element = stack.removeLast()
                val type = element.node?.elementType
                val isComment = element is PsiComment || (type != null &&
                    (rootTokens.contains(type) || commentTokens(element.language, tokens).contains(type)))
                if (isComment) {
                    val range = element.textRange
                    addRange(source, range.startOffset, range.endOffset, fileLanguageId, ranges)
                    // Documentation tags and nested comment tokens must not become duplicate requests.
                    continue
                }
                var child = element.lastChild
                while (child != null) {
                    stack.addLast(child)
                    child = child.prevSibling
                }
            }
            collectLexerComments(root, source, fileLanguageId, rootTokens, ranges)
        }

        val sorted = ranges.distinct().sortedWith(compareBy<CommentRange> { it.start }.thenByDescending { it.end })
        val separate = mutableListOf<CommentBlock>()
        var previousEnd = -1
        for (range in sorted) {
            ProgressManager.checkCanceled()
            if (range.start < previousEnd) continue
            previousEnd = range.end
            val rawText = source.substring(range.start, range.end)
            val indent = lines.indentAt(range.start)
            val text = CommentSyntax.body(rawText, indent) ?: continue
            if (text.isBlank()) continue
            separate.add(block(range.start, range.end, rawText, text, fileLanguageId, indent))
        }
        return mergeAdjacent(source, lines, separate)
    }

    private fun collectLexerComments(file: PsiFile, source: String, languageId: String, tokens: TokenSet, ranges: MutableList<CommentRange>) {
        val definition = LanguageParserDefinitions.INSTANCE.forLanguage(file.language) ?: return
        if (tokens.types.isEmpty()) return
        val lexer = definition.createLexer(file.project)
        lexer.start(source)
        var xmlStart: Int? = null
        var xmlEnd = -1
        var visited = 0
        while (true) {
            val type = lexer.tokenType ?: break
            if (++visited % 256 == 0) ProgressManager.checkCanceled()
            val start = lexer.tokenStart
            val end = lexer.tokenEnd
            if (tokens.contains(type)) {
                if (xmlStart != null && start == xmlEnd) {
                    xmlEnd = end
                    if (source.regionMatches(end - 3, "-->", 0, 3)) {
                        addRange(source, xmlStart, end, languageId, ranges)
                        xmlStart = null
                    }
                } else if (source.startsWith("<!--", start)) {
                    xmlStart = start
                    xmlEnd = end
                    if (end - start >= 7 && source.regionMatches(end - 3, "-->", 0, 3)) {
                        addRange(source, start, end, languageId, ranges)
                        xmlStart = null
                    }
                } else {
                    xmlStart = null
                    addRange(source, start, end, languageId, ranges)
                }
            } else xmlStart = null
            lexer.advance()
        }
        if (xmlStart != null && xmlEnd == source.length) addRange(source, xmlStart, xmlEnd, languageId, ranges)
    }

    private fun addRange(source: String, start: Int, end: Int, languageId: String, ranges: MutableList<CommentRange>) {
        if (start < 0 || end <= start || end > source.length) return
        // Token-level XML fragments have no complete shell and are ignored unless
        // combined by the lexer above; their PsiComment parent is captured directly.
        val supportedShell = if (languageId == "html" || languageId == "xml") source.startsWith("<!--", start)
            else source.startsWith("//", start) || source.startsWith("/*", start)
        if (supportedShell) {
            ranges.add(CommentRange(start, end))
        }
    }

    private fun mergeAdjacent(source: String, lines: SourceLines, blocks: List<CommentBlock>): List<CommentBlock> {
        val result = mutableListOf<CommentBlock>()
        val group = mutableListOf<CommentBlock>()
        fun flush() {
            if (group.isEmpty()) return
            if (group.size == 1) result.add(group.single()) else {
                val first = group.first()
                val last = group.last()
                val rawText = source.substring(first.startOffset, last.endOffset)
                val text = CommentSyntax.body(rawText, first.indent)
                if (text == null) result.addAll(group) else result.add(block(first.startOffset, last.endOffset, rawText, text, first.languageId, first.indent))
            }
            group.clear()
        }
        for (current in blocks) {
            ProgressManager.checkCanceled()
            val previous = group.lastOrNull()
            val gap = if (previous == null) 0 else current.startOffset - previous.endOffset
            val merge = previous != null && previous.rawText.startsWith("//") && current.rawText.startsWith("//") &&
                previous.indent == current.indent && lines.isStandalone(previous.startOffset) && lines.isStandalone(current.startOffset) &&
                gap in 1..current.indent.length + 2 && adjacentLineGap(source.substring(previous.endOffset, current.startOffset))
            if (!merge) flush()
            group.add(current)
        }
        flush()
        return result
    }

    private fun adjacentLineGap(text: String): Boolean {
        val afterNewline = when {
            text.startsWith("\r\n") -> text.drop(2)
            text.startsWith('\n') || text.startsWith('\r') -> text.drop(1)
            else -> return false
        }
        return afterNewline.all(::isHorizontalSpace)
    }

    private fun block(start: Int, end: Int, rawText: String, text: String, languageId: String, indent: String): CommentBlock {
        val digest = MessageDigest.getInstance("SHA-256").digest(rawText.toByteArray(Charsets.UTF_8))
            .take(8).joinToString("") { "%02x".format(it) }
        return CommentBlock("$start:$end:$digest", start, end, rawText, text, languageId, indent)
    }

    private fun commentTokens(language: Language, cache: MutableMap<Language, TokenSet>): TokenSet = cache.getOrPut(language) {
        LanguageParserDefinitions.INSTANCE.forLanguage(language)?.commentTokens ?: TokenSet.EMPTY
    }

    private fun languageId(language: Language): String? {
        var current: Language? = language
        val visited = mutableSetOf<Language>()
        while (current != null && visited.add(current)) {
            when (current.id.lowercase(Locale.ROOT)) {
                "java" -> return "java"
                "kotlin" -> return "kotlin"
                "xml", "xsl", "xslt" -> return "xml"
                "html", "xhtml" -> return "html"
            }
            current = current.baseLanguage
        }
        return null
    }

    private data class CommentRange(val start: Int, val end: Int)

    private class SourceLines(private val source: String) {
        private val starts: IntArray
        private val indentEnds: IntArray

        init {
            val positions = mutableListOf(0)
            for (index in source.indices) {
                if (index % 4096 == 0) ProgressManager.checkCanceled()
                if (source[index] == '\n' || (source[index] == '\r' && source.getOrNull(index + 1) != '\n')) positions.add(index + 1)
            }
            starts = positions.toIntArray()
            indentEnds = IntArray(starts.size) { line ->
                var index = starts[line]
                while (index < source.length && isHorizontalSpace(source[index])) {
                    if (index % 4096 == 0) ProgressManager.checkCanceled()
                    index++
                }
                index
            }
        }

        fun indentAt(offset: Int): String {
            val line = lineAt(offset)
            return source.substring(starts[line], minOf(offset, indentEnds[line]))
        }

        fun isStandalone(offset: Int): Boolean = offset == indentEnds[lineAt(offset)]

        private fun lineAt(offset: Int): Int {
            val position = starts.binarySearch(offset)
            return if (position >= 0) position else -position - 2
        }
    }
}
