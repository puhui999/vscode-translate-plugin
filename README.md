# 注释译读 · AI Comment Translator for VS Code

在 VS Code 中自动翻译代码注释。默认在源码原注释位置逐行显示译文，悬停查看原文，光标或选区进入注释所在行时恢复原文以便编辑，离开后恢复译文。也可打开无边框的只读源码对照视图查看多行译文。每条逻辑注释一个请求，默认同时处理 10 条；先查 SQLite，只翻译未缓存的内容。译文不会写入源文件，不影响源码保存或 Git diff。

## 版本与下载

| 编辑器 | 维护分支与使用文档 | 当前源码 | 最新发布安装包 |
| --- | --- | --- | --- |
| VS Code | [master-vscode](https://github.com/puhui999/ai-comment-translator/blob/master-vscode/README.md) | 0.2.7 | [v0.2.7 · VSIX](https://github.com/puhui999/ai-comment-translator/releases/tag/v0.2.7) |
| IntelliJ IDEA | [master-idea](https://github.com/puhui999/ai-comment-translator/blob/master-idea/idea-plugin/README.md) | 0.1.6，已发布预览版 | [idea-v0.1.6 · ZIP](https://github.com/puhui999/ai-comment-translator/releases/tag/idea-v0.1.6) |

仓库默认分支为 `master-idea`；开发 VS Code 版本请切换到 `master-vscode`。两个版本分别适配各自编辑器，独立维护版本、设置与本地 SQLite 缓存，不自动共享配置或译文。

**本文对应 VS Code 0.2.7。** 本版新增单条注释并发、可配置温度与思考模式、同语短标识，并默认使用源码原位译文与 JSON Object 输出，详见 [0.2.7 发布说明](https://github.com/puhui999/ai-comment-translator/blob/master-vscode/.github/release-notes/v0.2.7.md)。IDEA 0.1.6 的 JavaDoc 校验修复属于 IDEA 版本，不能据此判断 VS Code 已包含相同修复。

## 安装和体验

要求 VS Code **1.85.0 及以上**，并在受信任的本地工作区中使用。

1. 下载 [vscode-translate-plugin-0.2.7.vsix](https://github.com/puhui999/ai-comment-translator/releases/download/v0.2.7/vscode-translate-plugin-0.2.7.vsix)；自行构建则在 `master-vscode` 运行 `npm ci` 和 `npm run package`，安装包生成在 `artifacts/`。
2. 在 VS Code 命令面板执行 **Extensions: Install from VSIX…**，选择下载或本地构建的安装包，按提示重新加载窗口。
3. 执行 **注释译读：打开离线效果示例（无需 API）**，默认在源码中体验原位译文；执行 **注释译读：打开无边框多行阅读视图** 可查看多行对照。示例遵循已保存的显示模式，使用预置译文，不调用模型、不写入翻译缓存。
4. 执行 **注释译读：打开翻译设置**，填写服务地址、模型名和 API Key；也可使用 **配置模型服务** 向导。
5. 打开 Java 等受支持的源码文件，即可自动扫描、查库并显示译文。配置完成时已经打开的文件也会自动处理，无需额外执行翻译命令。
6. 对于 Markdown，在编辑器中或资源管理器的 `.md` 文件上右键，选择 **注释译读：翻译整个 Markdown 文件（只读）**。

`commentTranslator.automatic` 默认开启，配置有效的服务地址和模型后生效；设置在 VS Code 重启后保留。缺少配置或工作区不受信任时不发送请求，状态栏会提示原因。只处理当前打开并可见的源码及正在阅读的源文件，不扫描整个工作区。

使用 **注释译读：开启 / 关闭自动翻译** 或设置页可关闭自动模式，取消当前窗口的排队及进行中请求，并清除译文显示。关闭后仍可通过 **开启 / 关闭当前文件翻译** 手动处理单个文件。自动模式下手动关闭某个文件，会暂停该文件，直到手动重新开启或关闭文件后重新打开。离线示例始终不调用模型。

### 更新已安装的版本

下载新 Release 的 `.vsix` 后，再次执行 **Extensions: Install from VSIX…** 覆盖安装并重新加载窗口。更新后可在扩展详情页查看实际版本；通常无需卸载插件或清除缓存。

当前通过 GitHub Release 分发，尚未发布到 VS Code Marketplace，因此扩展管理中的“检查更新”不会从 GitHub 获取新安装包。IDEA 的 ZIP 不能用于 VS Code。需要校验下载内容时，可使用同一 Release 附带的 `SHA256SUMS.txt`。

## 扫描、查库、并发翻译

```text
开启翻译 / 访问文件 / 修改注释
  → TextMate 扫描整个文件，提取逻辑注释
  → 查询本地 SQLite
      命中：立即复用已有结果
      未命中：相同注释去重，每条注释一个请求
  → 所有文件共享请求池，默认同时执行 10 个 HTTP 请求
  → 逐条校验结果、保存缓存并立即显示
      已是目标语言：恢复原文，不增加重复译文
      需要翻译：在对应注释位置显示译文
```

一条逻辑注释可以是完整的多行文档注释，或合并后的连续相邻行注释，不会按物理行拆成多个请求。每个源码翻译请求的 user 消息只含一个注释：

```json
{
  "comments": [
    { "id": "comment-a", "text": "Return the cached profile." }
  ]
}
```

正常翻译沿用带 ID 的响应：

```json
{
  "translations": [
    { "id": "comment-a", "text": "返回缓存的用户资料。" }
  ]
}
```

在默认 `json_object` 或兼容 `text` 模式下，模型先判断自然语言说明是否全部符合目标语言；如果是，只返回：

```json
{"same":true}
```

本地将短标识还原为该条原文并存入 SQLite，保留原始注释的符号、空白和缩进，不再增加重复译文。代码、标识符、URL 和文档标签不参与自然语言判断；仍有其他语言说明、简繁等目标变体不符或无法确定时，继续正常翻译。`same` 必须是独立对象中的布尔值 `true`，字符串、空值、重复字段或与译文混合的矛盾响应不作为成功结果。

首次判断仍需要请求及输入 token，这个标识节省的是重复输出整段原文的输出 token；之后直接命中缓存。`json_schema` 模式为保持既有严格结构兼容，仍返回完整 `translations`，不使用短标识。Markdown 继续使用片段批次协议。

返回内容按 ID 校验，成功项立即显示并缓存，无需等整个文件完成。缺失、重复或结构不完整的结果只为对应注释有限重试；失败内容不写入成功缓存。文件在请求期间修改、关闭或停用时，迟到结果不会重新出现。一个文件的注释也可用满并发名额，多个文件共享上限并轮流获得空闲名额。

## SQLite 缓存

- 数据库位于 VS Code 为此扩展分配的 `globalStorageUri/translations.sqlite`，不存入项目仓库。
- 保存规范化注释或 Markdown 片段原文、完整译文、语言、服务地址、模型、目标语言、Prompt 版本 / 哈希和时间信息；两种翻译模式的缓存分别标识。
- 缓存键包含原文、代码语言、服务、模型、目标语言和 Prompt；相同条件下可跨文件、跨窗口重启复用。并发、输出格式、温度和思考模式不改变缓存身份，调整这些参数只影响后续新请求；需要重新生成已有译文时先清除缓存。
- 同语短标识本地还原为原文后缓存，后续直接复用且不重复显示。协议版本沿用旧值，既有缓存通过结构校验后继续使用。
- 关闭文件只释放编辑器资源和文件引用，保留数据库译文。
- 默认不按时间过期，容量上限 10,000 条；到达上限后淘汰较少使用的条目。
- 使用 SQLite WASM，避免不同操作系统与 Electron 原生模块 ABI 不匹配。数据库写入采用文件锁、合并和临时文件原子替换。
- 每次扫描前同步磁盘快照，其他窗口已经保存的译文也能复用。异常崩溃遗留的 `.lock` 会报错，确认其他实例已经退出后可删除该锁文件；不会自动覆盖或删除损坏的数据库。
- 执行 **注释译读：清除翻译缓存** 会关闭自动模式、取消当前翻译并清空持久缓存；再次开启时重新请求。删除 API Key 也会关闭自动模式，避免删除后立即发起无凭据请求。

数据库包含待翻译原文和译文，属于本机文件；不会上传到插件服务器，也不包含 API Key。默认不随 Settings Sync 同步数据库。

## 显示规则

新安装默认使用 `inline` 原位译文，已明确保存的显示设置保持不变。源码视图在原注释位置显示译文，悬停查看原文；光标或选区进入注释所在行后恢复原文，离开后恢复译文。需要自由多行排版时，可执行 **打开无边框多行阅读视图**，或将 `displayMode` 设为 `reader`。

只读阅读视图的对照排版如下：

| 注释 | 显示方式 |
| --- | --- |
| 独立行注释 | 原文下方显示无边框译文 |
| 连续相邻的独立行注释 | 合并为一段，上下对照 |
| 文档注释、普通块注释 | 完整原文保留，块末尾下方显示可换行译文 |
| 代码后的行尾注释 | 在代码行末追加译文 |
| 夹在代码之间的块注释 | 在所在结束行的行末显示译文，悬浮原注释可看全文 |

译文保留原注释的符号和结构：例如 `//`、`///`、`//!`、`#`、`--`、`/* … */`、`/** … */`、`<!-- … -->` 以及块内每行的 `*`。注释外壳由本地根据原文恢复；文档标签、参数名、类型和 XML 文档标签由翻译结果校验保护。标签缺失或被改写时，只重试对应注释，不将错误结果写入成功缓存。旧版本缓存通过同样的文档结构校验后直接复用。

例如，文档注释的译文仍显示为：

```typescript
/**
 * 从本地缓存加载用户资料。
 * @param userId 用户的唯一标识符。
 */
```

阅读视图保留完整多行格式。原生源码视图保留原注释的行数与外壳，将译文正文分配到原有正文行，不再把整块译文挤到注释末尾；悬停显示完整原注释。

上述多行排版位于 **独立的只读阅读视图**。译文使用正常文档排版占据空间，随宽度换行，没有卡片边框、作者信息、回复框或 Comments 面板条目。左侧行号始终对应原始源码；点击行号或“返回源码”可回到原生编辑器。源码修改后会同步更新阅读视图，并丢弃旧范围上的译文。

VS Code 的稳定扩展 API 不提供可插入原生源码编辑器的多行虚拟区域，Decoration 也不能可靠撑开代码行。因此阅读视图不是原生编辑器中的虚拟行；它是只读 Webview，保留源码与注释着色，编辑、调试、语义跳转仍在原生编辑器中完成。阅读视图复制的是选中的显示文字，可能包含译文；原生源码编辑器的复制不包含译文。

译文和源码均作为安全纯文字显示，不会执行模型返回的命令链接、HTML 或加载远程图片。关闭翻译后清除两处译文；已打开的阅读视图保留源码，方便返回编辑。

默认的 `inline` 模式始终留在原生编辑器：译文显示在原注释位置，保留 `//`、`/** */`、文档标签和缩进，悬停查看原文。光标或选择范围进入注释所在行时，整个注释块临时恢复原文；移开光标后恢复译文。行内注释前后的代码保持可见。

这属于视觉替换，保存、复制、搜索和源码坐标始终使用原文。译文适配原注释已有的物理行数，长行可横向滚动查看；源码编辑器的自动换行仍基于原文，需要按译文宽度自由换行时使用只读阅读视图。嵌套块注释等无法可靠保留内部格式的特殊注释继续显示原文。原位替换利用当前 VS Code Decoration 的 CSS 显示行为，隐藏原文不是稳定 API 的独立能力，已在真实 VS Code 1.85.2 验证。原生装饰仅覆盖视口上下 10 行；滚动不会发起翻译请求。

编辑器右键的翻译开关、阅读视图以及 Markdown 翻译入口已提高到 `navigation@1` / `navigation@2` 优先级，资源管理器的 Markdown 翻译入口同样前移；最终位置由 VS Code 与其他扩展共同排序，无法保证固定在前五项。

## 语言范围

内置 22 个 VS Code 注释语言 ID：JavaScript、TypeScript、JSX、TSX、Java、C、C++、C#、Go、Rust、Kotlin、Swift、Dart、PHP、Ruby、Shell、SQL、CSS、SCSS、Vue、HTML、XML。

HTML、XML 和 Vue 模板支持 `<!-- ... -->` 注释；HTML/Vue 的 script、style 中继续识别受支持的代码注释。标签正文、属性值、XML CDATA、DOCTYPE 和处理指令保持原样。Python 暂不支持，也不将 Python docstring 当成普通注释翻译。扩展以编辑器的语言模式为准；例如 Kotlin 文件可能需要安装语言扩展或手动选择语言模式。

解析器使用随插件打包的 TextMate 语法，维护从文件开头开始的跨行状态；不依赖 VS Code 未公开的 token API，不用全局正则猜测注释。语法本身仍可能遇到罕见扩展语法，未通过解析的文件会显示错误。

## Markdown 全文翻译

在 Markdown 编辑器内或资源管理器的 `.md`、`.markdown`、`.mdown` 文件上右键，选择 **翻译整个 Markdown 文件（只读）**。文件需使用 Markdown 语言模式。此操作始终打开只读阅读视图，不受 `displayMode` 设置影响，也不会覆盖原文件。

- 翻译标题、段落、列表、引用及表格中的自然语言，按 Markdown 排版显示；顶部可切换原文/译文、重新翻译和返回源码。
- 保留 Markdown 格式、代码块、行内代码、链接目标、图片地址、引用定义、原始 HTML 和 YAML/TOML 元数据。完整代码或元数据块无需请求；快捷引用链接的标识保留原文。
- 全文先查 SQLite；相同段落去重，未命中片段合并请求，长文按完整块串行拆批。手动全文翻译不受 500 条自动注释上限影响；Markdown 请求与源码注释共用 `maxConcurrentRequests` 的全局 HTTP 并发额度。
- 结构校验拒绝丢失标题、列表、表格、代码或链接目标的结果。成功片段先显示并缓存，未完成部分暂时保留原文；重试复用已成功缓存。
- 打开 Markdown 本身不会发送请求。已翻译文件修改或服务设置改变后，旧译文会撤下，并提示手动重新翻译；未改变的段落仍可命中缓存。
- 单个完整段落、列表或表格超过 `maxBatchChars` 时会提示其行号，请根据模型容量提高上限；插件不会截断内容。阅读视图不执行原始 HTML，链接显示标签和地址提示，图片显示替代文字与地址，不加载远程资源。

## 配置

在 VS Code 设置中搜索 `commentTranslator`，即可自行填写服务地址、模型名和 API Key。插件按 OpenAI Chat Completions 协议直连你指定的服务，不限制厂商和模型名称。地址可填写带版本或代理前缀的基础路径（例如 `https://example.com/v1`），也可填写完整 `/chat/completions` 地址；支持 HTTPS 和显式配置的 HTTP，包括内网服务。

`apiKey` 设置非空时优先使用；留空则读取该服务地址对应的 `SecretStorage`。设置页填写的 Key 保存在用户设置中，属于明文，请勿放入公开配置。需要加密保存时，将设置中的 Key 留空，再使用 **配置模型服务** 向导输入。无认证服务可以留空。API Key 不进入 SQLite 或日志。

例如，在用户 `settings.json` 中配置：

```json
{
  "commentTranslator.automatic": true,
  "commentTranslator.baseUrl": "https://your-provider.example/v1",
  "commentTranslator.model": "your-model-id",
  "commentTranslator.apiKey": "YOUR_API_KEY",
  "commentTranslator.maxConcurrentRequests": 10,
  "commentTranslator.responseFormat": "json_object",
  "commentTranslator.temperature": 0.2,
  "commentTranslator.thinking": "provider"
}
```

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `automatic` | `true` | 配置就绪后自动翻译打开的源码文件；开关跨重启保留 |
| `baseUrl` | 空 | 服务地址，需配置 |
| `model` | 空 | 服务支持的模型名称，需配置 |
| `apiKey` | 空 | 用户设置中的 Key，非空时优先；为空时使用对应服务的加密存储 |
| `displayMode` | `inline` | 默认在源码原注释位置显示译文，悬停看原文；`reader` 使用无边框多行阅读视图 |
| `targetLanguage` | 简体中文 | 目标语言 |
| `prompt` | 空 | 附加术语和翻译要求 |
| `responseFormat` | `json_object` | 默认发送 JSON Object 参数；`text` 省略该参数，`json_schema` 沿用严格的完整译文结构 |
| `maxConcurrentRequests` | 10 | 当前 VS Code 扩展窗口共享的 HTTP 请求上限，1–64；多文件及 Markdown 共用额度 |
| `temperature` | 0.2 | 模型温度，0–2，支持小数；是否生效由服务、模型和思考模式决定 |
| `thinking` | `provider` | 保留服务默认行为；可设 `enabled` 或 `disabled`，需要服务支持此扩展参数 |
| `maxBatchChars` | 16000 | 单条注释或每批 Markdown 片段的 JSON 字符预算，含数据开销，并非 token 数 |
| `maxOutputTokens` | 8192 | 输出 token 上限，需符合所选模型限制 |
| `tokenLimitParameter` | `max_tokens` | 可改用 `max_completion_tokens`，或选择 `omit` 不发送 token 上限 |
| `timeoutSeconds` | 60 | 单次请求超时 |
| `debounceMs` | 600 | 编辑后的扫描防抖 |
| `visibleBufferLines` | 10 | 视口外额外显示行数 |
| `trailingPreviewLength` | 80 | 已停用的旧版预览长度；原位译文不再截断 |

配置前缀均为 `commentTranslator.`。JSON Object / JSON Schema 支持因服务和模型而异；服务不支持 `response_format` 时，选择 `text` 省略该参数。兼容文本模式仍通过提示词要求 JSON 并本地校验，不接受任意纯文本译文。

接口使用 `POST /chat/completions`、`messages`、`model` 和可选的 `Authorization: Bearer`，读取 `choices[0].message.content`。仅提供 Responses、原生厂商协议或自定义认证方式的服务需要兼容代理；“OpenAI 兼容”不表示所有厂商的可选参数完全相同。默认发送 `temperature: 0.2` 和 `response_format: {"type":"json_object"}`；如服务对 token 参数名称有要求，可调整 `tokenLimitParameter`。

思考模式默认 `provider`，不发送 `thinking` 参数，由服务决定行为。选择 `enabled` 或 `disabled` 时发送 `thinking: {"type":"enabled"}` 或 `thinking: {"type":"disabled"}`，需要服务支持该扩展参数；并非所有兼容接口都支持。温度支持小数，部分模型在思考模式下可能不使用温度参数。

每个文件开启期间默认自动批准最多 500 条不同的未缓存注释。达到上限后执行 **继续翻译下一批 500 条注释**。已缓存内容不消耗本次额度。每条未缓存的逻辑注释单独请求，当前 VS Code 扩展窗口最多同时发送 `maxConcurrentRequests` 个 HTTP 请求，默认 10，可设 1–64。多个文件以及 Markdown 请求共享额度，各 VS Code 窗口独立计数。仅修改并发上限时不会重启已有请求或清空结果；提高上限会立即补充排队请求，降低上限会让已有请求完成后再按新上限补充。限流、网络错误和超时最多重试两次，认证失败直接提示。

单个注释本身大于字符预算时会给出提示，需要按模型容量调整 `maxBatchChars`。插件不会为了满足预算修改或截断源注释。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 配置后打开 Java 等文件没有译文 | 确认右下角语言模式受支持、工作区受信任、自动翻译已开启；执行 **注释译读：查看当前文件翻译状态** 检查具体原因。如果仅当前文件暂停，重新开启该文件翻译。 |
| 光标处仍然显示原注释 | 原位模式会在光标或选区进入注释所在行时恢复原文以便编辑；移到其他代码行后显示译文。译文已经等于原文时也不会额外显示一份。 |
| 长译文在源码中无法自由换行 | 执行 **打开无边框多行阅读视图**；源码原位模式沿用原注释的行数与坐标。 |
| 提示缺少有效译文或未保留格式与标记 | 执行 **重试当前文件（复用缓存）**，成功结果会保留。此提示不等于输出 token 不够；先查看状态及服务响应约束，不必直接清空缓存。 |
| 服务不支持 JSON Object 或 token 参数 | 将 `responseFormat` 设为 `text`；根据服务要求选择 `max_tokens`、`max_completion_tokens` 或 `omit`。 |
| 翻译慢或频繁被限流 | 检查 `maxConcurrentRequests` 与服务额度；默认 10，有限流时调低。思考模式保留服务默认，支持 `thinking` 的服务可按需关闭。 |
| 修改了温度等参数，已有译文没有变化 | 已有 SQLite 结果继续复用；需要重新生成时执行 **清除翻译缓存**，然后重新开启翻译。 |

## 开发和验证

开发使用 Node.js 22+（发布工作流固定为 24.13.1），扩展输出面向 VS Code 1.85+ 的 Node 18 运行时。

```sh
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run test:integration
npm run compile
npm run package
```

`npm run compile` 先运行 TypeScript strict 检查，再用 esbuild 打包到 `dist/extension.js` 并复制两个 WASM 资源。VS Code 中按 F5 启动扩展开发窗口。测试使用 Mock，不需要模型 Key。

GitHub Actions 仅在推送 `v*` 发布标签时运行；IDEA 使用独立的 `idea-v*` 标签。VS Code 标签必须与 `package.json` 版本一致（例如版本 `0.2.7` 对应 `v0.2.7`）；同一个发布工作流完成测试、构建 VSIX，并将安装包与 SHA-256 校验文件上传到 GitHub Release。发布前需准备 `.github/release-notes/<标签>.md`。工作流使用仓库自带的 `GITHUB_TOKEN`，无需另外配置个人访问令牌。分支推送和 Pull Request 不触发构建，开发验证可使用上述本地命令。

如需发布到 Marketplace，再将 `package.json` 的 `publisher: local-dev` 替换为自己的 Marketplace publisher，并使用 `vsce publish`。GitHub Release 工作流不会发布到 Marketplace，也不会安装到用户的日常 VS Code；本地 `npm run package` 仅打包。

## 技术说明

- `src/parser/`：注释范围、跨行语法状态与展示分类。
- `src/core/cache.ts`：SQLite 原文译文表与持久化。
- `src/core/scheduler.ts`：共享 HTTP 并发限制、跨文件调度及取消。
- `src/translation/`：兼容接口、单条注释请求、Markdown 分批、同语短响应、ID 校验与重试。
- `src/controller.ts`：启停、查库、请求和文件变更的一致性。
- `src/renderer.ts`：源码注释的逐行视觉替换、原文悬浮与编辑保护。
- `src/commentFormat.ts`：按原注释恢复译文的注释符号和缩进。
- `src/markdown.ts`：Markdown 分块、源码偏移、结构校验及完整译文重组。
- `src/markdownReaderContent.ts`：Markdown 排版、只读原文/译文切换。
- `src/reader.ts` / `src/readerContent.ts`：无边框多行阅读视图、原始行号映射与消息校验。

参考：[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)、[原生可变行高尚未公开给扩展](https://github.com/microsoft/vscode/issues/246822)、[SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat)、[vscode-textmate](https://github.com/microsoft/vscode-textmate)、[sql.js](https://github.com/sql-js/sql.js)。第三方许可随安装包保存在 `dist/licenses/`。
