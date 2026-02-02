/**
 * Prompt 模板定义
 * @author sm
 */

import { extractChangedFilePaths } from './diff';
import { buildOutputTemplatePreview, resolveOutputTemplate } from './outputTemplate';

/**
 * 提交类型与 Emoji 对照表
 */
export const COMMIT_TYPES = {
  init: { emoji: '🎉', description: '项目初始化' },
  feat: { emoji: '✨', description: '新功能' },
  fix: { emoji: '🐞', description: 'Bug 修复' },
  docs: { emoji: '📃', description: '文档变更' },
  style: { emoji: '🌈', description: '代码格式（不影响功能）' },
  refactor: { emoji: '🦄', description: '代码重构（既不是新功能也不是修复）' },
  perf: { emoji: '🎈', description: '性能优化' },
  test: { emoji: '🧪', description: '测试相关' },
  build: { emoji: '🔧', description: '构建系统或外部依赖变更' },
  ci: { emoji: '🐎', description: '持续集成配置' },
  chore: { emoji: '🐳', description: '其他不修改源代码的变更' },
  revert: { emoji: '↩', description: '回滚提交' }
} as const;

/**
 * 生成默认的系统 Prompt
 */
export function getDefaultPrompt(): string {
  return `你是一个专业的 Git 提交消息生成器。请根据提供的 Git diff 内容，生成一条符合规范的中文提交消息。

## 提交消息格式

\`\`\`
<emoji> <type>(<scope>): <主题>

修改内容：
- <文件路径>：<变更描述>
- <文件路径>：<变更描述>

涉及组件：
- <文件路径>
- <文件路径>
\`\`\`

## 规则

1. **第一行（标题行）**：
   - 格式：\`<emoji> <type>(<scope>): <主题>\`
   - emoji 和 type 必须配对使用（见下方对照表）
   - scope 是可选的，表示影响范围（如组件名、模块名）
   - 主题使用中文，简洁描述变更内容，不超过 50 个字符
   - 不要以句号结尾

2. **修改内容**（必填）：
   - 与标题行之间空一行
   - 使用列表逐行输出，每行格式：\`- <文件路径>：<变更描述>\`
   - 路径必须来自下方“变更文件清单”
   - 每个文件只输出 1 行，不要合并多个文件到一行
   - 每行不超过 72 个字符

3. **涉及组件**（必填）：
   - 与“修改内容”之间空一行
   - 仅列出文件路径，每行一个路径，不要附带描述
   - 顺序必须与“变更文件清单”一致

4. **输出格式约束**：
   - 必须严格按照“输出模板”输出，不得增删行或改动段落结构

5. **Emoji 与 Type 对照表**：
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

## 示例

输入 diff：
\`\`\`diff
diff --git a/src/components/Button.vue b/src/components/Button.vue
index 1234567..abcdefg 100644
--- a/src/components/Button.vue
+++ b/src/components/Button.vue
@@ -10,6 +10,10 @@ export default {
   props: {
     label: String,
+    disabled: {
+      type: Boolean,
+      default: false
+    }
   }
 }
diff --git a/src/components/Input.vue b/src/components/Input.vue
index 2222222..3333333 100644
--- a/src/components/Input.vue
+++ b/src/components/Input.vue
@@ -12,7 +12,7 @@ export default {
   props: {
     value: String,
-    clearable: false
+    clearable: true
   }
 }
\`\`\`

输出：
\`\`\`
✨ feat(components): 增强表单交互

修改内容：
- src/components/Button.vue：为 Button 组件添加禁用状态 props
- src/components/Input.vue：调整 clearable 默认值

涉及组件：
- src/components/Button.vue
- src/components/Input.vue
\`\`\`

## 要求

1. 仔细分析 diff 内容，理解变更的本质
2. 选择最合适的 type 和 emoji
3. 主题要简洁明了，突出核心变更
4. 如果变更涉及多个方面，关注最主要的变更
5. 只输出提交消息，不要有其他说明文字`;
}

/**
 * 构建完整的 Prompt
 * @param diff Git diff 内容
 * @param options 构建参数
 */
export function buildPrompt(
  diff: string,
  options: {
    customPrompt?: string;
    fileList?: string[];
    outputTemplate?: string;
  } = {}
): string {
  const systemPrompt = options.customPrompt || getDefaultPrompt();
  const changedFiles = (options.fileList && options.fileList.length > 0)
    ? options.fileList
    : extractChangedFilePaths(diff);
  const resolvedTemplate = resolveOutputTemplate(options.outputTemplate);
  const outputTemplate = buildOutputTemplatePreview(resolvedTemplate, changedFiles);
  const changedFilesSection = changedFiles.length > 0
    ? `## 变更文件清单（按 diff 顺序）

${changedFiles.map((file) => `- ${file}`).join('\n')}

## 输出模板（按文件一条填充，勿增删行）

${outputTemplate}

`
    : '';

  return `${systemPrompt}

${changedFilesSection}## Git Diff 内容

\`\`\`diff
${diff}
\`\`\`

请根据上述 diff 内容生成提交消息：`;
}
