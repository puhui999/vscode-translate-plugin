package com.puhui.commenttranslator

import com.intellij.ide.trustedProjects.TrustedProjects
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.fileEditor.*
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.psi.PsiManager
import com.intellij.testFramework.LightVirtualFile
import com.puhui.commenttranslator.cache.cacheContext
import com.puhui.commenttranslator.cache.cacheKey
import com.puhui.commenttranslator.editor.DisplayTranslation
import com.puhui.commenttranslator.editor.TranslationInlays
import com.puhui.commenttranslator.parser.CommentBlock
import com.puhui.commenttranslator.parser.CommentFormatter
import com.puhui.commenttranslator.parser.CommentScanner
import com.puhui.commenttranslator.settings.TranslationSettings
import com.puhui.commenttranslator.translation.TranslationItem
import com.puhui.commenttranslator.translation.TranslationException
import com.puhui.commenttranslator.translation.preservesCommentStructure
import java.awt.datatransfer.StringSelection
import java.util.IdentityHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Future
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private const val AUTOMATIC_LIMIT = 500
private const val MAX_DOCUMENT_CHARS = 2_000_000
private val DEMO_FILE = Key.create<Boolean>("comment-translator.demo")
private val READER_SOURCE = Key.create<VirtualFile>("comment-translator.reader-source")

private class FileSession(val file: VirtualFile, val document: Document) : Disposable {
    val generation = AtomicLong()
    val budget = AtomicInteger(AUTOMATIC_LIMIT)
    val admitted = ConcurrentHashMap.newKeySet<String>()
    val executionLock = Any()
    val renderers = IdentityHashMap<Editor, TranslationInlays>()
    var future: Future<*>? = null
    var timer: ScheduledFuture<*>? = null
    var automaticRequest = true
    var visible = true
    var blocks: List<CommentBlock> = emptyList()
    var translations: Map<String, String> = emptyMap()
    var version = -1L
    val completion = TranslationCompletion()
    var status = "等待翻译"
    var cacheHits = 0
    var remaining = 0
    /** Releases only this file's visual resources. */
    override fun dispose() { generation.incrementAndGet(); timer?.cancel(false); future?.cancel(true) }
}

private data class ScanSnapshot(val version: Long, val blocks: List<CommentBlock>)

/** Coordinates native editor events, cache-first batches, cancellation and non-mutating display. */
@Service(Service.Level.PROJECT)
class TranslationController(private val project: Project) : Disposable {
    private val sessions = ConcurrentHashMap<String, FileSession>()
    private val runtime get() = TranslationRuntime.getInstance()
    private val settings get() = TranslationSettings.getInstance()
    private var started = false
    private var disposed = false
    private var lastFile: VirtualFile? = null

    /** Connects listeners and handles files already open when configuration becomes available. */
    fun start() = onUi {
        if (started) return@onUi
        started = true
        project.messageBus.connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun fileOpened(source: FileEditorManager, file: VirtualFile) { consider(file) }
            override fun selectionChanged(event: FileEditorManagerEvent) { event.newFile?.let(::consider); refreshStatus() }
            override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                sessions.remove(file.url)?.let { session -> session.renderers.values.forEach { it.clear() }; Disposer.dispose(session) }
                refreshStatus()
            }
        })
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                val session = sessions.values.firstOrNull { it.document === event.document } ?: return
                cancel(session)
                onUi {
                    session.blocks = emptyList(); session.translations = emptyMap(); session.version = -1; session.completion.invalidate()
                    render(session); session.status = "注释已更改"
                    if (session.file.getUserData(DEMO_FILE) == true || settings.state.automatic) schedule(session)
                    refreshStatus()
                }
            }
        }, this)
        EditorFactory.getInstance().addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorReleased(event: EditorFactoryEvent) {
                sessions.values.forEach { it.renderers.remove(event.editor)?.let(Disposer::dispose) }
            }
        }, this)
        FileEditorManager.getInstance(project).openFiles.forEach(::consider)
    }

    /** Applies changed provider settings and invalidates results from previous settings. */
    fun configurationChanged() = onUi {
        start()
        sessions.values.forEach { session ->
            if (session.file.getUserData(DEMO_FILE) != true) {
                cancel(session); session.blocks = emptyList(); session.translations = emptyMap(); session.version = -1; session.completion.invalidate()
                session.admitted.clear(); session.budget.set(AUTOMATIC_LIMIT); render(session)
            }
        }
        FileEditorManager.getInstance(project).openFiles.forEach(::consider)
        refreshStatus()
    }

    /** Invalidates earlier requests as soon as the user submits new provider settings. */
    fun suspendForConfiguration() = onUi {
        sessions.values.filter { it.file.getUserData(DEMO_FILE) != true }.forEach { cancel(it); it.status = "正在保存配置" }
        refreshStatus()
    }

    /** Translates the current source file, admitting another budget of missing comments on manual retry. */
    fun translateCurrent(onlyComment: Boolean = false) = onUi {
        val file = activeFile() ?: return@onUi
        if (!eligible(file)) { notifyTranslation(project, "此文件暂不支持注释翻译。验证版支持 Java、Kotlin、HTML/XML 等已安装语言。", false); return@onUi }
        if (file.getUserData(DEMO_FILE) != true && !ready(true)) return@onUi
        val session = session(file) ?: return@onUi
        session.budget.set(AUTOMATIC_LIMIT)
        session.visible = true
        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        if (onlyComment && editor?.document !== session.document) { notifyTranslation(project, "请返回源码，将光标放到需要翻译的注释中。", false); return@onUi }
        val offset = if (onlyComment) editor!!.caretModel.offset else null
        request(session, false, offset)
    }

    /** Toggles display without changing automatic-request policy or invalidating the cache. */
    fun toggleVisible() = onUi {
        val file = activeFile() ?: return@onUi
        val session = session(file) ?: return@onUi
        session.visible = !session.visible; render(session); refreshStatus()
    }

    /** Switches automatic requests globally while keeping completed translations visible. */
    fun toggleAutomatic() = onUi {
        settings.update(settings.state.copy(automatic = !settings.state.automatic))
        ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }.forEach { getInstance(it).automaticChanged() }
    }

    /** Reacts to the automatic switch without affecting explicit manual translation tasks. */
    fun automaticChanged() = onUi {
        if (!settings.state.automatic) sessions.values.filter { it.automaticRequest }.forEach { cancel(it); it.status = "自动翻译已关闭" }
        else FileEditorManager.getInstance(project).openFiles.forEach(::consider)
        refreshStatus()
    }

    /** Opens the native provider settings page. */
    fun openSettings() { ShowSettingsUtil.getInstance().showSettingsDialog(project, "注释译读") }

    /** Copies the translated comment at the caret without changing the normal source clipboard behavior. */
    fun copyCurrentTranslation() = onUi {
        currentBlock()?.let { (session, block) ->
            session.translations[block.id]?.let { CopyPasteManager.getInstance().setContents(StringSelection(CommentFormatter.format(block, it))) }
        } ?: notifyTranslation(project, "请将光标放到已有译文的注释中。", false)
    }

    /** Provides a keyboard-accessible counterpart to the inlay expansion control. */
    fun expandCurrentTranslation() = onUi {
        currentBlock()?.let { (session, block) -> session.renderers.values.forEach { it.toggle(block.id) } }
            ?: notifyTranslation(project, "请将光标放到已有译文的注释中。", false)
    }

    /** Opens a selectable, read-only translated snapshot, leaving the source document untouched. */
    fun openReader() = onUi {
        val file = activeFile() ?: return@onUi
        val state = sessions[file.url]
        if (state == null || state.translations.isEmpty() || state.version != state.document.modificationStamp) {
            notifyTranslation(project, "当前文件还没有可阅读的译文，请先翻译注释。", false); return@onUi
        }
        var text = state.document.text
        state.blocks.sortedByDescending { it.startOffset }.forEach { block ->
            state.translations[block.id]?.let {
                val formatted = CommentFormatter.format(block, it).lines().mapIndexed { index, line -> if (index == 0) line else block.indent + line }.joinToString("\n")
                text = text.replaceRange(block.startOffset, block.endOffset, formatted)
            }
        }
        val reader = LightVirtualFile("${file.name} · 译文快照", file.fileType, text)
        reader.putUserData(READER_SOURCE, file); reader.isWritable = false
        FileEditorManager.getInstance(project).openFile(reader, true)
    }

    /** Clears the application cache and cancels earlier tasks before allowing new work. */
    fun clearCache() = onUi {
        settings.update(settings.state.copy(automatic = false))
        ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }.forEach { getInstance(it).resetAfterClear() }
        runtime.workers.submit {
            try { runtime.clearCache(); notifyTranslation(project, "缓存已清除，自动翻译已关闭。", false) }
            catch (_: Exception) { notifyTranslation(project, "缓存清理失败，请检查数据库是否可访问。", true) }
        }
    }

    /** Invalidates file results before a shared database clear. */
    fun resetAfterClear() = onUi {
        sessions.values.filter { it.file.getUserData(DEMO_FILE) != true }.forEach {
            cancel(it); it.translations = emptyMap(); it.admitted.clear(); it.budget.set(AUTOMATIC_LIMIT); it.completion.invalidate()
            it.status = "缓存已清除"; render(it)
        }
        refreshStatus()
    }

    /** Opens a scratch Java example with fixed local translations and no model requests. */
    fun openDemo() = onUi {
        val source = """
            public class TranslationDemo {
                /** Description. */
                private int count;

                /**
                 * Returns the cached profile for the supplied user.
                 * @param userId Unique user identifier.
                 * @return The profile, or null when no cached value exists.
                 */
                public String findProfile(String userId) {
                    // Read from the local cache before contacting the remote service.
                    int retries = 3; // Maximum number of retry attempts.
                    return null;
                }

                // This explanation is intentionally long to demonstrate how a translated comment
                // wraps with the editor width while preserving normal source editing and navigation.
                public void refresh() {}
            }
        """.trimIndent()
        val file = LightVirtualFile("TranslationDemo.java", FileTypeManager.getInstance().getStdFileType("JAVA"), source)
        file.putUserData(DEMO_FILE, true)
        FileEditorManager.getInstance(project).openFile(file, true)
        val session = session(file) ?: return@onUi
        request(session, false)
    }

    /** Supplies compact progress for the native status widget. */
    fun statusText(): String {
        val file = activeFile()
        val state = file?.let { sessions[it.url] }
        if (state != null) return "译读 ${if (!state.visible) "已隐藏 · " else ""}${state.status}"
        return if (!settings.isConfigured()) "译读 · 配置服务" else if (settings.state.automatic) "译读 · 自动" else "译读 · 手动"
    }

    /** Cancels tasks and releases project-scoped listeners and editor decorations. */
    override fun dispose() { disposed = true; sessions.values.forEach { it.generation.incrementAndGet(); it.future?.cancel(true); it.timer?.cancel(false) }; sessions.clear() }

    private fun consider(file: VirtualFile) {
        if (file.getUserData(READER_SOURCE) != null) return
        if (!eligible(file)) return
        lastFile = file
        val session = session(file) ?: return
        if (session.file.getUserData(DEMO_FILE) == true) { if (session.translations.isEmpty()) request(session, false); return }
        if (settings.state.automatic && ready(false)) {
            if (session.completion.needsAutomaticRun(session.document.modificationStamp, session.future?.isDone == false)) schedule(session)
            else render(session)
        }
    }

    private fun session(file: VirtualFile): FileSession? {
        if (!eligible(file)) return null
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return null
        return sessions.computeIfAbsent(file.url) { FileSession(file, document).also { Disposer.register(this, it) } }
    }

    private fun eligible(file: VirtualFile): Boolean = file.isValid && !file.isDirectory && file.getUserData(READER_SOURCE) == null &&
        (file.isInLocalFileSystem || file.getUserData(DEMO_FILE) == true) &&
        file.extension?.lowercase() in setOf("java", "kt", "kts", "xml", "html", "htm", "xhtml", "xsl")

    private fun ready(manual: Boolean): Boolean {
        if (settings.saving) { if (manual) notifyTranslation(project, "正在保存配置，请稍后重试。", false); return false }
        if (!TrustedProjects.isProjectTrusted(project)) { if (manual) notifyTranslation(project, "项目尚未受信任，未发送注释。", false); return false }
        if (!settings.isConfigured()) { if (manual) openSettings(); return false }
        return true
    }

    private fun schedule(session: FileSession) {
        session.timer?.cancel(false)
        session.timer = runtime.timer.schedule({ onUi {
            if (sessions[session.file.url] === session &&
                session.completion.needsAutomaticRun(session.document.modificationStamp, session.future?.isDone == false)) request(session, true)
        } }, 600, TimeUnit.MILLISECONDS)
    }

    private fun cancel(session: FileSession) {
        session.generation.incrementAndGet(); session.timer?.cancel(false); session.timer = null
        session.future?.cancel(true); session.future = null
    }

    private fun request(session: FileSession, automatic: Boolean, onlyOffset: Int? = null) {
        val demo = session.file.getUserData(DEMO_FILE) == true
        if (!demo && (!ready(!automatic) || (automatic && !settings.state.automatic))) return
        cancel(session)
        val generation = session.generation.get()
        session.automaticRequest = automatic
        session.status = "扫描中"; refreshStatus()
        session.future = runtime.workers.submit {
            synchronized(session.executionLock) {
                val initialVersion = session.document.modificationStamp
                val epoch = runtime.cacheEpoch.get()
                fun current(): Boolean = !disposed && !project.isDisposed && !Thread.currentThread().isInterrupted &&
                    session.generation.get() == generation && session.document.modificationStamp == initialVersion &&
                    sessions[session.file.url] === session && session.file.isValid
                if (!current()) return@submit
                try {
                    val snapshot = ReadAction.nonBlocking<ScanSnapshot> {
                        if (session.document.textLength > MAX_DOCUMENT_CHARS) throw IllegalArgumentException("文件过大，验证版最多处理 200 万字符。")
                        val psi = PsiManager.getInstance(project).findFile(session.file)
                        ScanSnapshot(session.document.modificationStamp, psi?.let(CommentScanner::scan) ?: emptyList())
                    }.withDocumentsCommitted(project).expireWhen { !current() }.executeSynchronously()
                    if (!current()) return@submit
                    val targets = if (onlyOffset != null) snapshot.blocks.filter { onlyOffset in it.startOffset until it.endOffset } else snapshot.blocks
                    if (onlyOffset != null && targets.isEmpty()) {
                        onUi { if (current()) { session.status = "光标处没有注释"; refreshStatus() } }; return@submit
                    }
                    val results = if (session.version == snapshot.version) session.translations.toMutableMap() else mutableMapOf()
                    var hits = 0
                    var remaining = 0
                    if (demo) {
                        targets.forEach { block -> demoTranslation(block.text)?.let { results[block.id] = it } }
                        onUi { if (current()) applyResults(session, snapshot, results.toMap(), "离线示例 · ${results.size} 条", 0, 0, onlyOffset == null) }
                        return@submit
                    }
                    val config = settings.provider()
                    if (!current()) return@submit
                    val groups = targets.groupBy { cacheKey(it.text, it.languageId, config) }
                    val missing = linkedMapOf<String, Pair<String, List<CommentBlock>>>()
                    groups.forEach { (key, blocks) ->
                        if (!current()) return@submit
                        val cached = runtime.cached(key)?.takeIf { preservesCommentStructure(blocks[0].text, it) }
                        if (cached != null) { blocks.forEach { results[it.id] = cached }; hits += blocks.size }
                        else if (onlyOffset != null || session.admitted.contains(key) || session.budget.get() > 0) {
                            if (session.admitted.add(key) && onlyOffset == null) session.budget.decrementAndGet()
                            missing[blocks[0].id] = key to blocks
                        } else remaining += blocks.size
                    }
                    val initial = results.toMap()
                    onUi { if (current()) applyResults(session, snapshot, initial, if (missing.isEmpty()) completeLabel(results.size, hits, remaining) else "翻译中 · ${initial.size}/${snapshot.blocks.size}", hits, remaining) }
                    if (missing.isNotEmpty()) runtime.client.translate(missing.map { (id, group) -> TranslationItem(id, group.second[0].text) }, config,
                        { !current() }, { batch ->
                            if (current()) {
                                batch.forEach { (id, translated) ->
                                    val (key, blocks) = missing[id] ?: return@forEach
                                    runtime.remember(epoch, key, blocks[0].text, translated, cacheContext(blocks[0].languageId, config), ::current)
                                    blocks.forEach { results[it.id] = translated }
                                }
                                val partial = results.toMap()
                                onUi { if (current()) applyResults(session, snapshot, partial, "翻译中 · ${partial.size}/${snapshot.blocks.size}", hits, remaining) }
                            }
                        })
                    val completed = results.toMap()
                    onUi { if (current()) {
                        applyResults(session, snapshot, completed, completeLabel(completed.size, hits, remaining), hits, remaining, onlyOffset == null)
                        if (onlyOffset != null && settings.state.automatic && session.completion.needsAutomaticRun(snapshot.version, false)) schedule(session)
                    } }
                } catch (_: ProcessCanceledException) { /* A write, cancellation or project close invalidated the read. */
                } catch (_: InterruptedException) { Thread.currentThread().interrupt()
                } catch (error: Exception) {
                    if (current()) onUi {
                        if (current()) {
                            session.status = if (error is TranslationException) "${error.message ?: "翻译失败"} · 可重试" else "处理失败 · 请重试"
                            refreshStatus()
                            if (!automatic) notifyTranslation(project, session.status, true)
                        }
                    }
                }
            }
        }
    }

    private fun applyResults(session: FileSession, snapshot: ScanSnapshot, results: Map<String, String>, label: String, hits: Int, remaining: Int, wholeFileCompleted: Boolean = false) {
        session.completion.publish(snapshot.version, wholeFileCompleted)
        session.version = snapshot.version; session.blocks = snapshot.blocks; session.translations = results
        session.status = label; session.cacheHits = hits; session.remaining = remaining
        render(session); refreshStatus()
    }

    private fun render(session: FileSession) {
        val editors = EditorFactory.getInstance().getEditors(session.document, project).filterNot { it.isDisposed || it.isViewer }
        val items = if (!session.visible || session.version != session.document.modificationStamp) emptyList() else session.blocks.mapNotNull { block ->
            session.translations[block.id]?.let { DisplayTranslation(block.id, block.startOffset, block.endOffset, CommentFormatter.format(block, it), block.indent) }
        }
        editors.forEach { editor -> session.renderers.getOrPut(editor) { TranslationInlays(editor, session) }.render(items) }
    }

    private fun activeFile(): VirtualFile? {
        val selected = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
        return if (selected != null) selected.getUserData(READER_SOURCE) ?: selected.takeIf(::eligible) else lastFile?.takeIf { it.isValid }
    }

    private fun currentBlock(): Pair<FileSession, CommentBlock>? {
        val file = activeFile() ?: return null
        val session = sessions[file.url] ?: return null
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        if (editor.document !== session.document || session.version != session.document.modificationStamp) return null
        val block = session.blocks.firstOrNull { editor.caretModel.offset in it.startOffset until it.endOffset && session.translations.containsKey(it.id) } ?: return null
        return session to block
    }

    private fun refreshStatus() { if (!project.isDisposed) WindowManager.getInstance().getStatusBar(project)?.updateWidget(TRANSLATION_WIDGET_ID) }

    private fun onUi(action: () -> Unit) {
        if (disposed || project.isDisposed) return
        if (ApplicationManager.getApplication().isDispatchThread) action()
        else ApplicationManager.getApplication().invokeLater { if (!disposed && !project.isDisposed) action() }
    }

    private fun completeLabel(count: Int, hits: Int, remaining: Int): String =
        if (remaining > 0) "$count 条 · 余 $remaining 条，手动继续" else "$count 条 · 缓存 $hits"

    private fun demoTranslation(text: String): String? = when {
        text.startsWith("Description.") -> "计数器的当前值。"
        text.startsWith("Returns the cached profile") -> "从本地缓存读取指定用户的资料。\n@param userId 用户的唯一标识符。\n@return 已缓存的用户资料；缓存中没有对应数据时返回 null。"
        text.startsWith("Read from the local cache") -> "先读取本地缓存，再决定是否访问远程服务。"
        text.startsWith("Maximum number") -> "请求失败时允许的最大重试次数。"
        text.startsWith("This explanation") -> "这是一段用于检查多行阅读体验的较长说明。译文根据编辑器当前的可用宽度换行，拖动分栏或调整字体后会重新排版。\n源码始终保持可编辑，译文不会写入文件，也不会改变保存内容。\n较长的译文首先显示四行，点击下方的展开操作可在原处阅读全文。\n展开和收起不会重新请求模型，也不会移动源码中的光标。\n关闭再打开相同源码文件时，真实翻译会优先使用 SQLite 中的已有结果。\n此示例使用固定译文，不调用网络，也不写入翻译缓存。"
        else -> null
    }

    companion object {
        /** Returns the controller belonging to one project. */
        fun getInstance(project: Project): TranslationController = project.service()
    }
}
