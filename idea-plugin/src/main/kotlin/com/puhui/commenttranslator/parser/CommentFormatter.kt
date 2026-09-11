package com.puhui.commenttranslator.parser

/** Restores comment delimiters and layout around translated body text. */
object CommentFormatter {
    /**
     * Returns a complete, potentially longer comment for display, without the outer [CommentBlock.indent].
     * Empty translations and unsupported or structurally unsafe shells retain the original comment.
     */
    fun format(block: CommentBlock, translation: String): String {
        val source = CommentSyntax.removeOuterIndent(block.rawText, block.indent)
        val layout = CommentSyntax.parse(source) ?: return source
        if (translation.isBlank()) return source
        val normalized = CommentSyntax.normalizeNewlines(translation)
        val wrapped = CommentSyntax.parse(normalized.trim())
        val body = if (wrapped?.family == layout.family) wrapped.rows.map { it.text }.joinToString("\n") else normalized
        if (body.isBlank()) return source
        // Kotlin permits nested block comments. Their internal delimiters are part of
        // the body and cannot be recovered by inventing a new outer shell.
        if (layout.family == CommentFamily.BLOCK && nestedMarkers(layout.body()) != nestedMarkers(body)) return source
        if (layout.family == CommentFamily.XML && xmlMarkers(layout.body()) != xmlMarkers(body)) return source
        val rendered = renderBody(layout, body.split('\n')).toMutableList()
        if (rendered.isEmpty()) rendered.add("")
        rendered[0] = layout.opening + rendered[0]
        rendered[rendered.lastIndex] += layout.closing
        return (layout.before + rendered + layout.after).joinToString("\n")
    }

    private fun nestedMarkers(text: String): List<String> = Regex("/\\*|\\*/").findAll(text).map { it.value }.toList()

    private fun xmlMarkers(text: String): List<String> = Regex("<!--|-->").findAll(text).map { it.value }.toList()

    private fun renderBody(layout: CommentLayout, translated: List<String>): List<String> {
        val originals = layout.rows.filter { it.text.isNotBlank() }
        val meaningful = translated.filter { it.isNotBlank() }
        if (originals.size != meaningful.size) {
            val commonIndent = originals.minOfOrNull { it.text.takeWhile(::isHorizontalSpace).length } ?: 0
            val indentation = originals.firstOrNull()?.text?.take(commonIndent).orEmpty()
            return translated.mapIndexed { index, line ->
                val prefix = if (index == 0 && layout.opening.isNotEmpty()) layout.rows.firstOrNull()?.prefix.orEmpty() else layout.defaultPrefix
                if (line.isBlank()) prefix.trimEnd() else prefix + retainIndent(line, indentation)
            }
        }

        val rendered = mutableListOf<String>()
        var originalIndex = 0
        var translatedIndex = 0
        while (originalIndex < layout.rows.size || translatedIndex < translated.size) {
            val blanks = mutableListOf<CommentRow>()
            while (originalIndex < layout.rows.size && layout.rows[originalIndex].text.isBlank()) blanks.add(layout.rows[originalIndex++])
            var translatedBlanks = 0
            while (translatedIndex < translated.size && translated[translatedIndex].isBlank()) {
                translatedIndex++
                translatedBlanks++
            }
            repeat(maxOf(blanks.size, translatedBlanks)) { index ->
                rendered.add(blanks.getOrNull(index)?.let { it.prefix + it.text } ?: layout.defaultPrefix.trimEnd())
            }
            val original = layout.rows.getOrNull(originalIndex++)
            val translation = translated.getOrNull(translatedIndex++)
            if (original != null && translation != null) rendered.add(original.prefix + retainIndent(translation, original.text))
        }
        return rendered
    }

    private fun retainIndent(text: String, original: String): String =
        if (text.firstOrNull()?.let(::isHorizontalSpace) == true) text else original.takeWhile(::isHorizontalSpace) + text
}

internal fun isHorizontalSpace(character: Char): Boolean = character == ' ' || character == '\t'

internal enum class CommentFamily { LINE, BLOCK, XML }

internal data class CommentRow(val prefix: String, val text: String)

internal data class CommentLayout(
    val family: CommentFamily,
    val before: List<String>,
    val after: List<String>,
    val opening: String,
    val closing: String,
    val rows: List<CommentRow>,
    val defaultPrefix: String,
) {
    fun body(): String = rows.map { it.text }.joinToString("\n")
}

/** Parsing here only removes the shell of an already lexer/PSI-identified comment. */
internal object CommentSyntax {
    private val LINE = Regex("^([ \\t]*)(//[/!]?)([ \\t]?)(.*)$")
    private val STAR = Regex("^([ \\t]*\\*[ \\t]?)(.*)$")

    fun normalizeNewlines(text: String): String = text.replace("\r\n", "\n").replace('\r', '\n')

    fun removeOuterIndent(rawText: String, indent: String): String = normalizeNewlines(rawText).split('\n')
        .mapIndexed { index, line -> if (index > 0 && indent.isNotEmpty()) line.removePrefix(indent) else line }.joinToString("\n")

    fun body(rawText: String, indent: String): String? {
        val layout = parse(removeOuterIndent(rawText, indent)) ?: return null
        val rows = layout.rows.map { it.text }.dropWhile { it.isBlank() }.dropLastWhile { it.isBlank() }
        val common = rows.filter { it.isNotBlank() }.minOfOrNull { it.takeWhile(::isHorizontalSpace).length } ?: 0
        return rows.joinToString("\n") { if (it.isBlank()) "" else it.drop(common) }
    }

    fun parse(rawText: String): CommentLayout? {
        val lines = normalizeNewlines(rawText).split('\n')
        if (rawText.startsWith("//")) {
            val rows = lines.map { line ->
                val match = LINE.matchEntire(line) ?: return null
                CommentRow(match.groupValues[1] + match.groupValues[2] + match.groupValues[3], match.groupValues[4])
            }
            return CommentLayout(CommentFamily.LINE, emptyList(), emptyList(), "", "", rows,
                rows.firstOrNull { it.text.isNotBlank() }?.prefix ?: rows.first().prefix)
        }

        val opener = when {
            rawText.startsWith("<!--") -> "<!--"
            rawText.startsWith("/*!") -> "/*!"
            rawText.startsWith("/**") && rawText.getOrNull(3) != '/' -> "/**"
            rawText.startsWith("/*") -> "/*"
            else -> return null
        }
        val family = if (opener == "<!--") CommentFamily.XML else CommentFamily.BLOCK
        val closer = if (family == CommentFamily.XML) "-->" else "*/"
        val body = lines.toMutableList()
        val before = mutableListOf<String>()
        val after = mutableListOf<String>()
        var opening = ""
        var closing = ""
        body[0] = body[0].drop(opener.length)
        if (body.size > 1 && body[0].isBlank()) {
            before.add(lines[0])
            body.removeAt(0)
        } else {
            val gap = body[0].takeWhile(::isHorizontalSpace)
            opening = opener + gap
            body[0] = body[0].drop(gap.length)
        }
        val last = body.lastOrNull()
        if (last != null && last.trimEnd().endsWith(closer)) {
            val content = last.trimEnd().dropLast(closer.length)
            if (content.isBlank()) {
                after.add(last)
                body.removeAt(body.lastIndex)
            } else {
                val gap = content.takeLastWhile(::isHorizontalSpace)
                closing = gap + closer
                body[body.lastIndex] = content.dropLast(gap.length)
            }
        }
        if (body.isEmpty() && before.isEmpty() && after.isNotEmpty()) {
            closing = after.removeAt(after.lastIndex)
            body.add("")
        }
        val rows = body.mapIndexed { index, text ->
            val star = if (family == CommentFamily.BLOCK && !(index == 0 && opening.isNotEmpty())) STAR.matchEntire(text) else null
            if (star != null) CommentRow(star.groupValues[1], star.groupValues[2]) else CommentRow("", text)
        }
        val defaultPrefix = rows.firstOrNull { it.prefix.isNotEmpty() && it.text.isNotBlank() }?.prefix
            ?: rows.firstOrNull { it.prefix.isNotEmpty() }?.prefix
            ?: if (family == CommentFamily.BLOCK && opening.isNotEmpty()) " * " else ""
        return CommentLayout(family, before, after, opening, closing, rows, defaultPrefix)
    }
}
