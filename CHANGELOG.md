# Changelog

## v1.3.3 - 2026-07-31

### Added
- 新增跨 Anthropic、OpenAI Chat 与 Responses 的思考开关和思考强度配置
- 新增按接口模式深度合并的 `requestBodyOverrides` 请求字段配置
- 思考摘要输出到每次生成前清空的临时输出通道，不写入插件日志文件

### Changed
- OpenAI Chat 思考请求使用 `max_completion_tokens`，Responses 继续使用 `max_output_tokens`
- 内置思考参数不受支持时自动移除并重试一次，无效思考强度仍保留上游错误
- OpenAI 兼容端点不再默认发送 `stream_options`，并串行化同一模型的首次思考能力探测
- Anthropic 用量仅使用官方 `input_tokens` 与 `output_tokens` 字段

## v1.3.2 - 2026-07-31

### Added
- 新增 Anthropic Messages API，支持标准 JSON 与 SSE 流式响应
- `apiMode` 新增 `anthropic`、`openai-chat`、`openai-responses` 三种显式接口模式

### Changed
- `chatCompletionsDelivery` 同时控制 Anthropic 与 OpenAI Chat 的流式、非流式优先级
- 旧配置值 `chat-completions`、`responses` 自动映射到对应的新模式名称

### Fixed
- 修复 Anthropic SSE 报错或提前中断时可能误用部分输出的问题

## v1.3.1 - 2026-07-31

### Added
- 生成期间可通过状态栏取消仓库选择、API 请求、退避等待和后续分段

### Changed
- Diff 分段与远程归并批次分别执行完整重试，已成功结果不会重复请求
- API 请求超时范围覆盖连接、响应体读取和解析阶段

### Fixed
- 修复重复触发生成命令时启动多个任务、分段尚未全部完成便重复归并的问题
- 修复完整重试包装后丢失超时和 JSON 解析错误类型的问题
- 修复扩展停用后在途任务可能重新创建日志通道的问题

## v1.3.0 - 2026-07-29

### Added
- 新增标题和描述长度档位，可在设置中选择不同详细程度
- 新增 `maxOutputTokens` 配置，默认值为 `10000`

### Changed
- 默认提交正文改为“变更内容”，逐行标记新增、修改、删除和重命名
- 同一文件支持保留多条不同类型的变更描述，未知类型显示为“未分类”

### Fixed
- 修复输出模板使用组合分类字面量、可能导致模型结果被识别为“未分类”的问题
- 修复固定 Few-shot 示例与标题、描述长度档位不一致的问题

## v1.2.0 - 2026-07-29

### Added
- 超长 Diff 超出 `maxDiffLength` 后按文件和完整行无损分段，不再截断或遗漏后续内容
- 新增本地与远程归并模式，支持设置分段并发数、独立归并模型、归并重试次数和归并 Prompt
- 远程模式支持按长度分批递归归并，单段 Diff 不增加额外归并请求
- 日志新增 Diff 分段进度、归并轮次及每次请求的实际 Prompt 字符长度

### Changed
- `maxDiffLength` 调整为单段 Diff 字符上限，最小值为 `1000`，默认值保持 `10000`
- 设置与 README 补充内置分析/归并 Prompt 长度、UTF-16 字符和模型 token 容量说明

### Fixed
- 任一分段或归并请求失败后停止调度后续请求，避免生成不完整提交消息或产生多余调用

## v1.1.6 - 2026-04-08

### Fixed
- 修复流式响应中换行符被 trim 丢弃导致输出模板渲染异常的问题：各文件描述退化为通用兜底文案，且标题行包含完整 AI 原文造成"修改内容"重复出现

## v1.1.5 - 2026-04-07

### Added
- 新增 `chatCompletionsDelivery` 下拉配置，可在设置中选择 `non-stream-first` 或 `stream-first`，控制 `chat/completions` 优先走非流式还是流式正文提取

### Changed
- `准备调用 AI API` 日志现在会额外展示当前的 Chat Completions 正文获取策略，便于确认扩展实际采用的请求顺序

### Fixed
- 修复只能固定先走非流式再回退流式的问题；现在可按配置优先使用流式，并在失败后自动切回非流式

## v1.1.4 - 2026-04-07

### Added
- 当 `chat/completions` 非流式响应仅返回 `assistant role` 而不带正文时，插件会自动回退到流式请求，并从 `delta.content` 中拼接最终文本

### Fixed
- 修复部分 OpenAI-compatible 网关对 `GPT-5` 系列仅在流式模式下返回正文，导致普通请求被误判为“API 返回结果缺少可用文本”的问题

## v1.1.3 - 2026-04-07

### Added
- AI 响应解析失败时，日志会额外输出接口模式、响应结构摘要、`finish_reason`、`content` 类型与响应预览，便于快速判断是模式不匹配还是上游仅返回 reasoning 内容

### Fixed
- 修复部分 OpenAI-compatible 网关在 `chat/completions` 或 `responses` 模式下返回数组 / 嵌套对象内容时，被误判为“API 返回结果为空”的问题
- 修复接口模式与实际返回体不一致时无法兼容解析的问题，现在会自动尝试回退到另一种响应结构提取文本

## v1.1.2 - 2026-04-01

### Added
- AI 请求日志升级为分级块状输出，重点展示接口地址、模型、状态码、重试进度、请求 ID、错误摘要与响应预览
- 可重试请求在 `503/502/429` 等失败场景下，会额外输出服务端返回的具体错误信息，便于直接定位代理或上游异常

### Fixed
- 修复重试阶段为读取错误响应体而阻塞后续重试的问题，响应体读取现在受超时与长度限制保护
- 修复错误摘要可能直接输出超长服务端报文、导致日志面板可读性下降的问题

## v1.1.1 - 2026-04-01

### Added
- 多仓库场景下，无法从命令上下文直接判断目标仓库时，会弹出仓库选择框，避免误将提交消息写入错误子库

### Fixed
- 修复在 monorepo / 多子库工作区中，从 SCM 标题栏点击生成提交时可能误取其他仓库暂存区内容的问题
- 修复提交消息生成流程中多次重复推断当前仓库，导致 diff 获取和输入框回填可能落到不同仓库的问题

## v1.1.0 - 2026-03-11

### Added
- 新增 `apiMode` 配置项，可手动选择 `auto`、`chat-completions` 或 `responses`
- 支持 OpenAI `Responses API` 与 `Chat Completions API` 双接口
- 为扩展包声明正式图标，GitHub 自动打包生成的 VSIX 将展示扩展图标

### Changed
- `apiEndpoint` 默认值调整为 `https://api.openai.com/v1`，支持 base URL 与完整端点自动识别
- 自动路由策略优化：官方 OpenAI base URL 默认走 `responses`，其他 OpenAI-compatible 服务默认走 `chat/completions`
- 更新 README 配置说明与接口选择规则，补充 `responses` 使用示例

### Fixed
- 官方 OpenAI 请求默认附带 `store: false`，避免默认保存提交 diff 等敏感上下文
- 默认重试状态码移除 `404`，减少接口模式或地址配置错误时的无效等待
- 优化 `404` 错误提示，直接指向接口地址、接口模式与模型配置的排查方向
