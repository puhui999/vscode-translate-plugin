package com.puhui.commenttranslator.editor

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.InlayProperties
import com.intellij.openapi.editor.colors.EditorColorsListener
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseEventArea
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.event.EditorMouseMotionListener
import com.intellij.openapi.editor.event.VisibleAreaListener
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.util.Disposer
import java.awt.Cursor
import java.awt.Font
import java.awt.Graphics2D
import java.awt.Point
import java.awt.datatransfer.StringSelection
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.MouseEvent
import java.awt.font.FontRenderContext
import java.awt.geom.Rectangle2D
import javax.swing.SwingUtilities
import javax.swing.Timer
import kotlin.math.max

/** Owns read-only, wrapping translations below comments in one source editor. */
class TranslationInlays(private val editor: Editor, parent: Disposable) : Disposable {
    private data class Metrics(val width: Int, val font: Font, val context: FontRenderContext, val lineHeight: Int, val tabSize: Int)
    private data class Entry(val item: DisplayTranslation, val renderer: TranslationRenderer, val inlay: Inlay<TranslationRenderer>)
    private data class ReadingAnchor(val offset: Int, val deltaY: Int, val horizontalOffset: Int)
    private data class Press(val renderer: TranslationRenderer, val point: Point, val control: Boolean)

    private val entries = LinkedHashMap<String, Entry>()
    private val expandedIds = HashSet<String>()
    private var lastItems: List<DisplayTranslation> = emptyList()
    private var lastMetrics: Metrics? = null
    private var press: Press? = null
    private var popupShownOnPress = false
    private var ownsCursor = false
    @Volatile private var disposed = false
    private val reflowTimer = Timer(80) { reflow() }.apply { isRepeats = false }
    private val resizeListener = object : ComponentAdapter() {
        override fun componentResized(event: ComponentEvent) = scheduleReflow()
    }

    init {
        Disposer.register(parent, this)
        editor.scrollingModel.addVisibleAreaListener(VisibleAreaListener { scheduleReflow() }, this)
        editor.contentComponent.addComponentListener(resizeListener)
        Disposer.register(this, Disposable { editor.contentComponent.removeComponentListener(resizeListener) })
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            EditorColorsManager.TOPIC,
            EditorColorsListener { scheduleReflow() },
        )
        editor.addEditorMouseListener(object : EditorMouseListener {
            override fun mousePressed(event: EditorMouseEvent) {
                // A popup can consume its release outside the editor; never retain that previous gesture.
                press = null
                popupShownOnPress = false
                val renderer = rendererAt(event) ?: return
                // This callback runs before IDEA changes the caret or selection.
                event.consume()
                val point = event.mouseEvent.point
                val isLeft = SwingUtilities.isLeftMouseButton(event.mouseEvent) && !event.mouseEvent.isPopupTrigger
                press = Press(renderer, point, isLeft && renderer.isControlAt(point))
                popupShownOnPress = event.mouseEvent.isPopupTrigger
                if (popupShownOnPress) showMenu(renderer, event.mouseEvent)
            }

            override fun mouseReleased(event: EditorMouseEvent) {
                // A source selection drag ending over an inlay still belongs to the source editor.
                val pressed = press ?: return
                val renderer = rendererAt(event)
                event.consume()
                press = null
                if (event.mouseEvent.isPopupTrigger && !popupShownOnPress) {
                    showMenu(renderer ?: pressed.renderer, event.mouseEvent)
                } else if (renderer === pressed.renderer && pressed.control &&
                    SwingUtilities.isLeftMouseButton(event.mouseEvent) && !event.mouseEvent.isPopupTrigger &&
                    pressed.point.distance(event.mouseEvent.point) <= 5 && renderer.isControlAt(event.mouseEvent.point)
                ) {
                    toggle(renderer)
                }
                popupShownOnPress = false
            }

            override fun mouseClicked(event: EditorMouseEvent) {
                if (rendererAt(event) != null) event.consume()
            }

            override fun mouseExited(event: EditorMouseEvent) = resetCursor()
        }, this)
        editor.addEditorMouseMotionListener(object : EditorMouseMotionListener {
            override fun mouseMoved(event: EditorMouseEvent) {
                val renderer = rendererAt(event)
                if (renderer != null) {
                    event.consume()
                    editor.contentComponent.cursor = Cursor.getPredefinedCursor(
                        if (renderer.isControlAt(event.mouseEvent.point)) Cursor.HAND_CURSOR else Cursor.DEFAULT_CURSOR,
                    )
                    ownsCursor = true
                } else resetCursor()
            }

            override fun mouseDragged(event: EditorMouseEvent) {
                if (press != null) event.consume()
            }
        }, this)
    }

    /** Replaces the displayed snapshot without changing the source document or caret. Safe to call from any thread. */
    fun render(items: List<DisplayTranslation>) {
        val snapshot = items.toList()
        onEdt {
            val source = editor.document.immutableCharSequence
            val unique = HashSet<String>()
            val accepted = snapshot.filter { it.text.isNotBlank() && unique.add(it.id) &&
                TranslationLayout.anchorOffset(source, it.startOffset, it.endOffset) != null }
            val metrics = metrics()
            if (accepted == lastItems && entries.size == accepted.size && entries.values.all { it.inlay.isValid }) {
                if (metrics != lastMetrics) reflow()
                return@onEdt
            }
            expandedIds.retainAll(accepted.map { it.id }.toSet())
            // Measuring before the batch avoids forbidden editor coordinate queries inside InlayModel.execute.
            val prepared = accepted.map { item ->
                val renderer = TranslationRenderer(item, buildLayout(item, metrics))
                Triple(item, renderer, TranslationLayout.anchorOffset(source, item.startOffset, item.endOffset)!!)
            }
            preserveReadingAnchor {
                editor.inlayModel.execute(entries.size + prepared.size >= 100) {
                    entries.values.forEach { it.inlay.dispose() }
                    entries.clear()
                    for ((item, renderer, anchor) in prepared) {
                        val inlay = editor.inlayModel.addBlockElement(
                            anchor,
                            InlayProperties().showAbove(false).showWhenFolded(false).relatesToPrecedingText(true),
                            renderer,
                        ) ?: continue
                        renderer.inlay = inlay
                        entries[item.id] = Entry(item, renderer, inlay)
                    }
                }
            }
            lastItems = accepted
            lastMetrics = metrics
        }
    }

    /** Removes all translations and expansion state while leaving source text and selection unchanged. */
    fun clear() = onEdt {
        preserveReadingAnchor { removeAll() }
        lastItems = emptyList()
        expandedIds.clear()
    }

    /** Toggles a long translation by ID for keyboard actions. Must be called on the event dispatch thread. */
    fun toggle(id: String): Boolean {
        if (disposed || editor.isDisposed) return false
        check(SwingUtilities.isEventDispatchThread()) { "Translation expansion must run on the event dispatch thread" }
        val entry = entries[id] ?: return false
        if (!entry.inlay.isValid || !entry.renderer.layout.canToggle) return false
        toggle(entry.renderer)
        return true
    }

    /** Releases all editor-owned visual elements; queued layout work becomes inert. */
    override fun dispose() {
        if (disposed) return
        disposed = true
        val cleanup = Runnable {
            reflowTimer.stop()
            removeAll()
            expandedIds.clear()
            lastItems = emptyList()
            resetCursor()
        }
        if (SwingUtilities.isEventDispatchThread()) cleanup.run() else SwingUtilities.invokeLater(cleanup)
    }

    private fun removeAll() {
        reflowTimer.stop()
        press = null
        entries.values.forEach { if (it.inlay.isValid) it.inlay.dispose() }
        entries.clear()
        lastMetrics = null
    }

    private fun metrics(): Metrics {
        val font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
        val viewportWidth = editor.scrollingModel.visibleArea.width
        val width = max(1, (if (viewportWidth > 0) viewportWidth else 400) - editor.insets.left - 12)
        return Metrics(
            width, font, editor.contentComponent.getFontMetrics(font).fontRenderContext,
            max(1, editor.lineHeight), max(1, editor.settings.getTabSize(editor.project)),
        )
    }

    private fun buildLayout(item: DisplayTranslation, metrics: Metrics): TranslationTextLayout = TranslationLayout.build(
        item.text, item.indent, metrics.width, metrics.font, metrics.context,
        metrics.lineHeight.toFloat(), metrics.tabSize, item.id in expandedIds,
    )

    private fun scheduleReflow() = onEdt {
        if (entries.isNotEmpty() && metrics() != lastMetrics) reflowTimer.restart()
    }

    private fun reflow() {
        if (disposed || editor.isDisposed || entries.isEmpty()) return
        val current = metrics()
        if (current == lastMetrics) return
        val layouts = entries.values.filter { it.inlay.isValid }.map { it to buildLayout(it.item, current) }
        preserveReadingAnchor {
            editor.inlayModel.execute(layouts.size >= 100) {
                for ((entry, layout) in layouts) {
                    entry.renderer.layout = layout
                    entry.inlay.update()
                }
            }
        }
        lastMetrics = current
    }

    private fun toggle(renderer: TranslationRenderer) {
        val entry = entries[renderer.item.id] ?: return
        if (entry.renderer !== renderer || !entry.inlay.isValid || !renderer.layout.canToggle) return
        if (!expandedIds.add(renderer.item.id)) expandedIds.remove(renderer.item.id)
        val layout = buildLayout(renderer.item, metrics())
        preserveReadingAnchor {
            renderer.layout = layout
            entry.inlay.update()
        }
        resetCursor()
    }

    private fun rendererAt(event: EditorMouseEvent): TranslationRenderer? {
        if (disposed || editor.isDisposed || event.editor !== editor || event.area != EditorMouseEventArea.EDITING_AREA) return null
        val renderer = event.inlay?.renderer as? TranslationRenderer ?: return null
        return renderer.takeIf { entries[it.item.id]?.renderer === it }
    }

    private fun showMenu(renderer: TranslationRenderer, event: MouseEvent) {
        if (disposed || entries[renderer.item.id]?.renderer !== renderer) return
        ActionManager.getInstance().createActionPopupMenu("CommentTranslator.Inlay", renderer.menu())
            .component.show(event.component, event.x, event.y)
    }

    private fun resetCursor() {
        if (ownsCursor && !editor.isDisposed) editor.contentComponent.cursor = Cursor.getPredefinedCursor(Cursor.TEXT_CURSOR)
        ownsCursor = false
    }

    private fun preserveReadingAnchor(operation: () -> Unit) {
        if (editor.isDisposed) return
        val viewport = editor.scrollingModel.visibleArea
        val position = editor.xyToVisualPosition(Point(viewport.x, viewport.y))
        val offset = editor.visualPositionToOffset(position).coerceIn(0, editor.document.textLength)
        val anchor = ReadingAnchor(offset, viewport.y - editor.offsetToXY(offset).y, viewport.x)
        operation()
        if (editor.isDisposed) return
        val targetY = max(0, editor.offsetToXY(anchor.offset.coerceAtMost(editor.document.textLength)).y + anchor.deltaY)
        val scrolling = editor.scrollingModel
        scrolling.disableAnimation()
        try {
            scrolling.scrollVertically(targetY)
            scrolling.scrollHorizontally(anchor.horizontalOffset)
        } finally {
            scrolling.enableAnimation()
        }
    }

    private fun onEdt(operation: () -> Unit) {
        if (disposed || editor.isDisposed) return
        val checked = Runnable { if (!disposed && !editor.isDisposed) operation() }
        if (SwingUtilities.isEventDispatchThread()) checked.run() else SwingUtilities.invokeLater(checked)
    }

    private inner class TranslationRenderer(val item: DisplayTranslation, var layout: TranslationTextLayout) : EditorCustomElementRenderer {
        var inlay: Inlay<TranslationRenderer>? = null

        override fun calcWidthInPixels(inlay: Inlay<*>): Int = layout.width

        override fun calcHeightInPixels(inlay: Inlay<*>): Int = layout.height

        override fun paint(inlay: Inlay<*>, graphics: Graphics2D, targetRegion: Rectangle2D, textAttributes: TextAttributes) {
            if (disposed || editor.isDisposed) return
            // Font zoom can repaint without a viewport-size event; schedule remeasurement after painting.
            scheduleReflow()
            val canvas = graphics.create() as Graphics2D
            try {
                canvas.clip(targetRegion)
                canvas.color = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.LINE_COMMENT)?.foregroundColor
                    ?: editor.colorsScheme.defaultForeground
                val x = targetRegion.x.toFloat() + layout.indent
                val y = targetRegion.y.toFloat()
                for (line in layout.lines) line.layout?.draw(canvas, x, y + line.baseline)
                layout.control?.draw(canvas, x, y + layout.controlBaseline)
            } finally {
                canvas.dispose()
            }
        }

        override fun getContextMenuGroup(inlay: Inlay<*>): DefaultActionGroup = menu()

        fun isControlAt(point: Point): Boolean {
            val bounds = inlay?.bounds ?: return false
            return layout.isControlAt((point.x - bounds.x).toFloat(), (point.y - bounds.y).toFloat())
        }

        fun menu(): DefaultActionGroup = DefaultActionGroup().apply {
            add(object : DumbAwareAction("复制译文") {
                override fun actionPerformed(event: AnActionEvent) {
                    CopyPasteManager.getInstance().setContents(StringSelection(item.text))
                }
            })
            if (layout.canToggle) add(object : DumbAwareAction(if (item.id in expandedIds) "收起译文" else "展开译文") {
                override fun actionPerformed(event: AnActionEvent) = toggle(this@TranslationRenderer)
            })
        }
    }
}
