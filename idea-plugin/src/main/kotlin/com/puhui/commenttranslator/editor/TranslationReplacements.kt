package com.puhui.commenttranslator.editor

import com.intellij.codeInsight.documentation.render.DocRenderManager
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.CustomFoldRegion
import com.intellij.openapi.editor.CustomFoldRegionRenderer
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.FoldRegion
import com.intellij.openapi.editor.RangeMarker
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseEventArea
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.event.EditorMouseMotionListener
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.VisibleAreaListener
import com.intellij.openapi.editor.ex.FoldingListener
import com.intellij.openapi.editor.ex.FoldingModelEx
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.util.Disposer
import java.awt.Cursor
import java.awt.Font
import java.awt.Graphics2D
import java.awt.Point
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.font.FontRenderContext
import java.awt.geom.Rectangle2D
import javax.swing.SwingUtilities
import javax.swing.Timer
import javax.swing.ToolTipManager
import kotlin.math.max

/** Replaces only comment presentation with translated folds, keeping the document completely untouched. */
class TranslationReplacements(private val editor: Editor, parent: Disposable) : TranslationDisplay {
    private data class Metrics(val width: Int, val font: Font, val context: FontRenderContext, val lineHeight: Int, val tabSize: Int)
    private data class WholeLines(val first: Int, val last: Int, val start: Int, val end: Int)
    private data class Entry(val item: DisplayTranslation, val fold: FoldRegion, val renderer: ReplacementRenderer?)
    private data class RevealedComment(val range: RangeMarker, val interaction: Long)

    private val entries = LinkedHashMap<String, Entry>()
    // Follow edits and rescans until every caret and selection has left the revealed comment.
    private val revealed = ArrayList<RevealedComment>()
    private var interaction = 0L
    private var items: List<DisplayTranslation> = emptyList()
    private var lastMetrics: Metrics? = null
    private var documentRenderingBefore: Boolean? = null
    private var changingFolds = false
    private var queued = false
    private var consumedPress = false
    private var tooltipOwned = false
    private var previousTooltip: String? = null
    @Volatile private var disposed = false
    private val reflowTimer = Timer(80) { reconcile() }.apply { isRepeats = false }
    private val resizeListener = object : ComponentAdapter() {
        override fun componentResized(event: ComponentEvent) = scheduleReflow()
    }

    init {
        Disposer.register(parent, this)
        editor.putUserData(ACTIVE_REPLACEMENTS, this)
        editor.contentComponent.addComponentListener(resizeListener)
        Disposer.register(this, Disposable { editor.contentComponent.removeComponentListener(resizeListener) })
        editor.scrollingModel.addVisibleAreaListener(VisibleAreaListener { scheduleReflow() }, this)
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            EditorColorsManager.TOPIC, EditorColorsListener { scheduleReflow() },
        )
        editor.document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = scheduleReconcile()
        }, this)
        editor.caretModel.addCaretListener(object : CaretListener {
            override fun caretPositionChanged(event: CaretEvent) = editingPositionChanged()
            override fun caretAdded(event: CaretEvent) = editingPositionChanged()
            override fun caretRemoved(event: CaretEvent) = editingPositionChanged()
        }, this)
        editor.selectionModel.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(event: SelectionEvent) = editingPositionChanged()
        }, this)
        (editor.foldingModel as? FoldingModelEx)?.addListener(object : FoldingListener {
            override fun onFoldRegionStateChange(region: FoldRegion) {
                if (changingFolds || !region.isExpanded) return
                entries.values.firstOrNull { it.fold === region }?.let { rememberRevealed(it.item) }
            }

            override fun onFoldProcessingEnd() {
                // Native rendered documentation removes its custom folds asynchronously.
                if (!changingFolds) scheduleReconcile()
            }
        }, this)
        editor.addEditorMouseListener(object : EditorMouseListener {
            override fun mousePressed(event: EditorMouseEvent) {
                consumedPress = false
                val entry = entryAt(event) ?: return
                if (!SwingUtilities.isLeftMouseButton(event.mouseEvent) || event.mouseEvent.isPopupTrigger) return
                // Consume before EditorImpl relocates the caret into hidden source text.
                event.consume()
                consumedPress = true
                reveal(entry.item)
                editor.caretModel.moveToOffset(entry.item.startOffset)
            }

            override fun mouseReleased(event: EditorMouseEvent) {
                if (consumedPress) event.consume()
            }

            override fun mouseClicked(event: EditorMouseEvent) {
                if (consumedPress) event.consume()
                consumedPress = false
            }

            override fun mouseExited(event: EditorMouseEvent) = resetTooltip()
        }, this)
        editor.addEditorMouseMotionListener(object : EditorMouseMotionListener {
            override fun mouseMoved(event: EditorMouseEvent) {
                val entry = entryAt(event)
                if (entry?.fold is CustomFoldRegion) {
                    if (!tooltipOwned) previousTooltip = editor.contentComponent.toolTipText
                    tooltipOwned = true
                    editor.contentComponent.toolTipText = originalTooltip(entry.item)
                    editor.contentComponent.cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    ToolTipManager.sharedInstance().mouseMoved(event.mouseEvent)
                } else resetTooltip()
            }

            override fun mouseDragged(event: EditorMouseEvent) {
                if (consumedPress) event.consume()
            }
        }, this)
    }

    /** Applies a source-checked snapshot without changing source, caret, selection, or native ordinary folds. */
    override fun render(items: List<DisplayTranslation>) {
        val snapshot = items.toList()
        onEdt {
            val ids = HashSet<String>()
            this.items = snapshot.filter { ids.add(it.id) && isCurrent(it) }
            updateDocumentationRendering()
            reconcile()
        }
    }

    /** Restores source presentation, the previous effective documentation setting, and all editing choices. */
    override fun clear() = onEdt {
        items = emptyList()
        preserveReadingAnchor { removeOwnedFolds() }
        revealed.forEach { it.range.dispose() }
        revealed.clear()
        restoreDocumentationRendering()
        resetTooltip()
    }

    /** Reveals source or restores its translation; protected caret/selection ranges remain editable. */
    override fun toggle(id: String): Boolean {
        if (disposed || editor.isDisposed) return false
        check(SwingUtilities.isEventDispatchThread()) { "Translation visibility must change on the event dispatch thread" }
        val item = items.firstOrNull { it.id == id && isCurrent(it) } ?: return false
        if (entries[id] != null) {
            reveal(item)
            return true
        }
        val whole = wholeLines(item)
        val start = whole?.start ?: item.startOffset
        val end = whole?.end ?: item.endOffset
        if (editor.caretModel.allCarets.any { it.hasSelection() &&
                intersects(start, end, it.selectionStart, it.selectionEnd) }) return false
        // Only this explicit command may relocate a caret, just like the editor's own collapse action.
        editor.caretModel.allCarets.filter { it.offset > start && it.offset < end }.forEach {
            it.moveToOffset(start)
        }
        revealed.removeAll { (marker, _) ->
            if (!marker.isValid || intersects(marker.startOffset, marker.endOffset, item.startOffset, item.endOffset)) {
                marker.dispose()
                true
            } else false
        }
        reconcile()
        return entries[id] != null
    }

    /** Reveals one owned fold without relocating any caret or selection; used before destructive editor actions. */
    fun reveal(id: String): Boolean {
        if (disposed || editor.isDisposed) return false
        check(SwingUtilities.isEventDispatchThread()) { "Translation visibility must change on the event dispatch thread" }
        val entry = entries[id]?.takeIf { it.fold.isValid } ?: return false
        reveal(entry.item)
        return true
    }

    /** Removes every owned fold and invalidates pending UI work without touching the document. */
    override fun dispose() {
        if (disposed) return
        disposed = true
        val cleanup = Runnable {
            reflowTimer.stop()
            if (!editor.isDisposed) {
                if (editor.getUserData(ACTIVE_REPLACEMENTS) === this) editor.putUserData(ACTIVE_REPLACEMENTS, null)
                preserveReadingAnchor { removeOwnedFolds() }
                restoreDocumentationRendering()
                resetTooltip()
            }
            revealed.forEach { it.range.dispose() }
            revealed.clear()
            entries.clear()
            items = emptyList()
        }
        if (SwingUtilities.isEventDispatchThread()) cleanup.run() else SwingUtilities.invokeLater(cleanup)
    }

    private fun reconcile() {
        if (disposed || editor.isDisposed) return
        reflowTimer.stop()
        revealed.removeAll { (range, openedAt) ->
            // Do not immediately refold a command's reveal before its click/caret handling finishes.
            val expired = !range.isValid || openedAt < interaction && !isEditing(range)
            if (expired) range.dispose()
            expired
        }
        val current = metrics()
        val valid = items.filter(::isCurrent)
        entries.values.filter { isCurrent(it.item) && if (it.fold.isValid && it.renderer != null) {
            isProtected(it.fold.startOffset, it.fold.endOffset)
        } else isProtected(it.item.startOffset, it.item.endOffset) }
            .forEach { rememberRevealed(it.item) }
        val desired = valid.filter { !isRevealed(it) && !isProtected(it.startOffset, it.endOffset) }
        val byId = desired.associateBy { it.id }
        val removals = entries.values.filter { entry ->
            val replacement = byId[entry.item.id]
            !entry.fold.isValid || entry.fold.isExpanded || replacement != entry.item ||
                (entry.renderer == null && customLines(replacement, entry.fold) != null)
        }
        val remaining = entries.keys - removals.map { it.item.id }.toSet()
        val removedFolds = removals.map { it.fold }.toSet()
        val additions = desired.filter { it.id !in remaining }.map { item ->
            val lines = customLines(item, null, removedFolds)
            Triple(item, lines, lines?.let { ReplacementRenderer(item, buildLayout(item, current)) })
        }
        val reflows = if (current != lastMetrics) entries.values.filter { it.renderer != null && it !in removals }
            .map { it to buildLayout(it.item, current) } else emptyList()
        if (removals.isEmpty() && additions.isEmpty() && reflows.isEmpty()) return
        preserveReadingAnchor {
            changingFolds = true
            try {
                editor.foldingModel.runBatchFoldingOperation({
                    for (entry in removals) {
                        if (entry.fold.isValid) editor.foldingModel.removeFoldRegion(entry.fold)
                        entries.remove(entry.item.id)
                    }
                    for ((item, lines, renderer) in additions) {
                        val custom = if (lines != null && renderer != null) {
                            editor.foldingModel.addCustomLinesFolding(lines.first, lines.last, renderer)
                        } else null
                        val fold = custom ?: editor.foldingModel.addFoldRegion(
                            item.startOffset, item.endOffset, item.text.replace(Regex("\\r\\n|\\r|\\n"), " "),
                        ) ?: continue
                        fold.putUserData(TRANSLATED_COMMENT_ID, item.id)
                        if (custom == null) fold.isExpanded = false
                        if (fold.isExpanded) {
                            editor.foldingModel.removeFoldRegion(fold)
                            continue
                        }
                        entries[item.id] = Entry(item, fold, renderer.takeIf { custom != null })
                    }
                    for ((entry, layout) in reflows) {
                        entry.renderer!!.layout = layout
                        (entry.fold as CustomFoldRegion).update()
                    }
                }, false, true)
            } finally {
                changingFolds = false
            }
        }
        lastMetrics = current
    }

    private fun customLines(item: DisplayTranslation, own: FoldRegion?, ignored: Set<FoldRegion> = emptySet()): WholeLines? {
        val whole = wholeLines(item) ?: return null
        if (isProtected(whole.start, whole.end)) return null
        // Preserve unrelated custom folds; retry when the native documentation manager removes its fold.
        if (editor.foldingModel.allFoldRegions.any { it !== own && it !in ignored && it is CustomFoldRegion &&
                intersects(whole.start, whole.end, it.startOffset, it.endOffset) }) return null
        return whole
    }

    private fun wholeLines(item: DisplayTranslation): WholeLines? = wholeLines(item.startOffset, item.endOffset)

    private fun wholeLines(commentStart: Int, commentEnd: Int): WholeLines? {
        if (commentEnd <= commentStart) return null
        val document = editor.document
        val source = document.immutableCharSequence
        val first = document.getLineNumber(commentStart)
        val last = document.getLineNumber(commentEnd - 1)
        val start = document.getLineStartOffset(first)
        val end = document.getLineEndOffset(last)
        if (commentEnd > end || source.subSequence(start, commentStart).any { !it.isWhitespace() } ||
            source.subSequence(commentEnd, end).any { !it.isWhitespace() }
        ) return null
        return WholeLines(first, last, start, end)
    }

    private fun isCurrent(item: DisplayTranslation): Boolean {
        val source = editor.document.immutableCharSequence
        return item.text.isNotBlank() && TranslationLayout.anchorOffset(source, item.startOffset, item.endOffset) != null &&
            (item.originalText == null || source.subSequence(item.startOffset, item.endOffset).toString() == item.originalText)
    }

    private fun isProtected(start: Int, end: Int): Boolean = editor.caretModel.allCarets.any { caret ->
        caret.offset > start && caret.offset < end ||
            caret.hasSelection() && intersects(start, end, caret.selectionStart, caret.selectionEnd)
    }

    private fun isRevealed(item: DisplayTranslation): Boolean = revealed.any { (range, _) ->
        range.isValid && intersects(range.startOffset, range.endOffset, item.startOffset, item.endOffset)
    }

    private fun rememberRevealed(item: DisplayTranslation) {
        if (isCurrent(item) && !isRevealed(item)) {
            val range = editor.document.createRangeMarker(item.startOffset, item.endOffset).apply {
                isGreedyToLeft = true
                isGreedyToRight = true
            }
            revealed.add(RevealedComment(range, interaction))
        }
    }

    private fun isEditing(range: RangeMarker): Boolean {
        val whole = wholeLines(range.startOffset, range.endOffset)
        val start = whole?.start ?: range.startOffset
        val end = whole?.end ?: range.endOffset
        return editor.caretModel.allCarets.any { caret ->
            // Boundaries remain editable after the first Delete/Backspace reveals the source.
            caret.offset in start..end || caret.hasSelection() &&
                intersects(start, end, caret.selectionStart, caret.selectionEnd)
        }
    }

    private fun editingPositionChanged() {
        if (disposed || changingFolds) return
        interaction++
        scheduleReconcile()
    }

    private fun reveal(item: DisplayTranslation) {
        rememberRevealed(item)
        resetTooltip()
        reconcile()
    }

    private fun updateDocumentationRendering() {
        val hasDocs = items.any { (it.originalText ?: sourceText(it)).trimStart().startsWith("/**") }
        if (!hasDocs) {
            restoreDocumentationRendering()
            return
        }
        if (hasDocs && documentRenderingBefore == null && DocRenderManager.isDocRenderingEnabled(editor)) {
            documentRenderingBefore = true
            DocRenderManager.setDocRenderingEnabled(editor, false)
        }
    }

    private fun restoreDocumentationRendering() {
        val previous = documentRenderingBefore ?: return
        documentRenderingBefore = null
        DocRenderManager.setDocRenderingEnabled(editor, previous)
    }

    private fun removeOwnedFolds() {
        reflowTimer.stop()
        changingFolds = true
        try {
            editor.foldingModel.runBatchFoldingOperation({
                entries.values.forEach { if (it.fold.isValid) editor.foldingModel.removeFoldRegion(it.fold) }
                entries.clear()
            }, false, true)
        } finally {
            changingFolds = false
            lastMetrics = null
        }
    }

    private fun entryAt(event: EditorMouseEvent): Entry? {
        if (disposed || editor.isDisposed || event.editor !== editor || event.area != EditorMouseEventArea.EDITING_AREA) return null
        val fold = event.collapsedFoldRegion ?: (editor.foldingModel as? FoldingModelEx)?.getFoldingPlaceholderAt(event.mouseEvent.point)
        return entries.values.firstOrNull { it.fold === fold && it.fold.isValid && isCurrent(it.item) }
    }

    private fun sourceText(item: DisplayTranslation): String = editor.document.immutableCharSequence
        .subSequence(item.startOffset, item.endOffset).toString()

    private fun originalTooltip(item: DisplayTranslation): String {
        val original = (item.originalText ?: sourceText(item)).replace("&", "&amp;")
            .replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;")
        return "<html><pre>$original</pre><br>点击译文查看并编辑原文</html>"
    }

    private fun resetTooltip() {
        if (!tooltipOwned || editor.isDisposed) return
        editor.contentComponent.toolTipText = previousTooltip
        editor.contentComponent.cursor = Cursor.getPredefinedCursor(Cursor.TEXT_CURSOR)
        tooltipOwned = false
        previousTooltip = null
    }

    private fun metrics(): Metrics {
        val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        val width = editor.scrollingModel.visibleArea.width.takeIf { it > 0 } ?: 400
        return Metrics(max(1, width - editor.insets.left - 12), font,
            editor.contentComponent.getFontMetrics(font).fontRenderContext,
            max(1, editor.lineHeight), max(1, editor.settings.getTabSize(editor.project)))
    }

    private fun buildLayout(item: DisplayTranslation, metrics: Metrics): TranslationTextLayout = TranslationLayout.build(
        item.text, item.indent, metrics.width, metrics.font, metrics.context,
        metrics.lineHeight.toFloat(), metrics.tabSize, expanded = true, previewLines = null,
    )

    private fun scheduleReflow() = onEdt {
        if (entries.isNotEmpty() && metrics() != lastMetrics) reflowTimer.restart()
    }

    private fun scheduleReconcile() {
        if (disposed || changingFolds || queued) return
        queued = true
        SwingUtilities.invokeLater {
            queued = false
            if (!disposed && !editor.isDisposed) reconcile()
        }
    }

    private fun preserveReadingAnchor(operation: () -> Unit) {
        if (editor.isDisposed) return
        val viewport = editor.scrollingModel.visibleArea
        val offset = editor.visualPositionToOffset(editor.xyToVisualPosition(Point(viewport.x, viewport.y)))
            .coerceIn(0, editor.document.textLength)
        val deltaY = viewport.y - editor.offsetToXY(offset).y
        operation()
        val targetY = max(0, editor.offsetToXY(offset.coerceAtMost(editor.document.textLength)).y + deltaY)
        editor.scrollingModel.disableAnimation()
        try {
            editor.scrollingModel.scrollVertically(targetY)
            editor.scrollingModel.scrollHorizontally(viewport.x)
        } finally {
            editor.scrollingModel.enableAnimation()
        }
    }

    private fun onEdt(operation: () -> Unit) {
        if (disposed || editor.isDisposed) return
        val checked = Runnable { if (!disposed && !editor.isDisposed) operation() }
        if (SwingUtilities.isEventDispatchThread()) checked.run() else SwingUtilities.invokeLater(checked)
    }

    private fun intersects(start: Int, end: Int, otherStart: Int, otherEnd: Int): Boolean =
        start < otherEnd && otherStart < end

    private inner class ReplacementRenderer(val item: DisplayTranslation, var layout: TranslationTextLayout) : CustomFoldRegionRenderer {
        override fun calcWidthInPixels(region: CustomFoldRegion): Int = layout.width

        override fun calcHeightInPixels(region: CustomFoldRegion): Int = max(editor.lineHeight, layout.height)

        override fun paint(region: CustomFoldRegion, graphics: Graphics2D, targetRegion: Rectangle2D, textAttributes: TextAttributes) {
            if (disposed || editor.isDisposed) return
            scheduleReflow()
            val canvas = graphics.create() as Graphics2D
            try {
                canvas.clip(targetRegion)
                canvas.color = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.LINE_COMMENT)?.foregroundColor
                    ?: editor.colorsScheme.defaultForeground
                for (line in layout.lines) line.layout?.draw(canvas,
                    targetRegion.x.toFloat() + layout.indent, targetRegion.y.toFloat() + line.baseline)
            } finally {
                canvas.dispose()
            }
        }
    }
}
