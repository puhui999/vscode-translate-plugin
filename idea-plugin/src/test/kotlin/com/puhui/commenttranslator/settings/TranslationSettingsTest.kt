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

    /** Existing persisted configurations receive the new per-comment request defaults. */
    @Test fun requestOptionsHaveBackwardsCompatibleDefaults() {
        val state = TranslationSettingsState(baseUrl = "https://example.test/v1", model = "test")
        val config = state.providerConfig("mock-key")
        assertEquals(10, state.maxConcurrency)
        assertEquals("json_object", state.responseFormat)
        assertEquals(0.2, state.temperature, 0.0)
        assertEquals("provider", state.thinkingMode)
        assertEquals(10, config.maxConcurrency)
        assertEquals("json_object", config.responseFormat)
        assertEquals(0.2, config.temperature, 0.0)
        assertEquals("provider", config.thinkingMode)
        assertEquals("mock-key", config.apiKey)
    }

    /** New request options survive detached loads and the newest serialized save. */
    @Test fun saveAndLoadPreserveIndependentRequestOptions() {
        val state = TranslationSettingsState(maxConcurrency = 24, responseFormat = "text", temperature = 1.25,
            thinkingMode = "disabled", maxBatchChars = 48000)
        val settings = TranslationSettings()
        settings.loadState(state)
        state.maxConcurrency = 1
        assertEquals(24, settings.state.maxConcurrency)
        assertTrue(settings.finishSave(settings.beginSave(), settings.state.copy(temperature = 0.0, thinkingMode = "enabled")))
        val config = settings.state.providerConfig("")
        assertEquals(24, config.maxConcurrency)
        assertEquals("text", config.responseFormat)
        assertEquals(0.0, config.temperature, 0.0)
        assertEquals("enabled", config.thinkingMode)
        assertEquals(48000, config.maxBatchChars)
    }

    /** Corrupt or manually edited persisted values cannot escape request bounds or send non-finite JSON numbers. */
    @Test fun requestOptionsAreBoundedBeforeReachingTheProvider() {
        val invalid = TranslationSettingsState(maxConcurrency = 0, responseFormat = "invalid", temperature = Double.NaN,
            thinkingMode = "invalid")
        val fallback = invalid.providerConfig("")
        assertEquals(1, fallback.maxConcurrency)
        assertEquals("json_object", fallback.responseFormat)
        assertEquals(0.2, fallback.temperature, 0.0)
        assertEquals("provider", fallback.thinkingMode)
        assertEquals(64, invalid.copy(maxConcurrency = 999).providerConfig("").maxConcurrency)
        assertEquals(0.0, invalid.copy(temperature = -1.0).providerConfig("").temperature, 0.0)
        assertEquals(2.0, invalid.copy(temperature = 5.0).providerConfig("").temperature, 0.0)
        assertEquals(0.2, invalid.copy(temperature = Double.POSITIVE_INFINITY).providerConfig("").temperature, 0.0)
        assertEquals("provider", invalid.copy(thinkingMode = "provider").providerConfig("").thinkingMode)
    }
}
