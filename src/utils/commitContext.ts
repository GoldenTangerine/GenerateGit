/**
 * @name: 提交上下文工具
 * @Descripttion: 根据文件清单确定性判定 type，并从分支名、近期提交中提取生成提交消息的参考信息
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-10-19 18:21:41
 * @LastEditTime: 2026-10-19 18:21:41
 * @FilePath: src/utils/commitContext.ts
 */

import { parseCommitTitle } from './largeDiff';
import type { CommitType } from './prompt';

const MAX_RECENT_TITLE_LENGTH = 100;

// 只有全部文件属于同一类别时才直接判定 type；package.json 可能包含功能配置，不参与判定
const FORCED_TYPE_RULES: Array<{ type: CommitType; pattern: RegExp }> = [
  { type: 'docs', pattern: /\.(?:md|mdx|rst|adoc)$/i },
  { type: 'test', pattern: /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^./]+$/i },
  {
    type: 'ci',
    pattern: /^(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.ya?ml$|\.travis\.ya?ml$|Jenkinsfile$|azure-pipelines\.ya?ml$)/
  },
  {
    type: 'build',
    pattern: /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|[^/]+\.lock)$/
  }
];

const JIRA_ISSUE_PATTERN = /(?:^|[/_-])([A-Z][A-Z0-9]+-\d+)(?=$|[/_-])/;
const HASH_ISSUE_PATTERN = /#(\d+)/;
// 纯数字编号只在常见分支前缀后识别，避免 release/2024-q1 这类分支被误判
const PREFIXED_ISSUE_PATTERN = /^(?:fix|bugfix|hotfix|feat|feature|issue|issues)\/(\d+)(?=$|[-_/])/i;

/**
 * 全部文件同属文档、测试、CI 或锁文件时直接返回对应 type
 */
export function detectForcedCommitType(files: string[]): CommitType | undefined {
  if (files.length === 0) {
    return undefined;
  }
  return FORCED_TYPE_RULES.find((rule) => files.every((file) => rule.pattern.test(file)))?.type;
}

/**
 * 从分支名中提取 issue 编号，返回 #123 或 PROJ-123 形式
 */
export function extractIssueFromBranch(branch?: string): string | undefined {
  if (!branch) {
    return undefined;
  }
  const jira = branch.match(JIRA_ISSUE_PATTERN);
  if (jira) {
    return jira[1];
  }
  const numeric = branch.match(HASH_ISSUE_PATTERN) || branch.match(PREFIXED_ISSUE_PATTERN);
  return numeric ? `#${numeric[1]}` : undefined;
}

/**
 * 在提交消息末尾追加 issue 引用，消息中已包含该编号时不重复追加
 */
export function appendIssueFooter(message: string, issue?: string): string {
  // 按完整编号判断，避免消息中已有 #123 时误跳过 #12
  const escapedIssue = issue?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!issue || new RegExp(`(?<![\\w-])${escapedIssue}(?![\\w-])`).test(message)) {
    return message;
  }
  return `${message.trimEnd()}\n\nRefs: ${issue}`;
}

/**
 * 清洗输入框中的提交意图：忽略完整提交消息与合并/回滚预填内容，标题行去掉 emoji 和 type
 */
export function sanitizeUserHint(value: string, maxLength: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /(?:变更内容|修改内容|涉及组件)[:：]/.test(trimmed) || /^(?:Merge\b|Revert ")/.test(trimmed)) {
    return undefined;
  }
  const [firstLine, ...rest] = trimmed.split(/\r?\n/);
  const parsed = parseCommitTitle(firstLine.trim());
  const title = parsed ? `${parsed.scope ? `(${parsed.scope}) ` : ''}${parsed.subject}` : firstLine.trim();
  return [title, ...rest].join('\n').trim().slice(0, maxLength) || undefined;
}

/**
 * 整理近期提交标题：去掉 emoji 和 type，仅保留 scope 与主题，避免历史误判的 type 影响本次判断
 */
export function sanitizeRecentTitles(messages: string[]): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    const firstLine = message.split(/\r?\n/)[0]?.trim() || '';
    if (!firstLine || /^Merge\b/.test(firstLine)) {
      continue;
    }
    const parsed = parseCommitTitle(firstLine);
    const title = (parsed
      ? `${parsed.scope ? `(${parsed.scope}) ` : ''}${parsed.subject}`
      : firstLine
    ).slice(0, MAX_RECENT_TITLE_LENGTH);
    if (!seen.has(title)) {
      seen.add(title);
      titles.push(title);
    }
  }

  return titles;
}
