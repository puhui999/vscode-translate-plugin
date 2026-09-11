package com.puhui.commenttranslator.settings

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.puhui.commenttranslator.translation.ProviderConfig
import com.puhui.commenttranslator.translation.normalizeEndpoint
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong

/** Non-secret application settings; credentials are stored separately in PasswordSafe. */
data class TranslationSettingsState(
    var baseUrl: String = "",
    var model: String = "",
    var targetLanguage: String = "简体中文",
    var prompt: String = "",
    var automatic: Boolean = true,
    var timeoutSeconds: Int = 60,
    var maxBatchChars: Int = 16000,
    var displayMode: String = "replacement",
    var maxConcurrency: Int = 10,
    var responseFormat: String = "json_object",
    var temperature: Double = 0.2,
    var thinkingMode: String = "provider",
)

/** Persists provider configuration outside project files. */
@Service(Service.Level.APP)
@State(name = "PuhuiCommentTranslator", storages = [Storage("puhui-comment-translator.xml")])
class TranslationSettings : PersistentStateComponent<TranslationSettingsState> {
    @Volatile private var value = TranslationSettingsState()
    private val saveSequence = AtomicLong()
    @Volatile var saving: Boolean = false
        private set

    /** Returns the current immutable-by-convention settings snapshot. */
    override fun getState(): TranslationSettingsState = value

    /** Replaces settings loaded by the platform. */
    override fun loadState(state: TranslationSettingsState) { value = state.copy() }

    /** Replaces settings with a detached copy. */
    fun update(state: TranslationSettingsState) { value = state.copy() }

    /** Pauses requests while a serialized credential/settings save is pending. */
    @Synchronized fun beginSave(): Long { saving = true; return saveSequence.incrementAndGet() }

    /** Reports whether this save is still the latest explicit user submission. */
    fun isLatestSave(sequence: Long): Boolean = sequence == saveSequence.get()

    /** Applies only the newest form submission after its credential write succeeds. */
    @Synchronized fun finishSave(sequence: Long, state: TranslationSettingsState): Boolean {
        if (!isLatestSave(sequence)) return false
        value = state.copy(); saving = false; return true
    }

    /** Leaves automatic requests paused after the newest save fails. */
    @Synchronized fun failSave(sequence: Long): Boolean {
        if (!isLatestSave(sequence)) return false
        value = value.copy(automatic = false); saving = false; return true
    }

    /** Reports whether automatic requests have enough non-secret configuration. */
    fun isConfigured(): Boolean = value.baseUrl.isNotBlank() && value.model.isNotBlank()

    /** Reads a provider-scoped key on a background thread and returns an HTTP configuration. */
    fun provider(): ProviderConfig {
        val snapshot = value.copy()
        require(snapshot.baseUrl.isNotBlank() && snapshot.model.isNotBlank()) { "请先配置服务地址和模型。" }
        val key = PasswordSafe.instance.getPassword(attributes(snapshot.baseUrl)) ?: ""
        return snapshot.providerConfig(key)
    }

    companion object {
        /** Gets the application settings service. */
        fun getInstance(): TranslationSettings = service()

        /** Builds stable credential attributes for one normalized endpoint. */
        fun attributes(baseUrl: String): CredentialAttributes {
            val hash = MessageDigest.getInstance("SHA-256").digest(normalizeEndpoint(baseUrl).toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            return CredentialAttributes("Puhui Comment Translator:$hash")
        }
    }
}

/** Converts a settings snapshot into bounded request options without accessing the credential store. */
internal fun TranslationSettingsState.providerConfig(apiKey: String): ProviderConfig = ProviderConfig(
    baseUrl = baseUrl,
    model = model,
    apiKey = apiKey,
    targetLanguage = targetLanguage,
    prompt = prompt,
    timeoutSeconds = timeoutSeconds.coerceIn(5, 300),
    maxBatchChars = maxBatchChars.coerceIn(1000, 200000),
    maxConcurrency = maxConcurrency.coerceIn(1, 64),
    responseFormat = if (responseFormat == "text") "text" else "json_object",
    temperature = if (temperature.isFinite()) temperature.coerceIn(0.0, 2.0) else 0.2,
    thinkingMode = thinkingMode.takeIf { it in THINKING_MODES } ?: "provider",
)

internal val THINKING_MODES = listOf("provider", "disabled", "enabled")
