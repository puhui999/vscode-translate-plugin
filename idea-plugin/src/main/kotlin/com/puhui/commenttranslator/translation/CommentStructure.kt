package com.puhui.commenttranslator.translation

private val PARAMETER_TAGS = setOf("param", "arg", "argument", "property", "prop", "tparam", "typeparam")
private val REFERENCE_TAGS = setOf("throws", "exception", "see", "link", "augments", "extends", "implements", "memberof", "mixes", "mixin", "lends", "requires", "this")
private val NAMED_TYPE_TAGS = setOf("typedef", "callback")
private val RETURN_TYPE_TAGS = setOf("return", "returns", "yield", "yields", "type", "enum", "var")
private val TYPE_EXPRESSION_TAGS = PARAMETER_TAGS + NAMED_TYPE_TAGS + RETURN_TYPE_TAGS + setOf("throws", "exception", "template", "augments", "extends", "implements", "this")
private val INLINE_TAGS = setOf("link", "linkplain", "linkcode", "code", "literal", "value", "inheritdoc")
private val SIMPLE_TYPES = Regex("^(?:any|array|bigint|bool|boolean|byte|callable|char|double|float|int|integer|iterable|long|mixed|never|null|number|object|resource|self|short|static|string|symbol|unknown|void)$", RegexOption.IGNORE_CASE)
private val DOCUMENT_TAG = Regex("^[\\t ]*@([A-Za-z][A-Za-z0-9_-]*)(?=[\\t \\[]|$)([^\\r\\n]*)", RegexOption.MULTILINE)
private val INLINE_TAG = Regex("\\{@([A-Za-z][A-Za-z0-9_-]*)(?=\\s|\\})")
private val MARKUP_TAG = Regex("""</?[A-Za-z][A-Za-z0-9_.:-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*/?>""")

private data class StructureToken(val text: String, val end: Int)

/** Preserves known documentation tags, operands and markup without comparing translated prose. */
fun preservesCommentStructure(source: String, translation: String): Boolean =
    documentSignatures(source) == documentSignatures(translation) &&
        inlineSignatures(source) == inlineSignatures(translation) &&
        MARKUP_TAG.findAll(source).map { it.value }.toList() == MARKUP_TAG.findAll(translation).map { it.value }.toList()

private fun documentSignatures(text: String): List<List<String>> = DOCUMENT_TAG.findAll(text).map { match ->
    val originalTag = match.groupValues[1]
    val tag = originalTag.lowercase(java.util.Locale.ROOT)
    val signature = mutableListOf("@$originalTag")
    var rest = match.groupValues[2].trim()
    if (tag in PARAMETER_TAGS) {
        Regex("^\\[(?:in|out)(?:[\\t ]*,[\\t ]*(?:in|out))?\\](?=\\s|$)").find(rest)?.let {
            signature += it.value
            rest = rest.substring(it.value.length).trimStart()
        }
    }
    val type = if (tag in TYPE_EXPRESSION_TAGS && rest.startsWith('{')) delimitedToken(rest, 0, '{', '}') else null
    if (type != null) {
        signature += type.text
        rest = rest.substring(type.end).trimStart()
    }
    when {
        tag in PARAMETER_TAGS -> atom(rest)?.let { first ->
            signature += first.text
            val second = atom(rest.substring(first.end).trimStart())
            if (type == null && second != null && Regex("^(?:\\.\\.\\.)?\\$[A-Za-z_]").containsMatchIn(second.text)) signature += second.text
        }
        tag == "template" -> Regex("^[A-Za-z_$][\\w$]*(?:\\s*,\\s*[A-Za-z_$][\\w$]*)*").find(rest)?.let {
            signature += it.value.replace(Regex("\\s"), "")
        }
        tag in NAMED_TYPE_TAGS -> atom(rest)?.let { signature += it.text }
        tag in REFERENCE_TAGS && type == null -> if (!Regex("^[\"'<]").containsMatchIn(rest) && !rest.startsWith("{@")) {
            atom(rest)?.let { signature += it.text }
        }
        tag in RETURN_TYPE_TAGS && type == null -> atom(rest)?.let {
            if (SIMPLE_TYPES.matches(it.text) || it.text.any { character -> character in "\\<>[]|" }) signature += it.text
        }
    }
    signature.toList()
}.toList()

private fun inlineSignatures(text: String): List<List<String>> {
    val signatures = mutableListOf<List<String>>()
    var position = 0
    while (position < text.length) {
        val match = INLINE_TAG.find(text, position) ?: break
        position = match.range.last + 1
        val originalTag = match.groupValues[1]
        val tag = originalTag.lowercase(java.util.Locale.ROOT)
        if (tag !in INLINE_TAGS) continue
        val token = delimitedToken(text, match.range.first, '{', '}', tag == "code")
        if (token == null) {
            signatures += listOf("{@$originalTag", "unclosed", text.substring(position))
            break
        }
        val body = text.substring(position, token.end - 1).trim()
        if (tag == "code" || tag == "literal") signatures += listOf("{@$originalTag", body, "}")
        else {
            val target = atom(body, true)
            val remainder = if (target != null) body.substring(target.end).trimStart() else ""
            signatures += listOf("{@$originalTag", target?.text ?: "", if (remainder.startsWith('|')) "|" else "", "}")
        }
        position = token.end
    }
    return signatures
}

private fun delimitedToken(text: String, start: Int, opening: Char, closing: Char, respectQuotes: Boolean = true): StructureToken? {
    var depth = 0
    var quote: Char? = null
    var index = start
    while (index < text.length) {
        val character = text[index]
        if (quote != null) {
            if (character == '\\') index++
            else if (character == quote) quote = null
        } else if (respectQuotes && character in "\"'`") quote = character
        else if (character == opening) depth++
        else if (character == closing && --depth == 0) return StructureToken(text.substring(start, index + 1), index + 1)
        index++
    }
    return null
}

private fun atom(text: String, stopAtPipe: Boolean = false): StructureToken? {
    if (text.isEmpty()) return null
    val closing = mapOf('(' to ')', '[' to ']', '{' to '}', '<' to '>')
    val stack = mutableListOf<Char>()
    var quote: Char? = null
    var index = 0
    while (index < text.length) {
        val character = text[index]
        if (quote != null) {
            if (character == '\\') index++
            else if (character == quote) quote = null
        } else {
            if (stack.isEmpty() && (character.isWhitespace() || stopAtPipe && character == '|')) break
            if (character in "\"'`") quote = character
            else if (character in closing) stack += closing.getValue(character)
            else if (character == stack.lastOrNull()) stack.removeAt(stack.lastIndex)
        }
        index++
    }
    return if (index > 0) StructureToken(text.substring(0, index.coerceAtMost(text.length)), index.coerceAtMost(text.length)) else null
}
