package com.puhui.commenttranslator.settings

import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.project.ProjectManager
import com.puhui.commenttranslator.TranslationController
import com.puhui.commenttranslator.TranslationRuntime
import com.puhui.commenttranslator.notifyTranslation
import com.puhui.commenttranslator.translation.normalizeEndpoint
import java.awt.BorderLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.*

/** Native settings UI; saving a key never serializes it with ordinary settings. */
class TranslationConfigurable : Configurable {
    private val endpoint = JTextField(44)
    private val model = JTextField(36)
    private val key = JPasswordField(36)
    private val language = JTextField(20)
    private val prompt = JTextArea(4, 44)
    private val automatic = JCheckBox("自动翻译打开文件中的注释")
    private val deleteKey = JCheckBox("删除此服务已保存的 Key（无需认证的服务可不配置 Key）")
    private val timeout = JSpinner(SpinnerNumberModel(60, 5, 300, 5))
    private val budget = JSpinner(SpinnerNumberModel(16000, 1000, 200000, 1000))
    private var panel: JPanel? = null

    /** Names the settings page. */
    override fun getDisplayName(): String = "注释译读"

    /** Creates the settings form without reading credentials on the event thread. */
    override fun createComponent(): JComponent {
        val form = JPanel(GridBagLayout())
        var row = 0
        fun add(label: String, component: JComponent) {
            form.add(JLabel(label), GridBagConstraints().apply {
                gridx = 0; gridy = row; anchor = GridBagConstraints.NORTHWEST; insets = Insets(7, 0, 7, 14)
            })
            form.add(component, GridBagConstraints().apply {
                gridx = 1; gridy = row++; weightx = 1.0; fill = GridBagConstraints.HORIZONTAL; insets = Insets(7, 0, 7, 0)
            })
        }
        add("服务地址", endpoint)
        add("模型", model)
        add("API Key", key)
        add("", JLabel("Key 留空保留已有值；保存在 IDE 凭据库，不写入项目。"))
        add("", deleteKey)
        add("目标语言", language)
        prompt.lineWrap = true; prompt.wrapStyleWord = true
        add("附加翻译要求", JScrollPane(prompt))
        add("请求超时（秒）", timeout)
        add("批次字符预算", budget)
        add("", automatic)
        add("", JLabel("配置后注释会发送到此服务；已缓存内容直接复用。"))
        add("", JLabel("工具 → 注释译读 → 打开离线体验示例，无需 API 即可查看效果。"))
        panel = JPanel(BorderLayout()).apply { add(form, BorderLayout.NORTH) }
        reset()
        return panel!!
    }

    /** Detects changes while keeping the saved secret out of the UI. */
    override fun isModified(): Boolean = readForm() != TranslationSettings.getInstance().state || key.password.isNotEmpty() || deleteKey.isSelected

    /** Validates settings and saves credentials in a background task before restarting translation. */
    override fun apply() {
        val next = readForm()
        if (next.baseUrl.isNotBlank()) {
            try { normalizeEndpoint(next.baseUrl) } catch (_: Exception) {
                throw ConfigurationException("请输入 HTTP/HTTPS 服务地址，支持 /v1 或完整 /chat/completions 地址。")
            }
        }
        val password = key.password
        val remove = deleteKey.isSelected
        if ((password.isNotEmpty() || remove) && next.baseUrl.isBlank()) {
            password.fill('\u0000')
            throw ConfigurationException("保存或删除 Key 前请填写服务地址。")
        }
        if (remove) next.automatic = false
        val settings = TranslationSettings.getInstance()
        val sequence = settings.beginSave()
        ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }.forEach { TranslationController.getInstance(it).suspendForConfiguration() }
        key.text = ""; deleteKey.isSelected = false
        TranslationRuntime.getInstance().settingsWorker.submit {
            try {
                // Preserve ordered credential writes: a subsequent blank field means keep the prior key.
                if (remove) PasswordSafe.instance.setPassword(TranslationSettings.attributes(next.baseUrl), null)
                else if (password.isNotEmpty()) PasswordSafe.instance.setPassword(TranslationSettings.attributes(next.baseUrl), String(password))
                if (settings.finishSave(sequence, next)) ApplicationManager.getApplication().invokeLater {
                    ProjectManager.getInstance().openProjects.filterNot { it.isDisposed }.forEach {
                        TranslationController.getInstance(it).configurationChanged()
                    }
                }
            } catch (_: Exception) {
                if (settings.failSave(sequence)) notifyTranslation(null, "配置未保存：无法访问 IDE 凭据库。自动翻译已暂停，请重试。", true)
            } finally { password.fill('\u0000') }
        }
    }

    /** Restores non-secret fields from settings. */
    override fun reset() {
        val state = TranslationSettings.getInstance().state
        endpoint.text = state.baseUrl; model.text = state.model; language.text = state.targetLanguage
        prompt.text = state.prompt; automatic.isSelected = state.automatic
        timeout.value = state.timeoutSeconds.coerceIn(5, 300); budget.value = state.maxBatchChars.coerceIn(1000, 200000)
        key.text = ""; deleteKey.isSelected = false
    }

    /** Clears sensitive input when the settings page closes. */
    override fun disposeUIResources() { key.text = ""; panel = null }

    private fun readForm() = TranslationSettingsState(endpoint.text.trim(), model.text.trim(), language.text.trim().ifEmpty { "简体中文" },
        prompt.text, automatic.isSelected, timeout.value as Int, budget.value as Int)
}
