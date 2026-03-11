# AI Git Commit Message Generator

一个 VS Code 插件，通过 AI 自动分析 Git 暂存区的变更，生成符合规范的中文提交消息。

## 功能特点

- 🎯 自动分析暂存区的 diff 内容
- 🤖 支持 OpenAI `Chat Completions` / `Responses` 及兼容 API（OpenAI、DeepSeek、智谱等）
- 📝 生成符合 Angular 规范的提交消息
- 😊 自动添加对应的 emoji 前缀
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
| `apiMode` | 接口模式：`auto` / `chat-completions` / `responses` | `auto` |
| `apiKey` | AI API 密钥 | - |
| `model` | 使用的模型名称 | `gpt-4o-mini` |
| `customPrompt` | 自定义 Prompt | - |
| `outputTemplate` | 输出模板（支持 `{title}`、`{changes}`、`{files}`） | - |
| `redactPatterns` | diff 脱敏正则列表 | 预置常见模式 |
| `maxDiffLength` | 最大 diff 长度 | `10000` |
| `retryCount` | 自动重试次数（不包含首次请求） | `5` |
| `retryStatusCodes` | 触发自动重试的 HTTP 状态码列表 | `408, 429, 500, 502, 503, 504` |
| `requestTimeoutMs` | API 请求超时时间（毫秒） | `60000` |

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
  "generateGitCommit.apiMode": "responses",
  "generateGitCommit.apiKey": "sk-xxx",
  "generateGitCommit.model": "gpt-4o-mini"
}
```

**自定义输出模板：**
```json
{
  "generateGitCommit.outputTemplate": "{title}\n\n修改内容：\n{changes}\n\n涉及组件：\n{files}"
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

**接口选择规则：**
- `apiMode = auto` 时，若 `apiEndpoint` 已明确写成 `/v1/chat/completions` 或 `/v1/responses`，插件直接按该端点发送请求。
- `apiMode = auto` 且只填写 base URL（如 `https://api.openai.com/v1`）时，官方 OpenAI 默认走 `/v1/responses`，其他 OpenAI-compatible 服务默认走 `/v1/chat/completions`。
- 如你的代理或兼容服务也支持 `responses`，但域名不是 `api.openai.com`，请显式设置 `apiMode = responses` 或直接把端点写成 `/v1/responses`。
- 检测到官方 OpenAI 端点时，插件会自动附带 `store: false`，避免默认保存提交 diff 等请求内容。

**重试说明：**
- 遇到可重试状态码时会先释放响应体，再等待后重试，避免连接占用。
- 若服务端返回 `Retry-After`，会优先遵从该等待时间（与退避时间取更大值）。
- 默认不重试 `404`，避免接口地址、`apiMode` 或模型配置错误时无意义等待；如确有需要，可自行把 `404` 加回 `retryStatusCodes`。

## 使用方法

1. 在项目中进行代码修改
2. 使用 `git add` 将变更添加到暂存区
3. 点击以下任一位置的按钮：
   - 状态栏左侧的 "✨ 生成提交" 按钮
   - 源代码管理面板标题栏的 ✨ 图标
4. 等待 AI 生成提交消息
5. 消息会自动填入 SCM 输入框

## 提交消息格式

生成的提交消息遵循以下格式：

```
<emoji> <type>(<scope>): <主题>

<正文>
```

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

- OpenAI: https://platform.openai.com/api-keys
- DeepSeek: https://platform.deepseek.com/api_keys
- 智谱: https://open.bigmodel.cn/usercenter/apikeys

### 为什么提示"没有暂存的变更"？

请确保已使用 `git add` 命令将修改添加到暂存区。

### 支持哪些 AI 服务？

支持 OpenAI 官方的 `Responses API`、`Chat Completions API`，以及兼容 `Chat Completions` 的服务，包括但不限于：
- OpenAI (GPT-4, GPT-3.5)
- DeepSeek
- 智谱 GLM
- 通义千问
- 月之暗面 Kimi

### OpenAI 支持 `/v1/responses` 吗？

支持，而且 OpenAI 官方已经把 `Responses API` 作为新项目的推荐接口；`Chat Completions` 仍可继续使用。这个插件现在两种都兼容。

## 许可证

MIT License
