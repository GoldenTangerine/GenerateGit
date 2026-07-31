# AI Git Commit Message Generator

一个 VS Code 插件，通过 AI 自动分析 Git 暂存区的变更，生成符合规范的中文提交消息。

## 功能特点

- 🎯 自动分析暂存区的 diff 内容
- 🤖 支持 Anthropic `Messages`、OpenAI `Chat Completions` / `Responses` 及兼容 API
- 📝 生成符合 Angular 规范的提交消息
- 😊 自动添加对应的 emoji 前缀
- 🗂️ 支持多仓库 / monorepo 场景，优先锁定当前点击的 Git 子库
- ⚡ 一键生成，自动填入 SCM 输入框

## 安装

### 从 VSIX 安装

1. 下载 `.vsix` 文件
2. 在 VS Code 中按 `Cmd+Shift+P`
3. 输入 "Install from VSIX" 并选择下载的文件

### 从源码构建

```bash
# 安装依赖
pnpm install

# 编译
pnpm run compile

# 打包
pnpm run package
```

## 配置

在 VS Code 设置中搜索 "generateGitCommit" 进行配置：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `apiEndpoint` | AI API 地址，支持 base URL 或完整端点 | `https://api.openai.com/v1` |
| `apiMode` | 接口模式：`auto` / `anthropic` / `openai-chat` / `openai-responses` | `auto` |
| `chatCompletionsDelivery` | Anthropic / OpenAI Chat 正文获取策略：`non-stream-first` / `stream-first` | `non-stream-first` |
| `apiKey` | AI API 密钥 | - |
| `model` | 使用的模型名称 | `gpt-4o-mini` |
| `customPrompt` | 自定义 Diff 分析 Prompt | - |
| `outputTemplate` | 输出模板（支持 `{title}`、`{changes}`、`{files}`） | - |
| `titleLengthRange` | 标题长度目标：`10-20` / `20-35` / `35-50` | `20-35` |
| `descriptionLengthRange` | 单条描述长度目标：`10-25` / `20-50` / `40-80` / `80-130` | `20-50` |
| `maxOutputTokens` | 单次请求最大输出 token 数 | `10000` |
| `redactPatterns` | diff 脱敏正则列表 | 预置常见模式 |
| `maxDiffLength` | 单次分析的最大 diff 长度，超出后自动分段 | `10000` |
| `diffMergeMode` | 分段结果归并方式：`local` / `remote` | `local` |
| `diffConcurrency` | 分段分析与远程归并并发数（`1-10`） | `1` |
| `mergeModel` | 远程归并模型，留空继承 `model` | - |
| `mergeRetryCount` | 远程归并底层请求和完整批次重试次数 | `5` |
| `mergePrompt` | 自定义远程归并 Prompt | - |
| `retryCount` | 底层请求和每个 Diff 分段完整分析的重试次数 | `5` |
| `retryStatusCodes` | 触发底层 HTTP 立即重试的状态码列表 | `408, 429, 500, 502, 503, 504` |
| `requestTimeoutMs` | 单次底层请求全流程超时（毫秒） | `60000` |

### 模型长度计算

- 内置分析和归并 Prompt 的长度会随标题、描述档位以及文件数量变化。
- 实际输入还包含文件清单、展开后的输出模板、Diff 分段或待归并结果；日志会记录每次请求的实际 Prompt 字符长度。
- `maxDiffLength` 使用 JavaScript UTF-16 长度计算，中文通常占 1，emoji 等字符可能占 2；该字符数不等于模型 token 数。
- 请求默认允许最多 `10000` 个输出 token。应确保“实际输入 token + maxOutputTokens”不超过所选模型上下文窗口，并以模型服务商的 tokenizer 结果为准。
- 部分模型或兼容服务不支持 `10000`，遇到参数错误时请调低 `maxOutputTokens`。
- 使用 `customPrompt`、`mergePrompt` 或较长 `outputTemplate` 时，需要相应降低 `maxDiffLength`。
- 填写 `customPrompt` 或 `mergePrompt` 后，自定义 Prompt 优先，不再应用标题和描述长度档位。

### 配置示例

**使用 OpenAI：**
```json
{
  "generateGitCommit.apiEndpoint": "https://api.openai.com/v1",
  "generateGitCommit.apiMode": "auto",
  "generateGitCommit.apiKey": "sk-xxx",
  "generateGitCommit.model": "gpt-4o-mini"
}
```

**使用 Anthropic：**
```json
{
  "generateGitCommit.apiEndpoint": "https://api.anthropic.com",
  "generateGitCommit.apiMode": "anthropic",
  "generateGitCommit.apiKey": "sk-ant-xxx",
  "generateGitCommit.model": "claude-sonnet-5"
}
```

**使用 DeepSeek：**
```json
{
  "generateGitCommit.apiEndpoint": "https://api.deepseek.com/v1",
  "generateGitCommit.apiMode": "auto",
  "generateGitCommit.apiKey": "sk-xxx",
  "generateGitCommit.model": "deepseek-chat"
}
```

**强制使用 OpenAI Responses API：**
```json
{
  "generateGitCommit.apiEndpoint": "https://api.openai.com/v1",
  "generateGitCommit.apiMode": "openai-responses",
  "generateGitCommit.apiKey": "sk-xxx",
  "generateGitCommit.model": "gpt-4o-mini"
}
```

**优先使用流式正文提取：**
```json
{
  "generateGitCommit.apiEndpoint": "https://www.linkflow.run/v1/chat/completions",
  "generateGitCommit.apiMode": "openai-chat",
  "generateGitCommit.chatCompletionsDelivery": "stream-first",
  "generateGitCommit.apiKey": "sk-xxx",
  "generateGitCommit.model": "gpt-5.4"
}
```

**自定义输出模板：**
```json
{
  "generateGitCommit.outputTemplate": "{title}\n\n变更内容：\n{changes}\n\n涉及组件：\n{files}"
}
```

**配置生成详细度：**
```json
{
  "generateGitCommit.titleLengthRange": "20-35",
  "generateGitCommit.descriptionLengthRange": "20-50",
  "generateGitCommit.maxOutputTokens": 10000
}
```

**自定义脱敏正则：**
```json
{
  "generateGitCommit.redactPatterns": [
    "sk-[A-Za-z0-9]{16,}",
    "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
  ]
}
```

**自定义重试与超时：**
```json
{
  "generateGitCommit.retryCount": 5,
  "generateGitCommit.retryStatusCodes": [408, 429, 500, 502, 503, 504],
  "generateGitCommit.requestTimeoutMs": 60000
}
```
`retryStatusCodes` 填 HTTP 状态码数组即可；如需关闭按状态码重试可设为 `[]`（仍会对网络/超时重试）。

**配置超长 Diff：**
```json
{
  "generateGitCommit.maxDiffLength": 10000,
  "generateGitCommit.diffMergeMode": "remote",
  "generateGitCommit.diffConcurrency": 2,
  "generateGitCommit.mergeModel": "gpt-4o-mini",
  "generateGitCommit.mergeRetryCount": 5,
  "generateGitCommit.mergePrompt": ""
}
```

- Diff 超过 `maxDiffLength` 时优先按文件边界无损分段，单个文件超限时继续按行切分，不再截断内容。
- `local` 模式直接拼接各段标题和文件描述；`remote` 模式使用归并模型分批递归归并。
- 每个分段和归并批次独立计算完整重试次数，已成功结果在本次生成中不会重复请求。
- 模型输出需包含标题和当前分段每个文件的变更描述，缺失时会重试完整分析。
- 同一时间只会运行一个生成任务，所有 Diff 分段返回完整结果后才会开始归并。
- 任一分段或远程归并请求重试耗尽后，整个生成流程失败，不会写入不完整的提交消息。
- Diff 只有一段时不会触发额外的远程归并请求。

**接口选择规则：**
- `apiMode = auto` 时，若 `apiEndpoint` 已明确写成 `/v1/chat/completions` 或 `/v1/responses`，插件直接按该端点发送请求。
- `apiMode = auto` 且只填写 base URL（如 `https://api.openai.com/v1`）时，官方 OpenAI 默认走 `/v1/responses`，其他 OpenAI-compatible 服务默认走 `/v1/chat/completions`。
- Anthropic 不参与 `auto` 判断；使用 Messages API 时需显式设置 `apiMode = anthropic`，base URL 会自动补全 `/v1/messages`。
- 如代理或兼容服务支持 Responses，但域名不是 `api.openai.com`，请显式设置 `apiMode = openai-responses` 或填写完整 `/v1/responses` 端点。
- 旧配置值 `chat-completions`、`responses` 会自动映射为 `openai-chat`、`openai-responses`。
- 检测到官方 OpenAI 端点且使用 OpenAI 模式时，插件会自动附带 `store: false`，避免默认保存提交 diff 等请求内容。

**正文获取策略：**
- `chatCompletionsDelivery = non-stream-first` 时，Anthropic 和 OpenAI Chat 优先读取普通 JSON；响应缺少正文时再回退到 `stream: true`。
- `chatCompletionsDelivery = stream-first` 时，Anthropic 和 OpenAI Chat 优先读取流式增量内容；流式失败或无正文时再回退到普通 JSON。
- OpenAI Responses 模式仍按标准 JSON 响应处理。

**重试说明：**
- 遇到可重试状态码时会先释放响应体，再等待后重试，避免连接占用。
- 若服务端返回 `Retry-After`，会优先遵从该等待时间（与退避时间取更大值）。
- `retryStatusCodes` 仅控制底层 HTTP 立即重试；HTTP 错误、网络异常、超时、坏 JSON、空正文和字段缺失均会触发完整分段或归并批次重试。
- 完整重试与底层重试会嵌套；`stream-first` 且 `retryCount = 5` 时，单段极端最多可发起 `72` 次 HTTP 请求。
- 生成期间状态栏显示“取消生成”，点击后会中止仓库选择、请求、退避等待和后续分段。

## 使用方法

1. 在项目中进行代码修改
2. 使用 `git add` 将变更添加到暂存区
3. 点击以下任一位置的按钮：
   - 状态栏左侧的 "✨ 生成提交" 按钮
   - 源代码管理面板标题栏的 ✨ 图标
   - 多仓库场景下，如无法自动判断目标仓库，会先弹出仓库选择框
4. 等待 AI 生成提交消息
5. 消息会自动填入 SCM 输入框

## 提交消息格式

生成的提交消息遵循以下格式：

```
<emoji> <type>(<scope>): <主题>

变更内容：
- [新增] <文件路径>：<变更描述>
- [修改] <文件路径>：<变更描述>

涉及组件：
- <文件路径>
```

- 变更类型固定为 `[新增]`、`[修改]`、`[删除]`、`[重命名]`。
- 同一文件包含多类变更时会输出多行；缺失或未知标签显示为 `[未分类]`。

### Emoji 与 Type 对照表

| Emoji | Type | 说明 |
|-------|------|------|
| 🎉 | init | 项目初始化 |
| ✨ | feat | 新功能 |
| 🐞 | fix | Bug 修复 |
| 📃 | docs | 文档变更 |
| 🌈 | style | 代码格式 |
| 🦄 | refactor | 代码重构 |
| 🎈 | perf | 性能优化 |
| 🧪 | test | 测试相关 |
| 🔧 | build | 构建系统 |
| 🐎 | ci | 持续集成 |
| 🐳 | chore | 其他杂项 |
| ↩ | revert | 回滚提交 |

## 常见问题

### API Key 在哪里获取？

- Anthropic: https://console.anthropic.com/settings/keys
- OpenAI: https://platform.openai.com/api-keys
- DeepSeek: https://platform.deepseek.com/api_keys
- 智谱: https://open.bigmodel.cn/usercenter/apikeys

### 为什么提示"没有暂存的变更"？

请确保已使用 `git add` 命令将修改添加到暂存区。

### 支持哪些 AI 服务？

支持 Anthropic 官方的 `Messages API`、OpenAI 官方的 `Responses API`、`Chat Completions API`，以及对应兼容服务，包括但不限于：
- Anthropic Claude
- OpenAI (GPT-4, GPT-3.5)
- DeepSeek
- 智谱 GLM
- 通义千问
- 月之暗面 Kimi

### OpenAI 支持 `/v1/responses` 吗？

支持，而且 OpenAI 官方已经把 `Responses API` 作为新项目的推荐接口；`Chat Completions` 仍可继续使用。这个插件现在两种都兼容。

## 许可证

MIT License
