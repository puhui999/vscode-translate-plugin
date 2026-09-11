# IntelliJ IDEA 版可行性与实现方案

调研日期：2026-09-10。基于 VS Code 版 `v0.2.6`（`9e1ba0b`）；工作分支：`codex/intellij-idea`。

本文是实现前的设计与验证计划。本轮已检查现有代码、本机 IDEA 元数据及官方 SDK；尚未创建可安装的 IDEA 插件，也未在 IDEA 中验证译文显示效果。

## 结论与首版范围

**可行。建议使用 Kotlin 开发原生 IntelliJ 插件，延续现有翻译协议、缓存规则和交互，平台接入部分重新实现。** 最大的不确定性是源码编辑器里的多行原位替换；先用离线译文验证显示，再接入已有业务流程。

首版先在本机 IDEA 2026.2.0.1 上完成 Java、Kotlin、XML/HTML 注释与 Markdown 全文只读翻译。其他语言通过通用解析入口逐步验证。不能仅因为同属 IntelliJ 平台，就承诺兼容所有 JetBrains IDE 和语言。

| 现有能力 | IDEA 实现方向 | 可行性与边界 |
| --- | --- | --- |
| 打开文件后自动翻译 | 文件/编辑器事件、设置变更事件、后台扫描 | 高；配置完成时也处理已打开文件 |
| 自定义接口、模型、Key | 原生设置页、JVM HTTP、PasswordSafe | 高；保留 OpenAI Chat Completions 兼容参数 |
| SQLite 查库、只翻译缺失项 | 独立 SQLite JDBC 数据库 | 高；不与 VS Code 共写同一个数据库文件 |
| 按文件批量翻译 | ID 对应协议、去重、按预算拆批 | 高；小文件一批，大文件多批 |
| 无边框只读阅读视图 | 独立阅读标签页，嵌入 JCEF | 高；HTML 布局可复用，主题与消息桥重做 |
| 源码原位显示、悬停原文 | 折叠区域与自定义绘制；按注释形态选择 | 有条件可行；须先验证换行、编辑和现有折叠冲突 |
| Markdown 右键全文翻译 | 编辑器/项目树 Action、独立只读阅读器 | 高；JVM Markdown 解析与结构校验需要移植 |
| 注释符号、文档标签 | 本地恢复外壳、翻译结果结构校验 | 高；保留现有验证边界，不假设 AI 会完全遵守格式 |

## 平台与仓库选择

本机安装元数据确认：IntelliJ IDEA `2026.2.0.1`，build `262.8665.337`，productCode `IU`，随附 JBR `25.0.3`。这是本轮建议的首个验证目标，不代表已经支持该版本。

使用 Kotlin、Gradle Kotlin DSL、IntelliJ Platform Gradle Plugin 2.x。针对 2026.2 的 SDK 使用 JDK 25；Gradle Wrapper 与 Kotlin 编译器选择支持该运行环境的版本并锁定。不要沿用旧教程中针对 2024.x 的 JDK 21 配置。若以后支持较早版本，应改为针对最低目标平台编译，再运行跨版本验证；首个安装包先限定已经实测的 build 范围。[平台版本要求](https://plugins.jetbrains.com/docs/intellij/build-number-ranges.html)、[Gradle 插件](https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html)。

建议保持同仓库，并新增独立目录；以下是后续开发结构，尚未创建：

```text
src/                         # 现有 VS Code 实现
tests/                       # 现有 VS Code 测试
idea-plugin/
  build.gradle.kts
  settings.gradle.kts
  gradle/ + gradlew
  src/main/kotlin/.../
    settings/                # 设置与凭据
    parser/                  # PSI/词法注释提取
    translation/             # HTTP、批次、结构校验
    cache/                   # SQLite JDBC
    editor/                  # 源码展示、原文悬停、编辑保护
    reader/                  # 只读阅读器
    actions/                 # 开关、重试、Markdown 右键入口
  src/main/resources/META-INF/plugin.xml
  src/test/
shared/fixtures/             # 后续提取两端共用的行为样例
```

不依赖用户额外安装 Node.js，也不在 IDE 启动常驻 Node 辅助进程。将 TypeScript 的规则移植到 Kotlin，比维护两套运行时及本地进程通信更适合这个体量。阅读器的 HTML/CSS 可以作为静态资源复用，不能直接调用 VS Code Webview 接口。

## 注释解析与语言覆盖

现有 [commentParser.ts](../src/parser/commentParser.ts) 自带 TextMate 语法；IDEA 版优先利用 IDE 已安装语言插件提供的 PSI 和词法信息。

1. 在后台可取消的读操作中提取 `PsiComment`、范围和原始文本；必要时通过该语言 `ParserDefinition.getCommentTokens()` 与 lexer 补充识别。
2. Java 文档注释、Kotlin KDoc、XML/HTML 注释保留专门的边界测试。不能假设所有语言的文档注释都实现相同 PSI 接口。
3. HTML/Vue 等多语言文件，需要处理宿主与嵌入语言范围，并统一映射、去重。属性、字符串、CDATA、模板正文中的伪注释不得发送翻译。
4. 仅合并相邻的独立行注释；不跨代码合并。范围不包含注释前的外部缩进，保留块内缩进与原始标记，覆盖本次修复的 `/** Description. */` 情况。
5. 没有可靠语言解析支持时保留原文并提示原因；不直接对整个文件执行 `//.*` 一类正则。后续如需补足语言，再评估独立词法适配器。

PSI 的解析模型和注释 token 定义由语言支持提供，不等于任意文件后缀都能正确提取。[PSI](https://plugins.jetbrains.com/docs/intellij/psi.html)、[ParserDefinition 与注释 token](https://plugins.jetbrains.com/docs/intellij/implementing-parser-and-psi.html)。

| 覆盖阶段 | 语言/文件 | 验证重点 |
| --- | --- | --- |
| 首批 | Java、Kotlin | `//`、`/* */`、单行与多行 Javadoc/KDoc、标签、Tab/空格缩进 |
| 首批 | XML、HTML | `<!-- -->`、行内注释、CDATA/属性排除、嵌入脚本与样式 |
| 首批 | Markdown | 右键手动全文翻译，只读显示；不自动发送整个文件 |
| 扩展 | JS/TS/JSX/TSX、CSS/SCSS、Vue、SQL、Shell 等 | 按当前 IDE 中可用的语言支持逐项认证 |
| 后续另行评估 | C/C++、Go、Rust、C# 等 | 不能承诺 IDEA 内直接覆盖；CLion/GoLand/RustRover/Rider 需独立适配与验证 |

Python 延续当前范围，暂不支持；docstring 不自动当成注释。语言相关依赖按需声明，不能因为支持 Java，就让缺少 Java 模块的产品加载 Java 专用类。[平台与语言依赖](https://plugins.jetbrains.com/docs/intellij/plugin-compatibility.html)。

## 源码视图：先验证显示，再决定最终实现

IntelliJ 的 Inlay 可以添加虚拟内容，折叠模型可以在不修改文档的情况下隐藏范围，但两者不是直接等价于 VS Code Decoration。原生自定义绘制需要负责字体、缩进、缩放、主题、换行与鼠标命中。

拟验证以下两种路径：

- **短行/行尾/夹在代码中的注释**：普通 fold placeholder 显示格式化后的译文，隐藏范围严格限定到注释；保护同一行前后的代码。普通占位符中的换行会被编辑器替换为空格，不能用它实现多行译文，也不依赖其内部自动换行。长译文的阅读体验、折叠外观能否满足无边框要求，必须实测。[编辑器对占位符的处理](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/openapi/editor/impl/view/EditorView.java)。
- **整行独立注释和多行文档注释**：评估 `CustomFoldRegion` 自定义绘制，在被隐藏的整行区域里按实际宽度绘制多行译文。它只能覆盖完整文档行，不能直接用于包含业务代码的整行范围；区域不能普通展开，恢复原文需要移除后按需重建。相关 API 目前标记为 `Experimental`，必须封装适配层并做指定版本验证。[CustomFoldRegion](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/CustomFoldRegion.java)、[FoldingModel](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/FoldingModel.java)。

Inlay 的定位是附加内容，单独使用不会隐藏原注释。因此，不能在可行性阶段承诺所有原位译文都能自动换行。最先用 Java 离线样例验证这些边界，再决定是否将多行自定义折叠纳入首版。[InlayModel](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/InlayModel.java)。

源码模式必须满足以下行为：

- 显示 `//`、`/** */`、`<!-- -->`、块内 `*`、文档标签和原有缩进。
- 悬停展示原文；编辑光标或选择进入对应注释时恢复原文，移出后恢复译文。
- 保存、撤销、搜索、复制以及 Git diff 基于真实源文件；另设“复制译文”动作时才复制译文。
- 修改文件后先清理旧显示，再用新版本结果更新；多个编辑器共享翻译结果，但各自管理展示资源。
- 不修改用户的全局代码折叠或文档渲染设置；只管理插件自己创建的区域，遇到无法共存的区域恢复原文并提供阅读视图入口。
- 不通过写入源 `Document` 再撤销、替换文件、透明字体遮挡代码等方式制造原位效果。

IDEA 自带的文档注释渲染只能作为集成点候选；它不覆盖普通行注释、所有 HTML/XML 注释及 Markdown 全文，不能承担整套显示方案。

## 只读阅读视图与 Markdown

建议用独立阅读标签页承载 `JBCefBrowser`。沿用当前无边框排版：独立注释上下对照，行尾注释在代码行末追加；支持点击原始行号返回源码。复用 [readerContent.ts](../src/readerContent.ts) 和 [markdownReaderContent.ts](../src/markdownReaderContent.ts) 的布局规则，替换 `--vscode-*` 主题变量和 `acquireVsCodeApi()` 消息桥。

使用前检测 JCEF 可用性。不可用时提供只读文本阅读器，避免整个翻译功能失效。页面资源本地加载；外部图片、脚本、链接导航和消息入口按现有阅读器的安全边界处理，不能因为渲染 Markdown 而自动访问外部资源。[JCEF 官方接入](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html)。

Markdown 继续仅由编辑器或项目树右键触发。选择 JVM Markdown 解析器后移植现有完整块拆分与结构校验：代码围栏、行内代码、URL、引用、元数据与源文件换行需要分别验证。不能用简单正则替代 [markdown.ts](../src/markdown.ts) 的行为，也不直接依赖 IDEA Markdown 插件的内部实现类。

## 翻译、缓存和生命周期

```text
文件打开 / 配置完成 / 注释发生修改
  → 后台读取当前文档快照与注释范围
  → 按内容和配置查询 SQLite
      命中：立即显示
      缺失：去重 → 按文件组批 → AI 翻译
  → 按 ID 校验、恢复格式
  → 检查文件版本与任务代次
  → 保存有效译文并更新当前编辑器/阅读器
```

保留现有 [translation/index.ts](../src/translation/index.ts) 的 `{comments: [{id, text}]}` / `{translations: [{id, text}]}` 协议；只发送缺失内容，按 ID 对应，不依赖响应顺序。单文件按批次串行、全局最多三个文件同时翻译，自动翻译预算沿用 500 个去重后的缺失项，之后手动继续。小文件一次请求；大文件根据预算拆批，不能承诺任意大小文件都压进一个请求。

自动翻译仅在开关开启、配置有效且项目可信时执行，范围是当前打开且可见的源码及阅读器关联文件，不扫描整个项目。完整文件扫描与批量请求只在内容/配置变化等事件触发；滚动仅更新可见区域上下 10 行的展示，不重新调用 AI。沿用 600ms 编辑防抖，停用翻译时取消排队与进行中任务。

保留接口地址与模型自由配置、可选 Key、通用文本 JSON / JSON object / JSON schema 模式，以及 `max_tokens` / `max_completion_tokens` / 不发送上限参数的选择。HTTP 重试、无效响应拆批、缺失项单独修复的上限沿用现有规则。成功部分可先显示；失败、重复或未知 ID 不进入成功缓存。使用可取消的 JVM HTTP 实现，并验证 IDE 代理设置与本地兼容服务访问。

端点、模型、目标语言、自定义 Prompt 和开关使用原生持久化设置；API Key 在设置页用密码字段编辑，通过 `PasswordSafe` 保存，按规范化服务地址区分凭据。Key 不进入项目 `.idea` 文件、SQLite、日志或页面脚本。凭据读写和网络请求都不在 UI 线程执行。[设置持久化](https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html)、[PasswordSafe](https://plugins.jetbrains.com/docs/intellij/persisting-sensitive-data.html)。

后台扫描只持有短暂读锁，生成不可变快照后释放锁，再查库和请求网络。更新前检查 `Document.modificationStamp`、任务代次、项目/编辑器生命周期与配置版本；关闭文件、关闭翻译或切换服务后取消任务，并丢弃迟到结果。网络和数据库操作不得放入 PSI 读锁、绘制回调或 UI 线程。[线程与读操作规则](https://plugins.jetbrains.com/docs/intellij/threading-model.html)。

缓存实现建议：

- 使用插件独立的 SQLite JDBC 数据库，保存在 IDE 用户数据目录；事务写入、忙等待上限与容量清理集中管理。应用级服务让同一 IDE 进程的多个项目复用。
- 沿用当前缓存字段和默认策略：原文、译文、统一语言 ID、规范化服务地址、模型、目标语言、Prompt 版本/内容哈希、创建/访问时间；默认不按时间过期，10,000 条容量淘汰，可选 TTL。
- 沿用 `SHA-256(UTF-8(JSON 数组))` 键语义。跨端一致需要固定 JSON 转义、端点规范化和语言 ID 样例，不能直接用 IDEA 的 `Language.id` 替代现有 ID。
- **不让 JDBC 与现有 sql.js 共写一个文件。** 现有 [cache.ts](../src/core/cache.ts) 使用自建 `.lock` 加整库导出和原子替换，JDBC 不遵循这套锁。后续复用已有译文应采用一致快照导入或中立格式导入，并重新校验。
- SQLite JDBC 包含原生库，需要验证 macOS ARM64、Windows/Linux 目标架构的加载，以及插件关闭时连接与资源释放。[SQLite JDBC 官方说明](https://github.com/xerial/sqlite-jdbc)。

## 复用边界与验收

可移植的是协议、规则与样例；现有 TypeScript 编译产物不能作为 JVM 插件直接使用。`controller.ts`、`renderer.ts`、`reader.ts` 的 VS Code 生命周期和 UI 接口必须重写；TextMate/WASM、sql.js、Node HTTP、markdown-it 的运行时实现也必须替换。

从现有 `tests/` 提取以下共享 JSON 夹具，保持两端行为一致：

| 夹具来源 | IDEA 版必须验证 |
| --- | --- |
| `parser.test.ts`、`commentFormat.test.ts` | 精确注释范围、单行文档注释、标签与缩进、嵌套/未知格式回退、Unicode |
| `translation.test.ts`、`commentStructure.test.ts` | URL/参数规范化、ID 乱序与异常、部分成功、重试上限、文档结构校验 |
| `cache.test.ts` | 缓存键、跨文件复用、TTL、容量清理、损坏库保护；另补 JDBC 事务测试 |
| `scheduler.test.ts`、`controller.test.ts` | 每文件串行、全局并发、取消、迟到响应、文件版本与配置变更 |
| `markdown.test.ts` | 完整块拆分、引用与代码保留、结构变更拒绝、CRLF 与源范围 |

现有普通注释结构校验保护文档标签及相关标记，不保证所有普通 URL、代码示例都完全不变；Markdown 有更严格的独立校验。移植时保留这一区别。请求字符预算、UTF-8 响应字节上限、emoji/组合字符的拆行也必须有跨语言样例。

Kotlin 公共方法编写 KDoc；注释提取与格式恢复保持至少 90% 的测试覆盖率目标。测试数量重新按 IDEA 实现统计，不能把 VS Code 版的 511 项测试视为 IDEA 已通过的验证。

## 实施顺序与完成标准

1. **显示原型**：用固定译文验证 Java 的独立行、行尾、单行/多行 Javadoc、行内块注释；检查无边框效果、换行、主题/缩放、原文悬停、光标进出、代码折叠和文档渲染冲突。保存内容与修改标记必须不变。此阶段不调用 AI。
2. **可用首版**：设置、凭据、自动扫描、批量 HTTP、SQLite、状态与取消；完成 Java/Kotlin/XML/HTML，并接上只读阅读视图。未改动注释再次打开时，缓存命中不得重复调用模型。
3. **Markdown 与语言扩展**：移植全文分块和校验，加入编辑器/项目树右键，逐项验证其他可用语言；补齐跨平台打包与兼容性检查。
4. **交付**：单元与平台集成测试使用 Mock 服务；在隔离 IDEA 沙箱验证真实编辑、悬停、关闭重开和缓存持久化，再生成 ZIP。原位显示未通过的场景要明确披露，不能算作完整支持。

## 构建、发布与更新

IDEA 单独使用 `test`、`verifyPlugin`、`buildPlugin` 等 Gradle 任务，产出插件 ZIP，通过 **Settings → Plugins → Install Plugin from Disk** 安装。Plugin Verifier 验证二进制兼容性，不能替代真实编辑器显示测试。

后续新增 IDEA 工作流和独立标签 `idea-v0.1.0` 等；现有 VS Code 发布监听 `v*`，使用 `idea-v*` 可避免触发 VSIX 发布流程。两个平台各自维护版本、说明与产物，不修改 VS Code 的 `0.2.6` 版本号。

IDEA 也支持自定义插件更新仓库：GitHub Release 提供 ZIP，稳定 HTTPS 地址提供 `updatePlugins.xml`，用户在插件仓库设置中添加该地址后，可以在插件管理中检查更新，无需先上架 Marketplace。更新索引须在 ZIP 发布成功后更新，并与插件 ID、版本和 IDE build 范围一致。本轮只记录方案，不配置更新源。[自定义插件仓库](https://plugins.jetbrains.com/docs/intellij/custom-plugin-repository.html)。
