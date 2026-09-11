package com.puhui.commenttranslator.translation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommentStructureTest {
    @Test fun acceptsCompleteJavaDocWithNaturalChineseInlineOrderAndLeadingReturnLink() {
        assertTrue(preservesCommentStructure(ChatClientJavadocFixture.source, ChatClientJavadocFixture.translation))
    }

    @Test fun allowsInlineOrderAndLabelsWithinTheSameDocumentationSection() {
        listOf(
            "Creates a {@link Builder} for a {@link ChatClient}." to "创建 {@link ChatClient} 的 {@link Builder}。",
            "@return a new {@link Builder}" to "@return {@link Builder} 的新实例",
            "@return {@link Builder a builder}" to "@return {@link Builder 构造器}",
            "@return a new {@link List<String> list}" to "@return {@link List<String> 列表} 的新实例",
            "@return a new {@code List<String>}" to "@return {@code List<String>} 的新实例",
            "Use {@code List<T>} and {@code Map<K, V>}." to "使用 {@code Map<K, V>} 和 {@code List<T>}。",
            "See {@link List<T> list} and {@link Set<U> set}." to "参见 {@link Set<U> 集合} 和 {@link List<T> 列表}。",
            "Read {@literal <T>} then {@literal <U>}." to "读取 {@literal <U>} 和 {@literal <T>}。",
            "@param value Uses {@link First} and\n{@link Second}.\n@return {@link Result}" to
                "@param value 使用 {@link Second} 和 {@link First}。\n@return {@link Result}",
            "<param name=\"value\">Uses {@link First} and {@link Second}.</param>" to
                "<param name=\"value\">使用 {@link Second} 和 {@link First}。</param>",
            "<p>Uses {@link First} and {@link Second}.<p>Other text." to
                "<p>使用 {@link Second} 和 {@link First}。<p>其他文本。",
            "See {@link List<T> <b>the list</b>}." to "参见 {@link List<T> <b>列表</b>}。",
        ).forEach { (source, translated) -> assertTrue(source, preservesCommentStructure(source, translated)) }
    }

    @Test fun rejectsChangedInlineCountsTargetsOrDocumentationSectionOwnership() {
        listOf(
            "See {@link First} and {@link Second}." to "参见 {@link First}。",
            "See {@link First} and {@link Second}." to "参见 {@link First} 和 {@link First}。",
            "See {@link First} and {@link Second}." to "参见 {@link Second}、{@link First} 和 {@link First}。",
            "See {@link First} twice: {@link First}." to "参见 {@link First}。",
            "See {@link First} and {@link Second}." to "参见 {@link Third} 和 {@link First}。",
            "Use {@code List<T>} and {@code Set<U>}." to "使用 {@code Set<T>} 和 {@code List<T>}。",
            "See {@link First}.\n@param value Input." to "说明。\n@param value 参见 {@link First}。",
            "@param first See {@link One}.\n@param second See {@link Two}." to
                "@param first 参见 {@link Two}。\n@param second 参见 {@link One}。",
            "@param first See {@link One}.\n@param second See {@link Two}." to
                "@param first 参见 {@link One} 和 {@link Two}。\n@param second 第二个。",
            "@param value See {@link One}.\n@return Result." to "@param value 输入。\n@return 参见 {@link One}。",
            "<param name=\"a\">See {@link One}.</param><param name=\"b\">See {@link Two}.</param>" to
                "<param name=\"a\">参见 {@link Two}。</param><param name=\"b\">参见 {@link One}。</param>",
            "<p>See {@link One}.<p>See {@link Two}." to "<p>参见 {@link One} 和 {@link Two}。<p>其他。",
            "See {@link List<T> <b>the list</b>}." to "参见 {@link List<T> <i>列表</i>}。",
            "See {@link List<T> <b>the list</b>}." to "参见 {@link List<T> 列表}。",
            "<summary>Use {@code List<T>}.</summary>" to "<returns>使用 {@code List<T>}。</returns>",
            "<summary>Use {@code List<T>}.</summary>" to "使用 {@code List<T>}。",
            "<summary>Use {@code List<T>}.</summary>" to "<summary>使用 {@code List<T>}。</summary><T>",
            "@returns {List<string>} The list." to "@returns {List<number>} 列表。",
            "@return string A name." to "@return int 名称。",
            "@return {Builder} A builder." to "@return {@link Builder} 构造器。",
        ).forEach { (source, translated) -> assertFalse(source, preservesCommentStructure(source, translated)) }
    }

    @Test fun treatsInlineMarkupAndBlankLinesAsPartOfTheCompleteInlineToken() {
        listOf(
            "See {@link A <b>the A</b>} and {@link B}." to "参见 {@link B} 和 {@link A <b>A</b>}。",
            "See {@link A first\n\nlabel} and {@link B}." to "参见 {@link B} 和 {@link A 标签}。",
            "Use {@code first\n\nsecond} and {@link B}." to "使用 {@link B} 和 {@code first\n\nsecond}。",
            "Use {@code first\r\n\r\nsecond} and {@link B}." to "使用 {@link B} 和 {@code first\r\n\r\nsecond}。",
        ).forEach { (source, translated) -> assertTrue(source, preservesCommentStructure(source, translated)) }
        assertFalse(preservesCommentStructure(
            "See {@link A <b>the A</b>} and {@link B}.", "参见 {@link B} 和 {@link A <i>A</i>}。",
        ))
    }

    @Test fun keepsBlankLineParagraphOwnershipWithoutTreatingSingleLineEndingsAsParagraphs() {
        for (newline in listOf("\n", "\r\n", "\r")) {
            assertTrue(preservesCommentStructure(
                "See {@link A} and${newline}{@link B}.", "参见 {@link B} 和${newline}{@link A}。",
            ))
            assertFalse(preservesCommentStructure(
                "First {@link A}.$newline${newline}Second {@link B}.",
                "第一段 {@link B}。$newline${newline}第二段 {@link A}。",
            ))
            assertFalse(preservesCommentStructure(
                "First {@link A}.$newline \t ${newline}Second {@link B}.",
                "第一段 {@link B}。$newline \t ${newline}第二段 {@link A}。",
            ))
            assertTrue(preservesCommentStructure(
                "First {@link A} and {@link B}.$newline${newline}Second {@link C}.",
                "第一段 {@link B} 和 {@link A}。$newline${newline}第二段 {@link C}。",
            ))
        }
    }

    @Test fun acceptsTranslatedDescriptionsWithPreservedTagsOperandsAndMarkup() {
        listOf(
            "Contact a@example.test when a < b." to "当 a < b 时联系 a@example.test。",
            "@param {Map<string, {name: string}>} users User records." to "@param {Map<string, {name: string}>} users 用户记录。",
            "@param {string} [name=\"Guest user\"] Display name." to "@param {string} [name=\"Guest user\"] 显示名称。",
            "@param string \$userId User ID." to "@param string \$userId 用户标识。",
            "@param[in, out] buffer Data." to "@param[in, out] buffer 数据。",
            "@template T, U Types." to "@template T,U 类型。",
            "@throws IOException On IO failure." to "@throws IOException IO 失败时。",
            "@see User#find(String, int) Details." to "@see User#find(String, int) 详情。",
            "See {@link User#find(String, int) lookup}." to "参见 {@link User#find(String, int) 查找}。",
            "See {@link User user's profile}." to "参见 {@link User 用户资料}。",
            "Use {@code value == null}." to "使用 {@code value == null}。",
            "Use {@literal don't}." to "使用 {@literal don't}。",
            "<summary title=\"a > b\">Compare.</summary>" to "<summary title=\"a > b\">比较。</summary>",
            "<param name=\"userId\">User ID.</param>" to "<param name=\"userId\">用户标识。</param>",
            "@customTag Description." to "@customTag 说明。",
        ).forEach { (source, translated) -> assertTrue(source, preservesCommentStructure(source, translated)) }
    }

    @Test fun rejectsChangedMissingDuplicatedOrReorderedProtectedSyntax() {
        listOf(
            "@param userId User ID." to "@param 用户 用户标识。",
            "@param {string} userId User ID." to "@param {字符串} userId 用户标识。",
            "@param [name=\"Guest\"] Name." to "@param [name=\"访客\"] 名称。",
            "@param[in] buffer Data." to "@param[out] buffer 数据。",
            "@throws IOException Failure." to "@throws Exception 失败。",
            "@param a First.\n@param b Second." to "@param b 第二。\n@param a 第一。",
            "@param a First." to "@param a 第一。\n@param a 第一。",
            "@see User#find(String, int) Details." to "@see User#find(String) 详情。",
            "See {@link User#find lookup}." to "参见 {@link User#delete 查找}。",
            "Use {@code value == null}." to "使用 {@code value === null}。",
            "See {@link User#find lookup}." to "参见 {@link User#find 查找。",
            "<param name=\"userId\">User ID.</param>" to "<param name=\"用户\">用户标识。</param>",
            "<summary>Read.</summary>" to "<summary>读取。",
            "Render <button aria-label=\"Save\">the control</button>." to "显示 <button aria-label=\"保存\">控件</button>。",
            "@customTag Description." to "说明。",
        ).forEach { (source, translated) -> assertFalse(source, preservesCommentStructure(source, translated)) }
    }
}

/** Shared regression example with unchanged JavaDoc tags and naturally reordered Chinese prose. */
internal object ChatClientJavadocFixture {
    val source = """
        Creates a {@link Builder} for constructing a {@link ChatClient}.
        <p>
        When {@code toolCallingAdvisorBuilder} is {@code null}, a default
        {@link org.springframework.ai.chat.client.advisor.ToolCallingAdvisor} is created
        with a {@link org.springframework.ai.model.tool.ToolCallingManager} backed by the
        supplied {@code observationRegistry}.
        <p>
        When {@code toolCallingAdvisorBuilder} is non-null it is used as-is. The caller is
        then responsible for configuring the builder's
        {@link org.springframework.ai.model.tool.ToolCallingManager}, including any
        {@link io.micrometer.observation.ObservationRegistry}, since the supplied
        {@code observationRegistry} will not be automatically applied to it.
        @param chatModel the chat model to use
        @param observationRegistry the observation registry for client-level observations;
        also used to configure the default {@code ToolCallingManager} when
        {@code toolCallingAdvisorBuilder} is {@code null}
        @param chatClientObservationConvention optional custom observation convention for
        the chat client
        @param advisorObservationConvention optional custom observation convention for
        advisors
        @param toolCallingAdvisorBuilder optional builder for the
        {@link org.springframework.ai.chat.client.advisor.ToolCallingAdvisor}; when
        {@code null} a default is created
        @return a new {@link Builder}
    """.trimIndent()

    val translation = """
        创建用于构建 {@link ChatClient} 的 {@link Builder}。
        <p>
        当 {@code toolCallingAdvisorBuilder} 为 {@code null} 时，创建默认的
        {@link org.springframework.ai.chat.client.advisor.ToolCallingAdvisor}，
        其中使用的 {@link org.springframework.ai.model.tool.ToolCallingManager} 由
        传入的 {@code observationRegistry} 提供支持。
        <p>
        当 {@code toolCallingAdvisorBuilder} 非空时，直接使用它。此时调用方
        负责配置构建器的
        {@link org.springframework.ai.model.tool.ToolCallingManager}，包括任何
        {@link io.micrometer.observation.ObservationRegistry}，因为传入的
        {@code observationRegistry} 不会自动应用到该管理器。
        @param chatModel 使用的聊天模型
        @param observationRegistry 用于客户端级观测的观测注册表；
        当 {@code toolCallingAdvisorBuilder} 为 {@code null} 时，
        也用于配置默认的 {@code ToolCallingManager}
        @param chatClientObservationConvention 可选的自定义观测约定，
        用于聊天客户端
        @param advisorObservationConvention 可选的自定义观测约定，
        用于顾问
        @param toolCallingAdvisorBuilder 用于
        {@link org.springframework.ai.chat.client.advisor.ToolCallingAdvisor} 的可选构建器；
        为 {@code null} 时创建默认构建器
        @return {@link Builder} 的新实例
    """.trimIndent()
}
