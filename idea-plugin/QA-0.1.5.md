# 0.1.5 发布前本地验证记录

本文记录 `0.1.5` 发布前的本地构建与验证，新增“原文已符合目标语言”短响应协议。沿用 0.1.4 的逐条请求、可配置并发、输出格式、温度和思考开关。下述结果不代表 GitHub Actions 的执行结果。

## 自动化验证

使用 macOS、IntelliJ IDEA `2026.2.0.1 / 262.8665.337` 和 JDK 25，在仓库根目录执行：

```sh
JAVA_HOME='/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home' \
  idea-plugin/gradlew -p idea-plugin \
  -PlocalIdePath='/Users/parentalzen/Applications/IntelliJ IDEA.app/Contents' \
  test buildPlugin --console=plain
```

结果：**175 项测试，0 失败、0 错误、0 跳过；BUILD SUCCESSFUL**。

本轮新增 13 项测试：

- 8 项客户端 Mock 测试：两种输出模式下的 `{"same":true}`、原文精确恢复、文档标签和重复原文别名；字符串/空值/重复 JSON 键等 16 类无效标识；有界修复、拒绝或截断响应、正常翻译与短响应并发、失败时保留已完成结果、取消后不发布迟到响应；系统提示词覆盖整段语言判定、目标语言变体、混合语言、不确定时正常翻译和附加要求不能覆盖输出契约。
- 2 项真实 SQLite 集成测试：只模拟 HTTP，使用实际客户端和缓存。原文作为成功结果持久化，重建客户端和数据库连接后零 HTTP 命中；既有固定缓存键保持兼容；更换原文或目标语言各自请求并缓存。
- 3 项原生平台测试：同文本结果在原位模式及上下对照模式均不新增显示；相关菜单只对实际变化的译文启用；新同文本结果清除旧译文折叠；Java/XML 混合文件的只读快照保留无需翻译注释的精确空白、缩进和标记。

## 原生 IDEA 与本地 HTTP 验证

将本地构建 ZIP 安装到独立验证配置，服务指向 `127.0.0.1:63093`。打开 SameLanguage.java，未手动触发翻译：

| 注释 | Mock 响应与显示 |
| --- | --- |
| 中文多行文档注释，包含空行与 `@see String` | 只返回 `{"same":true}`，模型消息内容为 13 个 UTF-8 字节；原注释保持原样 |
| 中文行尾注释 | 同样只返回短标识，保留原有语法高亮与行尾文本 |
| 英文注释 | 正常返回 translations，并在原位显示中文译文 |
| 中英混合注释 | 正常返回完整译文，英语说明被替换为中文 |

共 **4 个请求、2 个短标识**，状态为“4 条 · 缓存 0”，不出现重复中文译文。直接只读查询验证环境 SQLite，两个同语记录的 `translated_text` 均与 `original_text` 完全相同。源文件逐字节比较未改变。旧版打开文件仍复用已有缓存。

原生窗口随后出现用户操作提示，因此停止继续操控窗口，没有将本轮桌面“关闭再打开”计为已验证；数据库重开零请求由上述真实 SQLite 集成测试覆盖。本轮没有请求真实 AI 服务，模型实际判断准确率、输入及思考 token 费用未实测；Mock 仅验证协议和本地处理，不证明模型能识别每种语言。

## 原生验证时的本地产物

以下记录对应发布前原生 IDEA 验证实际使用的安装包。验证之后，`plugin.xml` 的介绍文案更新为“逐条并发请求、目标语言识别”，未改变程序逻辑；此后的本地重新打包与 CI 重打包是不同产物。

- 验证时构建包位置：`build/distributions/idea-comment-translator-0.1.5.zip`
- 验证时安装副本位置：仓库根目录 `artifacts/idea-release/idea-comment-translator-0.1.5.zip`；该路径可能被后续构建覆盖
- 发布前原生验证包的 SHA-256：`441a8fedc737dbd10eea203e139295e1ce21f0ddc809cdf7bb571b70cb974068`
- 请求记录：`artifacts/idea-qa/same-language-requests.json`
- 截图：`artifacts/idea-qa/same-language-0.1.5/source-view.png`
- 机器可读记录：`artifacts/idea-release/idea-0.1.5-verification.json`

上述 SHA-256 仅对应元数据文案修订前的原生验证包，不代表修订后的本地包或 CI 发布包。发布工作流在 Linux 上独立重新打包；下载 [0.1.5 Release](https://github.com/puhui999/vscode-translate-plugin/releases/tag/idea-v0.1.5) 的安装包后，应使用同一 Release 附带的 `SHA256SUMS.txt` 校验。

兼容范围为 IDEA `262.8665–262.*`。本记录仅覆盖发布前本地验证；发布状态、CI 测试与发布资产校验需以对应 GitHub Actions 运行及 Release 为准。
