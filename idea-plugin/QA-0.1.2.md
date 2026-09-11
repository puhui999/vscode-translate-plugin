# 0.1.2 验证记录

2026-09-10（本地时区）在 macOS、IntelliJ IDEA `2026.2.0.1 / 262.8665.337`、JDK 25 上测试。发布源码以 `idea-v0.1.2` 标签为准；对应 GitHub Actions 执行 Linux 测试、打包与发布。

## 自动化

在仓库根目录执行：

```sh
JAVA_HOME='/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home' \
  idea-plugin/gradlew -p idea-plugin \
  -PlocalIdePath='/Users/parentalzen/Applications/IntelliJ IDEA.app/Contents' \
  test buildPlugin --console=plain
```

最终结果：**134 项测试，0 失败、0 错误、0 跳过，BUILD SUCCESSFUL**。

本版新增 19 项平台回归，涵盖：

- 揭开原文后，光标/选区离开自动恢复；多光标、边界与缩进仍保护编辑位置，行内恢复保留代码。
- JAR 中真实 Java/XML 文本源码的资格、读取、PSI 范围与 Document 一致；只读文件、临时文件、目录/二进制/失效文件排除。
- 右键折叠位置与菜单 Editor 上下文、过期位置、快捷键、左键清理和 macOS popupTrigger。
- 同名临时文件的 session/Document 隔离、菜单状态查询无扫描副作用、不支持文件禁用及只读快照映射。

已有编辑首键保护、解析、格式、HTTP Mock、缓存、取消与排版测试一起通过。JUnit 和 HTML 报告位于 `idea-plugin/build/test-results/test/` 与 `idea-plugin/build/reports/tests/test/`。

## 桌面操作

使用独立配置和测试项目加载 0.1.2 ZIP，不修改日常 IDE 插件目录。接口指向本地 Mock，无真实模型 Key 或真实 AI 请求。

| 场景 | 实际观测 |
| --- | --- |
| 打开未缓存的 Automatic.java | 仅打开文件，没有手动翻译操作；自动显示两条译文，状态为“2 条 · 缓存 0” |
| 文件内批量 | Mock 累计请求由 2 变 3，第 3 条请求包含该文件的两条未缓存注释 |
| 点击再离开 | 点击文档译文显示单行原注释，点击下一行代码后恢复两行译文；Document 的源码内容保持原样 |
| 手动检查 | 从 Find Action 执行“检查 / 继续翻译当前文件”，收到“Automatic.java：2 条 · 缓存 2”通知；Mock 请求数仍为 3 |
| 菜单状态 | Tools 菜单显示“隐藏当前文件译文”；光标在普通代码时，“复制当前译文”和原文切换操作禁用 |
| 只读译文 | 从 Find Action 执行“打开只读译文”，实际打开含完整译文的只读快照，源文件保持英文 |
| 最终包重启 | 最终 ZIP 清理旧插件目录后加载，已打开文件恢复缓存译文 |

自动化操作工具的部分树节点和原生菜单点击没有执行预期动作，文件导航改用坐标，动作执行通过 Find Action 完成。本轮没有将鼠标右键弹出菜单逐项点击记为人工通过；右键定位由上述原生平台测试覆盖。源码 JAR 的文件资格和扫描经过平台测试，未独立完成桌面依赖导航验收。清缓存并发、信任状态变化路径经过代码审查，未分别进行完整桌面验收。

截图在被 Git 忽略的 `artifacts/idea-qa/replacement-0.1.2/`，本地 HTTP 请求证据在 `artifacts/idea-qa/mock-requests.jsonl`。Mock 译文中的英文保留及“本地模拟译文”用于辨认源文与展示层，不代表真实模型质量。

## 边界

支持 JAR 内文本源码，不支持无源码的二进制 `.class` 反编译内容。原文编辑期间仍保留原文；最后一个光标及选区离开后恢复已有译文。修改原文后，自动模式需重新扫描并取得匹配译文，旧译文不会覆盖新源码。

平台兼容范围仍为 IDEA `262.8665–262.*`。其他 IDE、远程开发和第三方折叠插件组合未验收。旧版验证记录保持在 [QA-0.1.1.md](QA-0.1.1.md)。
