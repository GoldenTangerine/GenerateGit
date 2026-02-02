/**
 * Prompt 模板定义
 * @author sm
 */

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
 * 从 diff 中提取变更文件路径（按 diff 顺序，保留 a/ 与 b/ 路径）
 */
function extractChangedFilePaths(diff: string): string[] {
  const files: string[] = [];
  const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(diff)) !== null) {
    files.push(`a/${match[1]}`);
    files.push(`b/${match[2]}`);
  }

  return files;
}

/**
 * 生成默认的系统 Prompt
 */
export function getDefaultPrompt(): string {
  return `你是一个专业的 Git 提交消息生成器。请根据提供的 Git diff 内容，生成一条符合规范的中文提交消息。

## 提交消息格式

\`\`\`
<emoji> <type>(<scope>): <主题>

-（<路径>）：<变更描述>
-（<路径>）：<变更描述>
\`\`\`

## 规则

1. **第一行（标题行）**：
   - 格式：\`<emoji> <type>(<scope>): <主题>\`
   - emoji 和 type 必须配对使用（见下方对照表）
   - scope 是可选的，表示影响范围（如组件名、模块名）
   - 主题使用中文，简洁描述变更内容，不超过 50 个字符
   - 不要以句号结尾

2. **文件变更清单**（必填）：
   - 与标题行之间空一行
   - 使用列表逐行输出，每行格式：\`-（<路径>）：<变更描述>\`
   - 路径必须来自 diff 中出现的 a/ 或 b/ 路径
   - 每个变更文件至少 1 行；同一文件有多个变更点时可输出多行并重复路径
   - 如需强调“修改前/后”，可分别使用 a/ 与 b/ 路径
   - 每行不超过 72 个字符

3. **Emoji 与 Type 对照表**：
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

-（a/src/components/Button.vue）：为 Button 组件添加禁用状态的属性配置
-（b/src/components/Button.vue）：支持通过 props 控制按钮的可用状态
-（a/src/components/Input.vue）：调整 clearable 默认值
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
 * @param customPrompt 用户自定义 Prompt
 */
export function buildPrompt(diff: string, customPrompt?: string): string {
  const systemPrompt = customPrompt || getDefaultPrompt();
  const changedFiles = extractChangedFilePaths(diff);
  const changedFilesSection = changedFiles.length > 0
    ? `## 变更文件清单（按 diff 顺序）

${changedFiles.map((file) => `- ${file}`).join('\n')}

`
    : '';

  return `${systemPrompt}

${changedFilesSection}## Git Diff 内容

\`\`\`diff
${diff}
\`\`\`

请根据上述 diff 内容生成提交消息：`;
}
