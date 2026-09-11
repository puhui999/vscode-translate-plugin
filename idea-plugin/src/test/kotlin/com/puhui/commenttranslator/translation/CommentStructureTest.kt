package com.puhui.commenttranslator.translation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommentStructureTest {
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
