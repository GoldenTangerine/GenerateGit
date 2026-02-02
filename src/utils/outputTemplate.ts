/**
 * 输出模板工具
 * @author sm
 */

export const DEFAULT_OUTPUT_TEMPLATE = `{title}

修改内容：
{changes}

涉及组件：
{files}`;

const REQUIRED_PLACEHOLDERS = ['{title}', '{changes}', '{files}'];

export function resolveOutputTemplate(template?: string): string {
  const normalized = (template || '').trim();
  if (!normalized) {
    return DEFAULT_OUTPUT_TEMPLATE;
  }

  const hasAll = REQUIRED_PLACEHOLDERS.every((token) => normalized.includes(token));
  if (!hasAll) {
    return DEFAULT_OUTPUT_TEMPLATE;
  }

  return normalized;
}

export function buildOutputTemplatePreview(template: string, files: string[]): string {
  const changeLines = files.map((file) => `- ${file}：<一句话描述>`).join('\n');
  const fileLines = files.map((file) => `- ${file}`).join('\n');

  return template
    .replace('{title}', '<emoji> <type>(<scope>): <主题>')
    .replace('{changes}', changeLines)
    .replace('{files}', fileLines);
}

export function renderOutputTemplate(
  template: string,
  title: string,
  changeLines: string[],
  files: string[]
): string {
  const changes = changeLines.join('\n');
  const fileLines = files.map((file) => `- ${file}`).join('\n');

  return template
    .replace('{title}', title)
    .replace('{changes}', changes)
    .replace('{files}', fileLines)
    .trim();
}
