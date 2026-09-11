# IntelliJ IDEA 版可行性与实现方案

调研日期：2026-09-10。基于 VS Code 版 `v0.2.6`（`9e1ba0b`）；工作分支：`codex/intellij-idea`。

本文是实现前的设计与验证计划。已检查现有代码、本机 IDEA 元数据及官方 SDK；尚未创建可安装的 IDEA 插件，也未在 IDEA 中验证译文显示效果。设计原则已根据用户反馈调整：IDEA 独立设计，以阅读和编辑体验为目标，不要求与 VS Code 版逐项保持一致。

## 结论与首版范围

**可行。建议使用 Kotlin 开发原生 IntelliJ 插件，默认在源码注释下方显示无边框、多行、可展开的译文。** 保留原注释直接编辑，日常阅读留在原生编辑器；长文档和 Markdown 再主动打开阅读器。AI、缓存与结构保护规则可以复用，交互与平台实现独立设计。

默认显示使用 block Inlay，不把实验性的原位替换作为首版前提。首个原型重点验证多行排版、阅读位置稳定、输入与折叠的配合，而不是复现 VS Code 的视觉替换手法。

首版先在本机 IDEA 2026.2.0.1 上完成 Java、Kotlin、XML/HTML 注释与 Markdown 全文只读翻译。其他语言通过通用解析入口逐步验证。不能仅因为同属 IntelliJ 平台，就承诺兼容所有 JetBrains IDE 和语言。

| 现有能力 | IDEA 实现方向 | 可行性与边界 |
| --- | --- | --- |
| 打开文件后自动翻译 | 文件/编辑器事件、设置变更事件、后台扫描 | 高；配置完成时也处理已打开文件 |
| 自定义接口、模型、Key | 原生设置页、JVM HTTP、PasswordSafe | 高；保留 OpenAI Chat Completions 兼容参数 |
| SQLite 查库、只翻译缺失项 | 独立 SQLite JDBC 数据库 | 高；不与 VS Code 共写同一个数据库文件 |
| 按文件批量翻译 | ID 对应协议、去重、按预算拆批 | 高；小文件一批，大文件多批 |
| 日常源码译读 | 原注释下方 block Inlay，自定义多行排版 | 高；无需隐藏原文，换行与鼠标命中需自行实现并实测 |
| 长文档阅读 | 用户主动打开独立只读标签页 | 高；使用适合长文的排版，不强制复刻现有页面 |
| 仅显示译文的原位模式 | 后续可选探索 | 非首版前提；实验性折叠 API 与编辑行为需要额外验证 |
| Markdown 右键全文翻译 | 编辑器/项目树 Action、独立只读阅读器 | 高；JVM Markdown 解析与结构校验需要移植 |
| 注释符号、文档标签 | 本地恢复外壳、翻译结果结构校验 | 高；保留现有验证边界，不假设 AI 会完全遵守格式 |

## 产品目标与默认体验

设计读取：面向长时间阅读、修改源码的开发者，采用 IDEA 原生工具的交互与视觉语言。沿用当前编辑器主题、字体、行距和缩进，不另设品牌化编辑器皮肤。设计参数为视觉变化 2/10、动效 1/10、信息密度 7/10：保持熟悉的编辑器，只增加读懂注释所需的信息。

体验优先级：读懂内容、保持当前阅读位置、正常编辑、控制信息密度、减少重复请求。与另一平台外观一致不作为验收目标。

| 场景 | 推荐行为 | 选择理由 |
| --- | --- | --- |
| 日常看代码 | 原注释保留，在每个逻辑注释组下方显示一个无边框译文块 | 原文与译文就近对应，输入与选择沿用原生行为 |
| 短行尾注释 | 译文放在该源码行下方，按代码缩进对齐 | 避免向右挤压代码、长译文或窄分栏导致横向滚动 |
| 同行多个注释 | 按原文顺序在一个行下区域分项展示，可定位对应注释 | 防止多个浮层重叠或无法辨认译文对应关系 |
| 长注释 | 初始显示至多四个排版行，明确提供“展开全文”；在原处完整展开 | 兼顾信息密度，不使用悬浮滚动框或嵌套滚动条；四行为原型起始值，按实测调整 |
| 大量文档注释、Markdown | 主动打开阅读标签页，支持原文/译文切换和返回源码 | 长文有充足排版空间，不自动抢走编辑器焦点 |
| 只想看原代码 | 文件级“显示/隐藏译文”动作 | 切换只改变显示，不清缓存、不重新请求 AI |
| 偶尔查一条注释 | 编辑器右键或可配置快捷键翻译当前注释 | 自动翻译关闭时也有直接入口，不必启用整个文件 |

译文保留注释外壳和文档标签，如 `//`、`/** */`、`<!-- -->`、`*`、`@param` 与参数名。允许译文按阅读宽度重新排版，不要求译文行数和源文相同。普通复制仍复制源码；“复制译文”是明确的独立动作。

把“显示译文”和“自动翻译”分开：前者控制可见性，后者控制是否自动发请求。停止自动翻译会取消自动任务，已完成且仍匹配当前内容的译文可保留；隐藏译文不会改变自动翻译设置。命令名称和状态提示明确表达各自作用。

常用入口只保留显示开关、自动翻译开关、当前注释翻译和阅读全文。模型配置、缓存管理、失败重试放在原生设置/状态菜单，避免每条注释常驻一排按钮。展开、收起、鼠标移动和阅读器切换均不触发 AI 请求。

## 状态与体验验收

| 状态或操作 | 可见反馈与恢复行为 |
| --- | --- |
| 未配置 | 文件级状态提示“配置翻译服务”；不连续弹窗，不发请求 |
| 缓存命中 | 合并显示匹配的译文，状态可查看命中数量，不逐条播放动画 |
| 翻译中 | 文件级进度，原代码可继续编辑；已经成功的译文保留 |
| 部分失败 | 标明失败数量和“重试未完成”；有效项不重复付费 |
| 编辑注释 | 只将受影响块的旧译文标记失效或清理，防抖后更新；单纯移动光标不反复隐藏/重建译文 |
| 展开/收起 | 不移动源码光标、不改变选择、不产生源码修改标记；焦点可通过键盘到达相同动作 |
| 结果到达 | 批次合并更新，维护当前源码阅读锚点；静止视口上方插入内容时，锚点偏移目标不超过一行 |
| 连续滚动 | 不因进入/离开视口反复增加、删除已有区域高度，不强制跳回旧阅读位置 |
| 代码折叠 | 被隐藏源码对应的译文一并隐藏；展开后恢复且不重复创建，插件关闭不改变用户原有折叠状态 |
| IDE 文档渲染开启 | 验证具体组合，避免原文渲染、原注释和译文三份叠加；不修改全局设置 |

自绘译文不会自动获得原生文本选择和屏幕阅读器能力。首版提供可通过键盘调用的“复制当前译文”和可选择文本的只读阅读入口；在实际 IDE 中验证可访问性，不把画出来的文字当作已经具备完整编辑器行为。

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

不依赖用户额外安装 Node.js，也不在 IDE 启动常驻 Node 辅助进程。将 TypeScript 的规则移植到 Kotlin，比维护两套运行时及本地进程通信更适合这个体量。阅读器的 HTML/CSS 可作为实现参考，但不为复用而固定其排版；不能直接调用 VS Code Webview 接口。

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

## 源码视图：原生 block Inlay

`InlayModel.addBlockElement()` 可以在源码行间插入视觉区域；`EditorCustomElementRenderer` 提供宽度、高度和绘制入口，没有强制边框，也不要求 block 高度为单行。这适合将译文放在注释结束行下方，同时保持源 `Document` 不变。[InlayModel](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/InlayModel.java)、[Renderer API](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/EditorCustomElementRenderer.java)。

实现要求：

1. 原文与译文保持映射，外部缩进按源代码计算；同一逻辑注释组只创建一个 block。
2. 插件按当前 viewport 可用宽度排版，不能采用可能被长代码撑大的 content component 宽度。读取当前 editor 的字体、字号、行距，并使用一致的测量与绘制上下文。
3. 换行不是平台自动完成。可用 `TextLayout` / `LineBreakMeasurer` 生成布局，按实际像素计算高度；单独处理 Tab、段落换行、中英混排与 Unicode 组合字符。[Java 文字排版](https://docs.oracle.com/en/java/javase/25/docs/api/java.desktop/java/awt/font/LineBreakMeasurer.html)。
4. 结果、分栏宽度、字号等变化后重新计算布局并调用 `inlay.update()`；仅颜色变化可重绘。普通滚动不重复排版全部内容，`paint()` 只绘制已算好的布局，不读 PSI、不访问数据库或网络。[Inlay 生命周期](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/Inlay.java)。
5. 通过 editor 鼠标事件识别 inlay 和按钮命中，提供展开/收起和右键菜单；点击译文正文不自动跳转、不触发请求。
6. 折叠时显隐取决于锚点及关联方向，位于折叠边界的 inlay 可能仍可见；应主动验证注释折叠、外层函数折叠和已开启文档渲染的组合，必要时显式管理显示。[InlayProperties](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/InlayProperties.java)。
7. 多个编辑器共享翻译数据，各自管理布局、展开状态与资源；文件/编辑器关闭时释放显示和监听器。保存、撤销、搜索、复制和 Git diff 始终使用原文。

原位“只显示译文”可作为后续可选阅读模式，先确认实际用户需求。普通 fold placeholder 会把换行转为空格；`CustomFoldRegion` 可自定义多行绘制，但只覆盖完整文档行且为实验性 API。这些限制不再阻挡默认功能。[普通折叠排版](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/openapi/editor/impl/view/EditorView.java)、[CustomFoldRegion](https://github.com/JetBrains/intellij-community/blob/master/platform/editor-ui-api/src/com/intellij/openapi/editor/CustomFoldRegion.java)。

## 只读阅读视图与 Markdown

阅读器由用户主动打开，面向长文而非日常注释。源码阅读器可优先评估独立内存文档加原生只读 viewer，保留熟悉的字体、选择和导航；Markdown 排版可用 `JBCefBrowser`。提供清晰的原文/译文切换、可选择复制的正文以及返回源码入口。现有 [readerContent.ts](../src/readerContent.ts) 和 [markdownReaderContent.ts](../src/markdownReaderContent.ts) 可参考，但布局与消息桥按 IDEA 重新设计。

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

自动翻译仅在开关开启、配置有效且项目可信时执行，范围是当前打开且可见的源码及阅读器关联文件，不扫描整个项目。完整文件扫描与批量请求只在内容/配置变化等事件触发；滚动不重新调用 AI。绘制优先处理视口及缓冲区域，同时保留已建立区域的布局高度，避免反复增删导致跳动。600ms 为编辑防抖起始值，停用自动翻译时取消自动任务；文件显示开关独立管理已有译文。

保留接口地址与模型自由配置、可选 Key、通用文本 JSON / JSON object / JSON schema 模式，以及 `max_tokens` / `max_completion_tokens` / 不发送上限参数的选择。HTTP 重试、无效响应拆批、缺失项单独修复的上限沿用现有规则。成功部分可先显示；失败、重复或未知 ID 不进入成功缓存。使用可取消的 JVM HTTP 实现，并验证 IDE 代理设置与本地兼容服务访问。

端点、模型、目标语言、自定义 Prompt 和开关使用原生持久化设置；API Key 在设置页用密码字段编辑，通过 `PasswordSafe` 保存，按规范化服务地址区分凭据。Key 不进入项目 `.idea` 文件、SQLite、日志或页面脚本。凭据读写和网络请求都不在 UI 线程执行。[设置持久化](https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html)、[PasswordSafe](https://plugins.jetbrains.com/docs/intellij/persisting-sensitive-data.html)。

后台扫描只持有短暂读锁，生成不可变快照后释放锁，再查库和请求网络。更新前检查 `Document.modificationStamp`、任务代次、项目/编辑器生命周期与配置版本；关闭文件、取消任务或切换服务后丢弃对应的迟到结果，停用自动翻译取消自动任务。显示开关不代替取消操作。网络和数据库操作不得放入 PSI 读锁、绘制回调或 UI 线程。[线程与读操作规则](https://plugins.jetbrains.com/docs/intellij/threading-model.html)。

缓存实现建议：

- 使用插件独立的 SQLite JDBC 数据库，保存在 IDE 用户数据目录；事务写入、忙等待上限与容量清理集中管理。应用级服务让同一 IDE 进程的多个项目复用。
- 沿用当前缓存字段和默认策略：原文、译文、统一语言 ID、规范化服务地址、模型、目标语言、Prompt 版本/内容哈希、创建/访问时间；默认不按时间过期，10,000 条容量淘汰，可选 TTL。
- 沿用 `SHA-256(UTF-8(JSON 数组))` 键语义。跨端一致需要固定 JSON 转义、端点规范化和语言 ID 样例，不能直接用 IDEA 的 `Language.id` 替代现有 ID。
- **不让 JDBC 与现有 sql.js 共写一个文件。** 现有 [cache.ts](../src/core/cache.ts) 使用自建 `.lock` 加整库导出和原子替换，JDBC 不遵循这套锁。后续复用已有译文应采用一致快照导入或中立格式导入，并重新校验。
- SQLite JDBC 包含原生库，需要验证 macOS ARM64、Windows/Linux 目标架构的加载，以及插件关闭时连接与资源释放。[SQLite JDBC 官方说明](https://github.com/xerial/sqlite-jdbc)。

## 复用边界与验收

可移植的是协议、规则与样例；现有 TypeScript 编译产物不能作为 JVM 插件直接使用。`controller.ts`、`renderer.ts`、`reader.ts` 的 VS Code 生命周期和 UI 接口必须重写；TextMate/WASM、sql.js、Node HTTP、markdown-it 的运行时实现也必须替换。

从现有 `tests/` 提取以下共享 JSON 夹具，保持内容解析、协议和缓存语义可核对；IDEA 的显示与交互测试按本文独立定义，不要求复制 VS Code 的行为：

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

1. **显示原型**：固定译文验证 Java 的独立行、行尾、单行/多行 Javadoc、同行多个注释。重点检查 block Inlay 随分栏/字号变化的换行、四行预览与原地展开、视口稳定、正常编辑、代码折叠和文档渲染共存。保存内容与修改标记必须不变。此阶段不调用 AI，不做实验性原位替换。
2. **可用首版**：设置、凭据、自动扫描、当前注释手动翻译、批量 HTTP、SQLite、文件级状态与取消；完成 Java/Kotlin/XML/HTML。缓存命中、展开/收起和显示切换不得重复调用模型。
3. **长文与语言扩展**：完成主动打开的阅读器、Markdown 全文分块和校验、编辑器/项目树右键，逐项验证其他可用语言；补齐跨平台打包与兼容性检查。
4. **交付**：单元与平台集成测试使用 Mock 服务；在隔离 IDEA 沙箱验证真实阅读、键盘/鼠标操作、关闭重开和缓存持久化，再生成 ZIP。以体验验收表为标准，明确披露尚未支持的组合；功能数量不替代阅读与编辑质量。

## 构建、发布与更新

IDEA 单独使用 `test`、`verifyPlugin`、`buildPlugin` 等 Gradle 任务，产出插件 ZIP，通过 **Settings → Plugins → Install Plugin from Disk** 安装。Plugin Verifier 验证二进制兼容性，不能替代真实编辑器显示测试。

后续新增 IDEA 工作流和独立标签 `idea-v0.1.0` 等；现有 VS Code 发布监听 `v*`，使用 `idea-v*` 可避免触发 VSIX 发布流程。两个平台各自维护版本、说明与产物，不修改 VS Code 的 `0.2.6` 版本号。

IDEA 也支持自定义插件更新仓库：GitHub Release 提供 ZIP，稳定 HTTPS 地址提供 `updatePlugins.xml`，用户在插件仓库设置中添加该地址后，可以在插件管理中检查更新，无需先上架 Marketplace。更新索引须在 ZIP 发布成功后更新，并与插件 ID、版本和 IDE build 范围一致。本轮只记录方案，不配置更新源。[自定义插件仓库](https://plugins.jetbrains.com/docs/intellij/custom-plugin-repository.html)。
