# IDEA 0.1.6 文档注释校验验证

验证环境：IntelliJ IDEA 2026.2.0.1（262.8665.337），JDK 25。

用户提供的 ChatClient.builder 完整 JavaDoc 已作为 ChatClientJavadocFixture 保存。旧实现对合法中文首句中 Builder/ChatClient 的引用倒装、以及 @return 后直接出现链接的写法会误拒；修复前的回归复现了失败，修复后完整中文译文一次 Mock 请求通过。该注释正文约 1,311 字符，低于默认 16,000 字符输入预算。

验证包含引用数量、目标、代码内容、参数归属、HTML/XML 标签、链接标签内样式及空行自然段的保护，以及 LF/CRLF/CR 换行。真正的文档结构错误、响应缺失及 finish_reason=length 分别返回独立错误类型；成功项保留，失败项不缓存。

翻译客户端使用 Mock 响应，未读取用户当次真实模型响应。本记录证明插件存在并修复了可确定复现的误判，不推断服务当次具体输出。

`test buildPlugin`：183 项测试通过，0 失败、0 错误、0 跳过。

安装包：`build/distributions/idea-comment-translator-0.1.6.zip`，manifest 版本 0.1.6，兼容范围仍为 262.8665 至 262.*。

SHA-256：`75aadbe6150a60833a5a2ef916449bebdb215538483feea3d2524011fc97c51d`。
