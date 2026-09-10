import { describe, expect, it } from 'vitest';
import { preservesCommentStructure } from '../src/translation/commentStructure';

describe('preservesCommentStructure', () => {
  it.each([
    ['ordinary text', '普通译文，可以调整语序。'],
    ['Contact support@example.com for help.', '请联系 support@example.com 获取帮助。'],
    ['@team@example.com handles support.', '支持团队的联系邮箱是 @team@example.com。'],
    ['Return the value when a < b and b > c.', '当 a < b 且 b > c 时返回结果。'],
    ['A longer explanation.\nAnother sentence.', '合并解释为一段不影响文档结构。'],
    ['@param userId The user ID.\n@returns The profile.', '@param userId 用户标识。\n@returns 用户资料。'],
    ['@param {Map<string, {name: string}>} users User records.', '@param {Map<string, {name: string}>} users 用户记录。'],
    ['@param {string} [name="Guest user"] Display name.', '@param {string} [name="Guest user"] 显示名称。'],
    ['@param string $userId The user ID.', '@param string $userId 用户标识。'],
    ['@param[in,out] buffer Data buffer.', '@param[in,out] buffer 数据缓冲区。'],
    ['@param[in, out] buffer Data buffer.', '@param[in, out] buffer 数据缓冲区。'],
    ['@param <T> The result type.', '@param <T> 结果类型。'],
    ['@template T, U Types.', '@template T,U 类型。'],
    ['@throws {Error} On failure.', '@throws {Error} 失败时抛出。'],
    ['@implements {UserLoader} The loader interface.', '@implements {UserLoader} 加载接口。'],
    ['@customTag Custom documentation text.', '@customTag 自定义文档正文。'],
    ['@throws IOException On IO failure.', '@throws IOException IO 失败时抛出。'],
    ['@see User#find(String, int) For lookup.', '@see User#find(String, int) 用于查找。'],
    ['@see {@link User#find user lookup}', '@see {@link User#find 用户查找}'],
    ['See {@link User#find(String, int) lookup details}.', '参见 {@link User#find(String, int) 查找详情}。'],
    ["See {@link User user's profile} for details.", '详情参见 {@link User 用户资料}。'],
    ['See {@link https://example.test/docs|online docs}.', '参见 {@link https://example.test/docs|在线文档}。'],
    ['Use {@code value == null} as the check.', '使用 {@code value == null} 进行检查。'],
    ["Use {@literal don't} as literal text.", "使用 {@literal don't} 作为字面文本。"],
    ['<summary>Load the user.</summary>\n<param name="userId">User ID.</param>\n<returns>A profile.</returns>', '<summary>加载用户。</summary>\n<param name="userId">用户标识。</param>\n<returns>用户资料。</returns>'],
    ['See <see cref="User.Find"/> and <a href="https://example.test?a=1&b=2">the docs</a>.', '参见 <see cref="User.Find"/> 和 <a href="https://example.test?a=1&b=2">文档</a>。'],
    ['<summary title="a > b">Compare values.</summary>', '<summary title="a > b">比较值。</summary>'],
    ['Render <button type="button" aria-label="Save">the save control</button>.', '显示 <button type="button" aria-label="Save">保存控件</button>。'],
    ['Configure <item xmlns="urn:example" enabled="true"/> before startup.', '启动前配置 <item xmlns="urn:example" enabled="true"/>。'],
  ])('allows translation with preserved structure: %s', (source, translation) => {
    expect(preservesCommentStructure(source, translation)).toBe(true);
  });

  it.each([
    ['@param userId The user ID.', '用户标识。'],
    ['@param userId The user ID.', '@参数 userId 用户标识。'],
    ['@param userId The user ID.', '@param 用户标识 用户标识。'],
    ['@param {string} userId The user ID.', '@param {字符串} userId 用户标识。'],
    ['@param string $userId The user ID.', '@param string $用户 用户标识。'],
    ['@param {string} [name="Guest"] The name.', '@param {string} [name="访客"] 名称。'],
    ['@param[in] buffer Data.', '@param[out] buffer 数据。'],
    ['@returns {User[]} User records.', '@returns 用户记录。'],
    ['@throws IOException On IO failure.', '@throws 异常 IO 失败时抛出。'],
    ['@see User#find(String, int) Details.', '@see User#find(String) 详情。'],
    ['@template T,U Types.', '@template T,V 类型。'],
    ['@param a First.\n@param b Second.', '@param b 第二个。\n@param a 第一个。'],
    ['@param a First.', '@param a 第一个。\n@param a 重复。'],
    ['@returns Result.', '@return 结果。'],
    ['@customTag Custom documentation text.', '自定义文档正文。'],
    ['@customTag Custom documentation text.', '@自定义 自定义文档正文。'],
    ['See {@link User#find user lookup}.', '参见 {@link User#search 用户查找}。'],
    ['See {@link User#find user lookup}.', '参见 User#find 用户查找。'],
    ['See {@link User#find user lookup}.', '参见 {@link User#find 用户查找。'],
    ['Use {@code value == null}.', '使用 {@code value === null}。'],
    ['<summary>Load the user.</summary>', '加载用户。'],
    ['<param name="userId">User ID.</param>', '<param name="用户">用户标识。</param>'],
    ['<see cref="User.Find"/>', '<see cref="User.Search"/>'],
    ['<returns>A user.</returns>', '<return>用户。</return>'],
    ['<summary>Load.</summary>', '<summary>加载。'],
    ['Render <button type="button" aria-label="Save">the control</button>.', '显示 <button type="button" aria-label="保存">控件</button>。'],
    ['Configure <item xmlns="urn:example" enabled="true"/>.', '配置 <item xmlns="urn:example" enabled="false"/>。'],
  ])('rejects missing or changed structure: %s', (source, translation) => {
    expect(preservesCommentStructure(source, translation)).toBe(false);
  });
});
