package com.puhui.commenttranslator

import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseEventArea
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import javax.swing.SwingUtilities

private data class PopupPosition(val version: Long, val offset: Int)
private val POPUP_POSITION = Key.create<PopupPosition>("comment-translator.popup-position")

/** Carries the actual action editor and clicked source position across menu invocation. */
data class TranslationActionTarget(val file: VirtualFile?, val editor: Editor?, val offset: Int?) {
    companion object {
        /** Uses the event context before falling back to the selected editor in the controller. */
        fun from(event: AnActionEvent): TranslationActionTarget {
            val editor = event.getData(CommonDataKeys.EDITOR)
            val file = editor?.let { FileDocumentManager.getInstance().getFile(it.document) }
                ?: event.getData(CommonDataKeys.VIRTUAL_FILE)
            val popup = editor?.getUserData(POPUP_POSITION)?.takeIf {
                event.place == ActionPlaces.EDITOR_POPUP && it.version == editor.document.modificationStamp
            }
            return TranslationActionTarget(file, editor, popup?.offset ?: editor?.caretModel?.offset)
        }

        /** Captures right-click location without relocating the caret or revealing translated source. */
        fun recordPopup(event: EditorMouseEvent) {
            val editor = event.editor
            if (!SwingUtilities.isRightMouseButton(event.mouseEvent) && !event.mouseEvent.isPopupTrigger) {
                editor.putUserData(POPUP_POSITION, null)
                return
            }
            if (event.area != EditorMouseEventArea.EDITING_AREA) return
            val offset = event.collapsedFoldRegion?.startOffset ?: editor.logicalPositionToOffset(event.logicalPosition)
            editor.putUserData(POPUP_POSITION, PopupPosition(editor.document.modificationStamp, offset))
        }
    }
}

/** Snapshot for action enablement; inspecting menus never starts translation requests. */
data class TranslationActionState(
    val supported: Boolean = false,
    val running: Boolean = false,
    val hasTranslations: Boolean = false,
    val hasCurrentTranslation: Boolean = false,
    val visible: Boolean = true,
)
