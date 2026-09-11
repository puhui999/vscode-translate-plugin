package com.puhui.commenttranslator.settings

import com.intellij.openapi.Disposable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Component
import java.awt.Container
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JSpinner

/** Exercises native settings controls without reading credentials or contacting a translation service. */
class TranslationConfigurablePlatformTest : BasePlatformTestCase() {
    /** Swing form interaction and configurable saves belong on the UI thread. */
    override fun runInDispatchThread(): Boolean = true

    /** Restoring settings populates every new option and resets unsaved edits accurately. */
    fun testResetRestoresAllRequestOptionsAndModifiedDetection() {
        val settings = settings(TranslationSettingsState(automatic = false, maxConcurrency = 32,
            responseFormat = "text", temperature = 1.25, thinkingMode = "provider", maxBatchChars = 24000))
        val configurable = TranslationConfigurable()
        val panel = configurable.createComponent()
        Disposer.register(testRootDisposable, Disposable { configurable.disposeUIResources() })
        assertEquals(32, control<JSpinner>(panel, "同时翻译的注释数").value)
        assertEquals(1, control<JComboBox<*>>(panel, "输出格式").selectedIndex)
        assertEquals(1.25, (control<JSpinner>(panel, "温度").value as Number).toDouble(), 0.0)
        assertEquals(0, control<JComboBox<*>>(panel, "思考模式").selectedIndex)
        assertEquals(24000, control<JSpinner>(panel, "单条注释字符上限").value)
        assertFalse(configurable.isModified)
        control<JComboBox<*>>(panel, "思考模式").selectedIndex = 2
        control<JSpinner>(panel, "温度").value = 0.3
        assertTrue(configurable.isModified)
        configurable.reset()
        assertFalse(configurable.isModified)
        assertEquals("provider", settings.state.thinkingMode)
        assertEquals(0, control<JComboBox<*>>(panel, "思考模式").selectedIndex)
    }

    /** Text typed into a spinner is committed even before focus leaves; concurrency-only saves stay synchronous. */
    fun testConcurrencyTextSavesWithoutCredentialSaveOrProviderReset() {
        val settings = settings(TranslationSettingsState(automatic = false))
        val configurable = TranslationConfigurable()
        val panel = configurable.createComponent()
        Disposer.register(testRootDisposable, Disposable { configurable.disposeUIResources() })
        val concurrency = control<JSpinner>(panel, "同时翻译的注释数")
        (concurrency.editor as JSpinner.DefaultEditor).textField.text = "17"
        assertTrue(configurable.isModified)
        configurable.apply()
        assertEquals(17, settings.state.maxConcurrency)
        assertEquals("json_object", settings.state.responseFormat)
        assertEquals("provider", settings.state.thinkingMode)
        assertFalse(settings.saving)
        assertFalse(configurable.isModified)
    }

    /** Invalid request limits are rejected before changing stored settings or starting an asynchronous save. */
    fun testInvalidNumericInputCannotSaveOrPauseRequests() {
        val settings = settings(TranslationSettingsState(automatic = false))
        val original = settings.state.copy()
        val configurable = TranslationConfigurable()
        val panel = configurable.createComponent()
        Disposer.register(testRootDisposable, Disposable { configurable.disposeUIResources() })
        for ((label, invalid) in listOf("同时翻译的注释数" to "65", "温度" to "3", "温度" to "NaN", "单条注释字符上限" to "999")) {
            configurable.reset()
            val spinner = control<JSpinner>(panel, label)
            (spinner.editor as JSpinner.DefaultEditor).textField.text = invalid
            assertTrue(configurable.isModified)
            try {
                configurable.apply()
                fail("Invalid $label must be rejected")
            } catch (_: ConfigurationException) {
                assertEquals(original, settings.state)
                assertFalse(settings.saving)
            }
        }
    }

    private fun settings(state: TranslationSettingsState): TranslationSettings {
        val settings = TranslationSettings.getInstance()
        val previous = settings.state.copy()
        settings.update(state)
        Disposer.register(testRootDisposable, Disposable { settings.update(previous) })
        return settings
    }

    private inline fun <reified T : JComponent> control(root: Container, label: String): T =
        components(root).filterIsInstance<JLabel>().single { it.text == label }.labelFor as T

    private fun components(container: Container): List<Component> = container.components.flatMap {
        listOf(it) + if (it is Container) components(it) else emptyList()
    }
}
