/**
 * @name: Diff 精简工具
 * @Descripttion: 合并函数级上下文，并将锁文件、生成文件和已删除文件压缩为摘要，减少无效 Token
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-10-19 18:21:41
 * @LastEditTime: 2026-10-19 18:21:41
 * @FilePath: src/utils/diffFilter.ts
 */

import { extractChangedFilePaths } from './diff';

export const DEFAULT_SUMMARY_ONLY_PATTERNS = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/*.lock',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/dist/**',
  '**/__snapshots__/**',
  '**/*.snap'
];

// 单个文件使用函数级上下文后允许增加的最大字符数，超出时回退为标准 diff
export const DEFAULT_FUNCTION_CONTEXT_EXTRA_CHARS = 4000;

export interface CompactDiffOptions {
  summaryPatterns: string[];
  compactDeletedFiles: boolean;
}

export interface CompactDiffResult {
  text: string;
  compactedFiles: string[];
}

interface DiffBlock {
  header: string;
  text: string;
}

/**
 * 将 glob 转为正则，支持 **、*、?；不含 / 的模式匹配任意层级的文件名
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.includes('/') ? pattern.replace(/^\.?\//, '') : `**/${pattern}`;
  let source = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${source}$`);
}

/**
 * 按文件合并标准 diff 与函数级上下文 diff，单文件膨胀过多时保留标准 diff
 */
export function mergeFunctionContextDiff(
  standardDiff: string,
  extendedDiff: string,
  maxExtraChars = DEFAULT_FUNCTION_CONTEXT_EXTRA_CHARS
): string {
  const { prelude, blocks } = splitDiffBlocks(standardDiff);
  const extendedBlocks = new Map(splitDiffBlocks(extendedDiff).blocks.map((block) => [block.header, block.text]));

  return prelude + blocks.map((block) => {
    const extended = extendedBlocks.get(block.header);
    return extended && extended.length - block.text.length <= maxExtraChars ? extended : block.text;
  }).join('');
}

/**
 * 将匹配摘要规则的文件和已删除文件压缩为“文件头 + 一行摘要”
 */
export function compactDiff(diff: string, options: CompactDiffOptions): CompactDiffResult {
  const patterns = options.summaryPatterns.map(globToRegExp);
  const { prelude, blocks } = splitDiffBlocks(diff);
  const compactedFiles: string[] = [];

  const text = prelude + blocks.map((block) => {
    const file = extractChangedFilePaths(block.header)[0];
    const isDeleted = options.compactDeletedFiles && /^deleted file mode /m.test(block.text);
    const isSummaryOnly = Boolean(file) && patterns.some((pattern) => pattern.test(file));
    const hunkStart = block.text.search(/^@@/m);
    if ((!isDeleted && !isSummaryOnly) || hunkStart < 0) {
      return block.text;
    }

    let added = 0;
    let removed = 0;
    for (const line of block.text.slice(hunkStart).split('\n')) {
      if (line.startsWith('+')) {
        added += 1;
      } else if (line.startsWith('-')) {
        removed += 1;
      }
    }

    compactedFiles.push(file);
    const summary = isDeleted
      ? `# 文件已删除，原有 ${removed} 行内容已省略`
      : `# 依赖锁文件或生成文件，内容已省略（新增 ${added} 行，删除 ${removed} 行）`;
    return `${block.text.slice(0, hunkStart)}${summary}\n`;
  }).join('');

  return { text, compactedFiles };
}

function splitDiffBlocks(diff: string): { prelude: string; blocks: DiffBlock[] } {
  const starts: number[] = [];
  const pattern = /^diff --git /gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(diff)) !== null) {
    starts.push(match.index);
  }

  const blocks = starts.map((start, index) => {
    const text = diff.slice(start, starts[index + 1] ?? diff.length);
    const lineEnd = text.indexOf('\n');
    return { header: lineEnd >= 0 ? text.slice(0, lineEnd) : text, text };
  });

  return { prelude: starts.length > 0 ? diff.slice(0, starts[0]) : diff, blocks };
}
