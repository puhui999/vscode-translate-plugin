package com.puhui.commenttranslator

import com.intellij.openapi.vfs.VirtualFile
import java.util.Locale

private val SUPPORTED_SOURCE_EXTENSIONS = setOf("java", "kt", "kts", "xml", "html", "htm", "xhtml", "xsl")

/** Accepts supported text sources regardless of whether they live on disk, in source archives, or in memory. */
internal fun isSupportedTranslationSource(file: VirtualFile): Boolean =
    file.isValid && !file.isDirectory &&
        file.extension?.lowercase(Locale.ROOT) in SUPPORTED_SOURCE_EXTENSIONS && !file.fileType.isBinary
