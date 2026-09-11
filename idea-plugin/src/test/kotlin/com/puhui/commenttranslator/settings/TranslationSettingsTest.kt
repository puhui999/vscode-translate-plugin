package com.puhui.commenttranslator.settings

import org.junit.Assert.*
import org.junit.Test

/** Guards ordering and failure semantics of asynchronous native settings saves. */
class TranslationSettingsTest {
    /** Older saves cannot replace a newer submitted provider or reopen automatic work. */
    @Test fun newestSaveWins() {
        val settings = TranslationSettings()
        val first = settings.beginSave()
        val second = settings.beginSave()
        assertFalse(settings.finishSave(first, TranslationSettingsState(model = "old")))
        assertTrue(settings.saving)
        assertTrue(settings.finishSave(second, TranslationSettingsState(model = "new")))
        assertEquals("new", settings.state.model)
        assertFalse(settings.saving)
    }

    /** A stale failure does not cancel a more recent settings save. */
    @Test fun staleFailureIsIgnored() {
        val settings = TranslationSettings()
        val first = settings.beginSave()
        settings.beginSave()
        assertFalse(settings.failSave(first))
        assertTrue(settings.saving)
    }

    /** A failed latest credential save leaves the last provider intact and requests paused. */
    @Test fun newestFailurePausesAutomaticRequests() {
        val settings = TranslationSettings()
        settings.update(TranslationSettingsState(model = "existing"))
        assertTrue(settings.failSave(settings.beginSave()))
        assertEquals("existing", settings.state.model)
        assertFalse(settings.state.automatic)
        assertFalse(settings.saving)
    }
}
