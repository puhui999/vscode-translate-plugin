# 注释译读 · AI Comment Translator

在 VS Code 中批量翻译代码注释。默认打开无边框的只读源码对照视图：独立注释、文档注释在下方显示多行译文，行尾注释在原注释后追加译文。原生源码编辑器使用轻量的行尾预览，不再创建评论框。译文不会写入源文件，不影响源码保存或 Git diff。

## 安装和体验

1. 从 [GitHub Releases](https://github.com/puhui999/vscode-translate-plugin/releases/latest) 下载最新 `.vsix`；自行构建则运行 `npm ci` 和 `npm run package`。
2. 在 VS Code 命令面板执行 **Extensions: Install from VSIX…**，选择 `artifacts/` 下的安装包。
3. 执行 **注释译读：打开离线效果示例（无需 API）**，可直接看到无边框多行阅读视图和行尾译文。示例使用预置译文，不调用模型、不写入翻译缓存。
4. 执行 **注释译读：打开翻译设置**，填写服务地址、模型名和 API Key；也可使用 **配置模型服务** 向导。
5. 执行 **注释译读：开启 / 关闭当前文件翻译**，扫描、查库并打开阅读视图。也可开启当前窗口自动翻译，访问支持的文件时自动处理。

翻译默认关闭，窗口重启后需要重新开启。配置服务和离线示例不会触发模型请求。关闭自动翻译会取消当前窗口的排队及进行中请求，并清除译文显示。

## 扫描、查库、批量翻译

```text
开启翻译 / 访问文件 / 修改注释
  → TextMate 扫描整个文件，提取注释
  → 查询本地 SQLite
      命中：立即显示已有译文
      未命中：相同注释去重，组成带 ID 的列表
  → 小文件一次请求，大文件按字符预算串行拆批
  → 校验返回 ID，保存原文与译文
  → 在对应注释位置显示译文
```

发送给模型的 user 消息示例：

```json
{
  "comments": [
    { "id": "comment-a", "text": "Return the cached profile." },
    { "id": "comment-b", "text": "Request timeout in milliseconds." }
  ]
}
```

要求模型返回：

```json
{
  "translations": [
    { "id": "comment-b", "text": "请求超时时间，单位为毫秒。" },
    { "id": "comment-a", "text": "返回缓存的用户资料。" }
  ]
}
```

返回顺序可以不同，始终按 ID 对应。成功项先显示并缓存，缺失或重复项最多修复一次；无效或截断响应会有限拆批重试。失败内容不写入成功缓存。文件在请求期间修改、关闭或停用时，迟到结果不会重新出现。

## SQLite 缓存

- 数据库位于 VS Code 为此扩展分配的 `globalStorageUri/translations.sqlite`，不存入项目仓库。
- 保存规范化注释原文、完整译文、代码语言、服务地址、模型、目标语言、Prompt 版本 / 哈希和时间信息。
- 缓存键包含原文、代码语言、服务、模型、目标语言和 Prompt；相同条件下可跨文件、跨窗口重启复用。
- 关闭文件只释放编辑器资源和文件引用，保留数据库译文。
- 默认不按时间过期，容量上限 10,000 条；到达上限后淘汰较少使用的条目。
- 使用 SQLite WASM，避免不同操作系统与 Electron 原生模块 ABI 不匹配。数据库写入采用文件锁、合并和临时文件原子替换。
- 每次扫描前同步磁盘快照，其他窗口已经保存的译文也能复用。异常崩溃遗留的 `.lock` 会报错，确认其他实例已经退出后可删除该锁文件；不会自动覆盖或删除损坏的数据库。
- 执行 **注释译读：清除翻译缓存** 会取消当前翻译并清空持久缓存；再次开启时重新请求。

数据库包含注释原文和译文，属于本机文件；不会上传到插件服务器，也不包含 API Key。默认不随 Settings Sync 同步数据库。

## 显示规则

| 注释 | 显示方式 |
| --- | --- |
| 独立行注释 | 原文下方显示无边框译文 |
| 连续相邻的独立行注释 | 合并为一段，上下对照 |
| 文档注释、普通块注释 | 完整原文保留，块末尾下方显示可换行译文 |
| 代码后的行尾注释 | 在代码行末追加译文 |
| 夹在代码之间的块注释 | 在所在结束行的行末显示译文，悬浮原注释可看全文 |

译文保留原注释的符号和结构：例如 `//`、`///`、`//!`、`#`、`--`、`/* … */`、`/** … */` 以及块内每行的 `*`。注释外壳由本地根据原文恢复；文档标签、参数名、类型和 XML 文档标签由翻译结果校验保护。标签缺失或被改写时，只重试对应注释，不将错误结果写入成功缓存。旧版本缓存通过同样的文档结构校验后直接复用。

例如，文档注释的译文仍显示为：

```typescript
/**
 * 从本地缓存加载用户资料。
 * @param userId 用户的唯一标识符。
 */
```

阅读视图与完整悬浮译文保留多行格式；原生行尾预览会压缩为一行，截短正文时仍保留注释的结束符号。

上述多行排版位于 **独立的只读阅读视图**。译文使用正常文档排版占据空间，随宽度换行，没有卡片边框、作者信息、回复框或 Comments 面板条目。左侧行号始终对应原始源码；点击行号或“返回源码”可回到原生编辑器。源码修改后会同步更新阅读视图，并丢弃旧范围上的译文。

VS Code 的稳定扩展 API 不提供可插入原生源码编辑器的多行虚拟区域，Decoration 也不能可靠撑开代码行。因此阅读视图不是原生编辑器中的虚拟行；它是只读 Webview，保留源码与注释着色，编辑、调试、语义跳转仍在原生编辑器中完成。阅读视图复制的是选中的显示文字，可能包含译文；原生源码编辑器的复制不包含译文。

译文和源码均作为安全纯文字显示，不会执行模型返回的命令链接、HTML 或加载远程图片。关闭翻译后清除两处译文；已打开的阅读视图保留源码，方便返回编辑。

如希望始终留在原生编辑器，将 `displayMode` 改为 `inline`：各类注释都使用无边框的单行行尾预览，悬浮查看完整多行译文。也可随时执行 **打开无边框多行阅读视图**。原生预览仅为视口上下 10 行创建 Decoration；阅读视图显示全文，滚动不发起翻译请求。

## 语言范围

内置 20 个 VS Code 语言 ID：JavaScript、TypeScript、JSX、TSX、Java、C、C++、C#、Go、Rust、Kotlin、Swift、Dart、PHP、Ruby、Shell、SQL、CSS、SCSS、Vue。

Vue 仅处理已支持的 script / style 注释；HTML 注释跳过。按当前需求排除 Python、HTML/XML 和 Markdown 文件，不将 Python docstring 当成普通注释翻译。扩展以编辑器的语言模式为准；例如 Kotlin 文件可能需要安装语言扩展或手动选择语言模式。

解析器使用随插件打包的 TextMate 语法，维护从文件开头开始的跨行状态；不依赖 VS Code 未公开的 token API，不用全局正则猜测注释。语法本身仍可能遇到罕见扩展语法，未通过解析的文件会显示错误。

## 配置

在 VS Code 设置中搜索 `commentTranslator`，即可自行填写服务地址、模型名和 API Key。插件按 OpenAI Chat Completions 协议直连你指定的服务，不限制厂商和模型名称。地址可填写带版本或代理前缀的基础路径（例如 `https://example.com/v1`），也可填写完整 `/chat/completions` 地址；支持 HTTPS 和显式配置的 HTTP，包括内网服务。

`apiKey` 设置非空时优先使用；留空则读取该服务地址对应的 `SecretStorage`。设置页填写的 Key 保存在用户设置中，属于明文，请勿放入公开配置。需要加密保存时，将设置中的 Key 留空，再使用 **配置模型服务** 向导输入。无认证服务可以留空。API Key 不进入 SQLite 或日志。

例如，在用户 `settings.json` 中配置：

```json
{
  "commentTranslator.baseUrl": "https://your-provider.example/v1",
  "commentTranslator.model": "your-model-id",
  "commentTranslator.apiKey": "YOUR_API_KEY"
}
```

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `baseUrl` | 空 | 服务地址，需配置 |
| `model` | 空 | 服务支持的模型名称，需配置 |
| `apiKey` | 空 | 用户设置中的 Key，非空时优先；为空时使用对应服务的加密存储 |
| `displayMode` | `reader` | 默认无边框多行阅读视图；`inline` 留在原生编辑器显示单行预览 |
| `targetLanguage` | 简体中文 | 目标语言 |
| `prompt` | 空 | 附加术语和翻译要求 |
| `responseFormat` | `text` | 通用模式；也可选择服务支持的 `json_object` 或 `json_schema` |
| `maxBatchChars` | 16000 | 每批 JSON 注释数据的字符预算，并非 token 数 |
| `maxOutputTokens` | 8192 | 输出 token 上限，需符合所选模型限制 |
| `tokenLimitParameter` | `max_tokens` | 可改用 `max_completion_tokens`，或选择 `omit` 不发送 token 上限 |
| `timeoutSeconds` | 60 | 单次请求超时 |
| `debounceMs` | 600 | 编辑后的扫描防抖 |
| `visibleBufferLines` | 10 | 视口外额外显示行数 |
| `trailingPreviewLength` | 80 | 行尾译文正文预览长度，注释符号另行保留；悬浮查看完整内容 |

配置前缀均为 `commentTranslator.`。JSON Schema 支持因服务和模型而异，默认通用模式通过提示词要求 JSON 并本地校验，不强制兼容服务支持结构化输出参数。

接口使用 `POST /chat/completions`、`messages`、`model` 和可选的 `Authorization: Bearer`，读取 `choices[0].message.content`。仅提供 Responses、原生厂商协议或自定义认证方式的服务需要兼容代理；“OpenAI 兼容”不表示所有厂商的可选参数完全相同。默认不发送温度等额外采样参数；如服务对 token 参数名称有要求，可调整 `tokenLimitParameter`。

每个文件开启期间默认自动批准最多 500 条不同的未缓存注释。达到上限后执行 **继续翻译下一批 500 条注释**。已缓存内容不消耗本次额度。单文件请求串行，全局最多 3 个文件同时请求；限流、网络错误和超时最多重试两次，认证失败直接提示。

单个注释本身大于字符预算时会给出提示，需要按模型容量调整 `maxBatchChars`。插件不会为了满足预算修改或截断源注释。

## 开发和验证

开发使用 Node.js 22+（建议 24），扩展输出面向 VS Code 1.85+ 的 Node 18 运行时。

```sh
npm install
npm run typecheck
npm test
npm run test:coverage
npm run test:integration
npm run compile
npm run package
```

`npm run compile` 先运行 TypeScript strict 检查，再用 esbuild 打包到 `dist/extension.js` 并复制两个 WASM 资源。VS Code 中按 F5 启动扩展开发窗口。测试使用 Mock，不需要模型 Key。

推送与 `package.json` 版本一致的标签（例如 `v0.2.1`）后，GitHub Actions 会运行测试、构建 VSIX，并将安装包与 SHA-256 校验文件上传到 GitHub Release。发布说明放在 `.github/release-notes/<标签>.md`。工作流使用仓库自带的 `GITHUB_TOKEN`，无需另外配置个人访问令牌。

如需发布到 Marketplace，再将 `package.json` 的 `publisher: local-dev` 替换为自己的 Marketplace publisher，并使用 `vsce publish`。GitHub Release 工作流不会发布到 Marketplace，也不会安装到用户的日常 VS Code；本地 `npm run package` 仅打包。

## 技术说明

- `src/parser/`：注释范围、跨行语法状态与展示分类。
- `src/core/cache.ts`：SQLite 原文译文表与持久化。
- `src/core/scheduler.ts`：文件串行队列、全局并发及取消。
- `src/translation/`：兼容接口、批次拆分、ID 校验与重试。
- `src/controller.ts`：启停、查库、请求和文件变更的一致性。
- `src/renderer.ts`：原生编辑器的单行预览 Decoration。
- `src/commentFormat.ts`：按原注释恢复译文的注释符号和缩进。
- `src/reader.ts` / `src/readerContent.ts`：无边框多行阅读视图、原始行号映射与消息校验。

参考：[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)、[原生可变行高尚未公开给扩展](https://github.com/microsoft/vscode/issues/246822)、[SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat)、[vscode-textmate](https://github.com/microsoft/vscode-textmate)、[sql.js](https://github.com/sql-js/sql.js)。第三方许可随安装包保存在 `dist/licenses/`。
