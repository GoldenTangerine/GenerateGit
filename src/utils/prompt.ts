/**
 * Prompt 模板定义
 * @author sm
 */

import { extractChangedFilePaths } from './diff';
import { buildOutputTemplatePreview, resolveOutputTemplate } from './outputTemplate';

export const TITLE_LENGTH_RANGES = ['10-20', '20-35', '35-50'] as const;
export const DESCRIPTION_LENGTH_RANGES = ['10-25', '20-50', '40-80', '80-130'] as const;
export type TitleLengthRange = typeof TITLE_LENGTH_RANGES[number];
export type DescriptionLengthRange = typeof DESCRIPTION_LENGTH_RANGES[number];
export const DEFAULT_TITLE_LENGTH_RANGE: TitleLengthRange = '20-35';
export const DEFAULT_DESCRIPTION_LENGTH_RANGE: DescriptionLengthRange = '20-50';

interface PromptLengthOptions {
  titleLengthRange?: TitleLengthRange;
  descriptionLengthRange?: DescriptionLengthRange;
}

const TITLE_EXAMPLES: Record<TitleLengthRange, string> = {
  '10-20': '增强表单组件交互能力',
  '20-35': '新增按钮禁用状态并调整输入框默认清除行为',
  '35-50': '新增按钮禁用状态配置并调整输入框默认清除行为以统一表单组件的整体交互体验'
};

const DESCRIPTION_EXAMPLES: Record<DescriptionLengthRange, readonly [string, string]> = {
  '10-25': [
    '新增可配置的按钮禁用状态',
    '调整输入框默认清除行为'
  ],
  '20-50': [
    '为 Button 组件增加可配置的禁用状态属性',
    '将 clearable 默认值调整为启用状态'
  ],
  '40-80': [
    '为 Button 组件新增 disabled 布尔属性并设置 false 默认值，使调用方可以控制按钮禁用状态',
    '将 Input 组件的 clearable 默认值由关闭调整为启用，使输入内容默认支持快速清除'
  ],
  '80-130': [
    '为 Button 组件新增 disabled 布尔属性并将默认值设置为 false，使调用方可以显式控制按钮的禁用状态，同时保证未传入该属性时继续保持原有可点击行为，避免新增能力影响现有调用方',
    '将 Input 组件的 clearable 默认值由关闭调整为启用，使输入内容默认提供快速清除入口，同时保留调用方显式覆盖该属性的能力，从而统一表单输入组件的默认交互并减少重复配置'
  ]
};

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
export function getDefaultPrompt(options: PromptLengthOptions = {}): string {
  const titleLengthRange = options.titleLengthRange || DEFAULT_TITLE_LENGTH_RANGE;
  const descriptionLengthRange = options.descriptionLengthRange || DEFAULT_DESCRIPTION_LENGTH_RANGE;
  const exampleTitle = TITLE_EXAMPLES[titleLengthRange];
  const exampleDescriptions = DESCRIPTION_EXAMPLES[descriptionLengthRange];
  return `你是一个专业的 Git 提交消息生成器。请根据提供的 Git diff 内容，生成一条符合规范的中文提交消息。

## 提交消息格式

\`\`\`
<emoji> <type>(<scope>): <主题>

变更内容：
- [<变更类型>] <文件路径>：<变更描述>
- [<变更类型>] <文件路径>：<变更描述>

涉及组件：
- <文件路径>
- <文件路径>
\`\`\`

## 规则

1. **第一行（标题行）**：
   - 格式：\`<emoji> <type>(<scope>): <主题>\`
   - emoji 和 type 必须配对使用（见下方对照表）
   - scope 是可选的，表示影响范围（如组件名、模块名）
   - 主题使用中文，同时写清主要改动对象、关键动作和行为结果
   - 主题长度控制在 ${titleLengthRange} 个字符，不计算 emoji、type 和 scope
   - 不要以句号结尾

2. **变更内容**（必填）：
   - 与标题行之间空一行
   - 使用列表逐行输出，每行格式：\`- [变更类型] <文件路径>：<变更描述>\`
   - 变更类型只能是“新增”“修改”“删除”“重命名”之一
   - 完全根据内容语义判断类型：已有文件中新加功能也属于“新增”
   - 路径必须来自下方“变更文件清单”
   - 每个文件至少输出 1 行；同一文件包含不同变更时，按独立变更输出多行
   - 每条描述控制在 ${descriptionLengthRange} 个字符，不计算标签和文件路径
   - 描述必须包含具体对象、动作和行为结果，禁止只写“更新相关逻辑”等泛化内容

3. **涉及组件**（必填）：
   - 与“变更内容”之间空一行
   - 仅列出文件路径，每行一个路径，不要附带描述
   - 顺序必须与“变更文件清单”一致

4. **输出格式约束**：
   - 必须严格按照“输出模板”输出，不得改动段落结构

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
✨ feat(components): ${exampleTitle}

变更内容：
- [新增] src/components/Button.vue：${exampleDescriptions[0]}
- [修改] src/components/Input.vue：${exampleDescriptions[1]}

涉及组件：
- src/components/Button.vue
- src/components/Input.vue
\`\`\`

## 要求

1. 仔细分析 diff 内容，理解变更的本质
2. 选择最合适的 type 和 emoji
3. 主题要完整概括主要变更，避免“更新代码”等空泛表述
4. 准确区分新增、修改、删除和重命名，不得把所有变更统一归为修改
5. 只输出提交消息，不要有其他说明文字`;
}

/**
 * 生成默认的远程归并 Prompt
 */
export function getDefaultMergePrompt(options: PromptLengthOptions = {}): string {
  const titleLengthRange = options.titleLengthRange || DEFAULT_TITLE_LENGTH_RANGE;
  const descriptionLengthRange = options.descriptionLengthRange || DEFAULT_DESCRIPTION_LENGTH_RANGE;
  return `你是一个专业的 Git 提交消息归并器。请将多段 Git diff 分析结果合并为一条完整、准确的中文提交消息。

## 规则

1. 保留所有分段结果中的有效变更，不得遗漏文件或变更含义
2. 保留同一文件中不同类型的独立变更，仅删除完全重复的表述
3. 变更类型只能是“新增”“修改”“删除”“重命名”之一
4. 根据全部变更生成一个最合适的 emoji、type、scope 和中文主题
5. 主题长度控制在 ${titleLengthRange} 个字符，不计算 emoji、type 和 scope
6. 每条描述控制在 ${descriptionLengthRange} 个字符，不计算标签和文件路径
7. 严格按照提供的输出模板输出，不要添加说明文字`;
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
    titleLengthRange?: TitleLengthRange;
    descriptionLengthRange?: DescriptionLengthRange;
  } = {}
): string {
  const systemPrompt = options.customPrompt || getDefaultPrompt(options);
  const changedFiles = (options.fileList && options.fileList.length > 0)
    ? options.fileList
    : extractChangedFilePaths(diff);
  const resolvedTemplate = resolveOutputTemplate(options.outputTemplate);
  const outputTemplate = buildOutputTemplatePreview(resolvedTemplate, changedFiles);
  const changedFilesSection = changedFiles.length > 0
    ? `## 变更文件清单（按 diff 顺序）

${changedFiles.map((file) => `- ${file}`).join('\n')}

## 输出模板（每个文件至少一条，可按独立变更增加行）

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

/**
 * 构建远程归并 Prompt
 */
export function buildMergePrompt(
  messages: string[],
  options: {
    mergePrompt?: string;
    fileList: string[];
    outputTemplate?: string;
    titleLengthRange?: TitleLengthRange;
    descriptionLengthRange?: DescriptionLengthRange;
  }
): string {
  const systemPrompt = options.mergePrompt || getDefaultMergePrompt(options);
  const resolvedTemplate = resolveOutputTemplate(options.outputTemplate);
  const outputTemplate = buildOutputTemplatePreview(resolvedTemplate, options.fileList);
  const messageSections = messages
    .map((message, index) => `### 分段结果 ${index + 1}\n\n${message}`)
    .join('\n\n');

  return `${systemPrompt}

## 本批次变更文件清单

${options.fileList.map((file) => `- ${file}`).join('\n')}

## 输出模板

${outputTemplate}

## 待归并的分段结果

${messageSections}

请只输出归并后的提交消息：`;
}
