# 注释译读 · IntelliJ IDEA 验证版

版本 `0.1.0`。在原注释下方显示无边框、多行 AI 译文，原注释始终可见、可编辑。译文使用原生 Block Inlay 随编辑器宽度换行，长译文可在原处展开；保存、撤销、普通复制和 Git diff 仍基于源码。

开发基线为 IntelliJ IDEA `2026.2.0.1 / 262.8665.337`，安装包声明的兼容范围为 `262.8665` 至 `262.*`。当前是 IDEA 预览版，尚未承诺其他 JetBrains IDE 或旧版 IDEA 的兼容性。

## 安装与离线体验

1. 在 [GitHub Releases](https://github.com/puhui999/vscode-translate-plugin/releases) 中查找 `idea-v*` 预发布，下载 `idea-comment-translator-0.1.0.zip`。选择插件 ZIP，无需解压。
2. 在 IDEA 中打开 **Settings → Plugins → 齿轮菜单 → Install Plugin from Disk**，选择 ZIP，按提示完成安装。
3. 打开一个项目，运行 **Tools → 注释译读 → 打开离线体验示例**。示例包含行注释、行尾注释、单行/多行文档注释和长译文；使用固定译文，不调用模型，也不写入翻译缓存。
4. 运行 **Tools → 注释译读 → 配置翻译服务…**，填写自己的服务地址和模型。API Key 如有需要也在此设置。

菜单也可从源码编辑器右键进入，或通过 IDEA 的 Find Action 搜索动作名称。安装与体验不需要额外安装 Node.js。

## 语言与显示范围

| 文件 | 当前支持 |
| --- | --- |
| Java | `//`、`/* */`、单行与多行 Javadoc |
| Kotlin（`.kt`、`.kts`） | 行注释、块注释和 KDoc |
| XML/HTML（含 XSL、XHTML） | 宿主中的 `<!-- -->` 注释；排除属性和 CDATA 等非注释内容 |

注释由 IDE 的 PSI 和词法信息识别，连续相邻的独立行注释可合并翻译。译文恢复原注释的符号、缩进和外壳，校验文档标签、参数名及可识别的 XML/HTML 标记。代码行后的注释也在下方显示译文，原代码保持原样。

每个译文块默认显示最多四行，点击“展开”在原处阅读全文，“收起”恢复预览。将源码光标放在已有译文的注释中，可执行 **展开 / 收起当前译文** 或 **复制当前译文**。这些操作不请求模型。

本版尚未提供 Markdown 全文翻译、JS/TS/Vue 等语言适配，也不翻译 HTML 内嵌 JavaScript/CSS 的注释。通用注释校验保护文档标签与相关标记，不是对所有自然语言内的代码示例、普通 URL 的完整校验。

## 翻译、重试与只读快照

配置就绪且项目受信任时，默认自动翻译打开的受支持文件：先扫描注释、查询 SQLite，再将去重后的缺失项按文件组批发送给模型。不会扫描整个项目。修改文件后撤下旧译文，自动模式会防抖重新扫描；旧请求结果不会覆盖新版本。

- **翻译当前文件注释**：手动翻译、失败重试，或继续下一批未处理注释；成功缓存直接复用。
- **翻译当前注释**：只处理源码光标所在的注释。
- **自动翻译**：控制自动请求；关闭时取消自动触发的任务，保留已完成的译文，仍可手动翻译。手动模式下修改注释后，需再次执行翻译动作。
- **显示 / 隐藏译文**：只改变当前文件的显示，不关闭自动请求，也不删除缓存。
- **打开只读译文**：生成当前文件的只读译文快照，用已有译文替换快照中的对应注释，源文件不变。快照可以选中、复制；不会自动刷新，源文件变化后需重新打开。快照中的行数可能与源码不同。
- **清除本地翻译缓存**：清空缓存、取消已有任务并关闭自动翻译；后续手动或重新开启自动时再请求模型。

同一 IDE 内最多三个后台任务并行，同文件的请求串行执行。自动翻译先准入 500 个去重后的缺失项，缓存命中不占额度，达到上限后可手动继续。验证版单文件上限为 200 万字符；单个完整注释超过批次预算时需提高上限，不会截断注释来强行发送。

## 模型配置与本地缓存

配置入口为 **Settings → Tools → 注释译读**。

| 设置 | 默认值 / 说明 |
| --- | --- |
| 服务地址 | 自定义 HTTP/HTTPS 地址，例如 `https://your-provider.example/v1`、`http://localhost:8000/v1`，也支持完整 `/chat/completions` 地址 |
| 模型 | 服务支持的任意模型 ID |
| API Key | 保存在 IDE 凭据库，按服务地址区分；留空保留该服务已有值，无认证服务可不配置 |
| 目标语言 | 简体中文 |
| 附加翻译要求 | 可填写术语和表达偏好 |
| 请求超时 | 60 秒，可设 5–300 秒 |
| 批次字符预算 | 16,000，可设 1,000–200,000；包含 JSON 数据的字符开销，不等同于模型 token 数 |
| 自动翻译 | 默认开启，服务配置完成后生效 |

接口采用基本 OpenAI Chat Completions 兼容格式，固定非流式请求，通过提示词要求 JSON 并在本地校验 ID 和结构。当前没有 JSON Schema 模式、输出 token 上限或自定义认证头设置；仅提供 Responses 或厂商原生协议的接口需要兼容代理。服务地址不能包含账号、密码、查询参数或片段；请求不自动跟随重定向。

重新打开设置不会显示已保存的 Key。要移除凭据，请勾选“删除此服务已保存的 Key”；删除后自动翻译也会关闭。设置保存期间暂停请求，凭据不写入项目 `.idea`、SQLite、日志或译文页面。

缓存位于 IDE 系统数据目录下的 `puhui-comment-translator/translations.sqlite`，由同一 IDE 的多个项目复用。保存注释原文、译文与非敏感配置标识，默认不按时间过期，最多保留 10,000 条，按使用顺序淘汰。缓存键包含原文、语言、服务地址、模型、目标语言、Prompt 与协议版本；更换 Key 本身不使缓存失效。

IDEA 与 VS Code 使用各自独立的数据库，目前没有跨端缓存导入功能。注释仅在需要翻译时发送到配置的服务；插件不提供额外的中转服务器。

## 构建与验证

准备 JDK 25，并将 `JAVA_HOME` 指向其安装目录。使用仓库自带的 Gradle Wrapper，无需全局安装 Gradle：

```sh
cd idea-plugin
./gradlew test buildPlugin
```

默认从官方仓库解析 IDEA `2026.2.0.1` 及构建依赖。产物为 `build/distributions/idea-comment-translator-0.1.0.zip`；Windows 使用 `gradlew.bat`。

也可指定本机同版本 IDEA，减少下载：

```sh
./gradlew -PlocalIdePath="/path/to/idea" test buildPlugin
```

`localIdePath` 指向 IDE 安装根目录；macOS 为 `.app/Contents`。在隔离开发沙箱中启动插件：

```sh
./gradlew runIde
```

运行沙箱也可传 `-PlocalIdePath`；可选 `-PqaProject="/path/to/test-project"` 指定测试项目。单元测试、平台测试和接口验证使用 Mock 数据或本地 HTTP 服务，不需要模型 Key。测试报告在 `build/reports/tests/test/index.html`，JUnit XML 在 `build/test-results/test/`。

独立的 [IDEA 工作流](../.github/workflows/idea.yml) 在相关分支变更时测试和打包；与 `gradle.properties` 中 `pluginVersion` 一致的 `idea-v*` 标签生成 GitHub 预发布，上传插件 ZIP 与 `SHA256SUMS.txt`。JUnit/HTML 报告作为 Actions 产物保留。该流程不发布到 JetBrains Marketplace。

当前功能范围以本文为准；架构取舍和后续计划见 [IDEA 可行性与方案](../docs/intellij-idea-feasibility.md)。
