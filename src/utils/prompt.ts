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

export const COMMIT_LANGUAGES = ['zh-CN', 'en'] as const;
export type CommitLanguage = typeof COMMIT_LANGUAGES[number];

interface PromptLengthOptions {
  titleLengthRange?: TitleLengthRange;
  descriptionLengthRange?: DescriptionLengthRange;
}

/**
 * 生成时附带的参考信息，均为可选
 */
export interface PromptContext {
  userHint?: string;
  branchName?: string;
  recentTitles?: string[];
  forcedType?: CommitType;
  language?: CommitLanguage;
}

const TITLE_EXAMPLES: Record<TitleLengthRange, string> = {
  '10-20': '新增按钮禁用并默认开启输入框清除',
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

const FIX_TITLE_EXAMPLES: Record<TitleLengthRange, string> = {
  '10-20': '修复空日期显示为当天的问题',
  '20-35': '修复日期格式化函数在值为空时错误显示当天日期的问题',
  '35-50': '修复日期格式化函数在传入空值时被 dayjs 解析为当前时间导致列表错误显示当天日期的问题'
};

const FIX_DESCRIPTION_EXAMPLES: Record<DescriptionLengthRange, string> = {
  '10-25': '为空日期增加返回空字符串的判断',
  '20-50': '在 formatDate 中为空值增加提前返回，避免显示当天日期',
  '40-80': '在 formatDate 中为空值增加提前返回空字符串的判断，避免 dayjs 将 undefined 解析为当前时间而错误显示当天日期',
  '80-130': '在 formatDate 中为空值增加提前返回空字符串的判断，避免 dayjs 将 undefined 解析为当前时间而导致列表和详情页在日期缺失时错误显示当天日期，同时保持传入有效日期时的格式化结果与原有行为一致'
};

/**
 * 提交类型与 Emoji 对照表
 */
export const COMMIT_TYPES = {
  init: { emoji: '🎉', description: '项目初始化' },
  feat: { emoji: '✨', description: '新功能（新增接口、配置、组件、交互或页面）' },
  fix: { emoji: '🐞', description: 'Bug 修复（纠正错误行为，含界面显示异常）' },
  docs: { emoji: '📃', description: '文档变更' },
  style: { emoji: '🌈', description: '代码格式（仅空白、缩进、分号、引号等，不含 CSS 与界面改动）' },
  refactor: { emoji: '🦄', description: '代码重构（运行行为不变，调整结构或命名）' },
  perf: { emoji: '🎈', description: '性能优化（运行结果不变，提升速度或降低资源占用）' },
  test: { emoji: '🧪', description: '测试相关' },
  build: { emoji: '🔧', description: '构建系统或外部依赖变更' },
  ci: { emoji: '🐎', description: '持续集成配置' },
  chore: { emoji: '🐳', description: '其他不修改源代码的变更' },
  revert: { emoji: '↩', description: '回滚提交' }
} as const;

export type CommitType = keyof typeof COMMIT_TYPES;

/**
 * 生成 Type 判定规则，分析与归并 Prompt 共用同一套标准
 */
function buildCommitTypeSection(): string {
  const table = Object.entries(COMMIT_TYPES)
    .map(([type, { emoji, description }]) => `| ${emoji} | ${type} | ${description} |`)
    .join('\n');

  return `## Emoji 与 Type 对照表

emoji 和 type 必须严格按下表配对：

| Emoji | Type | 说明 |
|-------|------|------|
${table}

## Type 判定规则

以代码运行行为的变化为依据，按顺序判断，命中即停止：

1. 运行行为没有变化：只改空白、缩进、分号、引号、import 顺序 → style；只改注释或文档 → docs；只改测试 → test；只改构建脚本或依赖 → build；只改 CI 配置 → ci
2. 原有行为有误并被纠正 → fix，典型信号：
   - 修正条件判断、比较运算、取值、默认值、字段名、路径、正则或转义
   - 补充判空、边界、异常、await、取消、去重、时序等处理
   - 修正接口参数、数据映射、状态同步或事件绑定
   - 修复界面错位、遮挡、溢出、闪烁、显示异常等样式问题
3. 新增了此前不存在的能力（接口、配置项、组件、交互、页面）→ feat
4. 运行结果不变，只为提升速度或降低资源占用 → perf
5. 运行结果不变，只调整代码结构、命名或抽取复用 → refactor
6. 其余不影响源代码的杂项 → chore

注意：
- style 仅指代码格式化。修改 CSS 或界面时绝不能选 style：修复显示问题用 fix，新增或改版界面用 feat
- 同时包含多种改动时，以最核心的改动意图决定 type；在 fix 与 style、refactor 之间犹豫且运行行为确有变化时，选择 fix
- 代码注释里的“修复”“fix”等字样仅供参考，必须以删除行与新增行的实际差异为准`;
}

/**
 * 生成“补充信息”段落，没有任何参考信息时返回空字符串
 */
function buildContextSection(context: PromptContext = {}): string {
  const items: string[] = [];
  if (context.forcedType) {
    items.push(`- 已确定 type：${context.forcedType}（根据变更文件类型判定，必须使用该 type 及对应 emoji）`);
  }
  if (context.userHint) {
    items.push(`- 开发者填写的提交意图：${context.userHint}\n  与 diff 一致时优先采用其描述的改动目的和用词；与 diff 矛盾时以 diff 为准`);
  }
  if (context.branchName) {
    items.push(`- 当前分支：${context.branchName}（仅供参考，以 diff 为准）`);
  }
  if (context.language === 'en') {
    items.push('- 输出语言：主题和每条变更描述使用英文；emoji、type、“变更内容：”“涉及组件：”等段落标题、[新增]/[修改]/[删除]/[重命名] 标签与文件路径必须保持模板原样；长度档位按中文字符设计，英文按同等信息量控制');
  }

  const parts = items.length > 0 ? [items.join('\n')] : [];
  if (context.recentTitles?.length) {
    parts.push(`### 仓库近期提交主题（仅参考 scope 命名与措辞风格，不要据此判断 type）\n\n${context.recentTitles.map((title) => `- ${title}`).join('\n')}`);
  }
  return parts.length > 0 ? `## 补充信息\n\n${parts.join('\n\n')}\n\n` : '';
}

/**
 * 生成默认的系统 Prompt
 */
export function getDefaultPrompt(options: PromptLengthOptions = {}): string {
  const titleLengthRange = options.titleLengthRange || DEFAULT_TITLE_LENGTH_RANGE;
  const descriptionLengthRange = options.descriptionLengthRange || DEFAULT_DESCRIPTION_LENGTH_RANGE;
  const exampleTitle = TITLE_EXAMPLES[titleLengthRange];
  const exampleDescriptions = DESCRIPTION_EXAMPLES[descriptionLengthRange];
  const fixExampleTitle = FIX_TITLE_EXAMPLES[titleLengthRange];
  const fixExampleDescription = FIX_DESCRIPTION_EXAMPLES[descriptionLengthRange];
  return `你是一个专业的 Git 提交消息生成器。请根据提供的 Git diff 内容，生成一条符合规范的中文提交消息。

## 分析步骤（在内部完成，不要输出）

1. 逐个文件对比 \`-\` 删除行与 \`+\` 新增行，弄清改动前后的运行行为差异
2. 判断每处改动属于修复缺陷、新增能力、性能优化、重构还是纯格式调整
3. 找出最核心的改动意图，按“Type 判定规则”确定 type 和 scope
4. 最后再撰写主题，确保主题与 type 一致
5. diff 中以 \`# \` 开头的“内容已省略”行是本地生成的摘要，对应文件只需根据文件头和摘要描述变更

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
   - emoji 和 type 必须按对照表配对，type 按“Type 判定规则”选择
   - scope 是可选的，表示影响范围（如组件名、模块名）
   - 主题使用中文，同时写清主要改动对象、关键动作和行为结果
   - 主题必须与 type 一致：fix 写明在什么场景下修复了什么现象，如“修复<场景>时<现象>的问题”；feat 写明新增的具体能力；refactor 写明重构的对象
   - 禁止使用“美化”“样式调整”“优化代码”“完善逻辑”“更新代码”等空泛表述
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

${buildCommitTypeSection()}

## 示例一：新增能力

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

## 示例二：缺陷修复（空值原本被解析为当前时间，补充判空纠正了错误行为，因此选 fix 而非 style 或 refactor）

输入 diff：
\`\`\`diff
diff --git a/src/utils/date.ts b/src/utils/date.ts
--- a/src/utils/date.ts
+++ b/src/utils/date.ts
@@ -3,3 +3,6 @@
 export function formatDate(value?: string) {
+  if (!value) {
+    return '';
+  }
   return dayjs(value).format('YYYY-MM-DD');
 }
\`\`\`

输出：
\`\`\`
🐞 fix(utils): ${fixExampleTitle}

变更内容：
- [修改] src/utils/date.ts：${fixExampleDescription}

涉及组件：
- src/utils/date.ts
\`\`\`

## 要求

1. 仔细分析 diff 内容，理解变更的本质，type 以运行行为变化为准
2. 主题要完整概括核心变更，并与 type 保持一致
3. 准确区分新增、修改、删除和重命名，不得把所有变更统一归为修改
4. 只输出提交消息，不要输出分析过程或其他说明文字`;
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
4. 根据全部变更描述重新判断最核心的改动意图，按“Type 判定规则”生成唯一的 emoji、type、scope，不要直接沿用第一段的标题
5. 主题必须与 type 一致：fix 写明修复的场景和现象，feat 写明新增的具体能力，禁止使用“美化”“样式调整”“优化代码”等空泛表述
6. 主题长度控制在 ${titleLengthRange} 个字符，不计算 emoji、type 和 scope
7. 每条描述控制在 ${descriptionLengthRange} 个字符，不计算标签和文件路径
8. 严格按照提供的输出模板输出，不要添加说明文字

${buildCommitTypeSection()}`;
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
    context?: PromptContext;
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

${changedFilesSection}${buildContextSection(options.context)}## Git Diff 内容

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
    context?: PromptContext;
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

${buildContextSection(options.context)}## 待归并的分段结果

${messageSections}

请只输出归并后的提交消息：`;
}

/**
 * 构建候选标题 Prompt：基于已生成的提交消息给出多个不同角度的标题
 */
export function buildTitleCandidatesPrompt(
  message: string,
  options: {
    count: number;
    titleLengthRange?: TitleLengthRange;
    context?: PromptContext;
  }
): string {
  const titleLengthRange = options.titleLengthRange || DEFAULT_TITLE_LENGTH_RANGE;
  return `你是一个专业的 Git 提交消息生成器。请根据下方已生成的提交消息，重新给出 ${options.count} 个候选标题。

## 规则

1. 每行输出一个标题，格式为 \`<emoji> <type>(<scope>): <主题>\`，共 ${options.count} 行，不要编号或添加其他文字
2. 第一行为你认为最准确的标题；对 type 判断存在疑问时，可在其余候选中给出其他合理的 type
3. 主题必须与 type 一致：fix 写明修复的场景和现象，feat 写明新增的具体能力，禁止使用“美化”“样式调整”“优化代码”等空泛表述
4. 主题长度控制在 ${titleLengthRange} 个字符，不计算 emoji、type 和 scope
5. 各候选之间的措辞或侧重点要有明显区别

${buildCommitTypeSection()}

${buildContextSection(options.context)}## 已生成的提交消息

${message}

请输出 ${options.count} 个候选标题：`;
}
