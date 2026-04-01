# Changelog

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
