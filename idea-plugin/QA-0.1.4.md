# 0.1.4 本地验证记录

本版本仅本地构建，未提交、推送、打标签或发布。测试环境为 macOS、IntelliJ IDEA `2026.2.0.1 / 262.8665.337` 和 JDK 25。

## 自动化

在仓库根目录执行：

```sh
JAVA_HOME='/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home' \
  idea-plugin/gradlew -p idea-plugin \
  -PlocalIdePath='/Users/parentalzen/Applications/IntelliJ IDEA.app/Contents' \
  test buildPlugin --console=plain
```

最终结果：**162 项测试，0 失败、0 错误、0 跳过；BUILD SUCCESSFUL**。

新增及调整的验证覆盖单注释请求、重复原文复用、响应格式、温度和思考参数；两个文件共享默认 10 或自定义 2 个名额；运行中上下调整限额、旧配置快照不能覆盖新限额；取消活动请求和等待文件、文件间公平分配、取消等待队首、线程复用；普通错误继续处理其余注释，认证失败停止并保留成功项；进度合并、失败前刷新与最终状态顺序；原生设置输入校验和保存；新参数不使旧缓存失效。所有接口测试使用 Mock 或本地 HTTP，不请求真实模型。

## 原生 IDEA 验证

使用隔离的配置、插件目录和测试项目，未更改日常 IDEA 的插件或服务设置。测试接口位于 `127.0.0.1:63093`，每个请求人为延迟 300ms。

| 场景 | 实测结果 |
| --- | --- |
| 默认设置，打开 Parallel.java 的 40 条不同注释 | 自动发出 40 个 HTTP 请求，每个仅一条注释；并发峰值 10；携带 JSON Object 和温度 0.2，省略 thinking；原位显示完整注释符号及译文 |
| 设置表单 | 默认值显示正确；通过表单保存并发 3、兼容文本、温度 0.7、关闭思考，持久化值一致 |
| 最终 ZIP，打开 Tuned.java 的 12 条新注释 | 自动发出 12 个单条请求，并发峰值 3；省略 response_format，temperature 为 0.7，thinking.type 为 disabled；状态显示“12 条 · 缓存 0” |
| 修改参数后重新加载 Parallel.java | 40 条旧译文继续命中缓存，没有重新请求 |
| 关闭后重新打开 Tuned.java | 状态显示“12 条 · 缓存 12”，累计请求仍为 52 |
| 源码校验 | 两个文件的完整内容仍与原始生成内容一致，共 52 条英文原注释未被改写 |

默认 10 并发的桌面观测来自本轮第一次 0.1.4 构建；随后完善公平调度与进度合并，并对最终 ZIP 完成全部 162 项测试及上述 3 并发、原位显示、缓存重开验证。Mock 中的总请求耗时分别约 2.75 秒和 1.54 秒，仅说明本地模拟行为，不代表真实模型性能。并发与失败交错、取消和设置动态调整以确定性自动化测试为证据。

原生自动化工具在弹出菜单、关闭设置后偶有空的可访问性结果；改用实际表单坐标并重启隔离 IDEA，再通过持久化配置、HTTP 请求和编辑器状态验证结果。本轮未使用真实 DeepSeek API，模型质量和服务端实际吞吐仍需实际服务验证。

## 本地产物

- 安装包：`build/distributions/idea-comment-translator-0.1.4.zip`
- 便于安装的副本：仓库根目录 `artifacts/idea-release/idea-comment-translator-0.1.4.zip`
- SHA-256：`f6644dcd4dc735ce61910639c3ae135701f5cf75631315baed71a215f8186166`
- 机器可读记录：`artifacts/idea-release/idea-0.1.4-verification.json`
- 截图：`artifacts/idea-qa/parallel-0.1.4/`
- 请求证据：`artifacts/idea-qa/parallel-requests.json`

安装包仍声明兼容 IDEA `262.8665–262.*`。截图、安装包和测试运行目录在 Git 忽略的 `artifacts/` 下。
