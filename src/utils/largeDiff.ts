/**
 * @name: 超长 Diff 处理工具
 * @Descripttion: 提供 Diff 无损分段、受限并发和本地提交信息归并能力
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-07-29 14:32:36
 * @LastEditTime: 2026-07-29 14:32:36
 * @FilePath: src/utils/largeDiff.ts
 */

const DIFF_HEADER = 'diff --git ';
const CHANGE_TYPES = new Set<ChangeType>(['新增', '修改', '删除', '重命名']);

export type ChangeType = '新增' | '修改' | '删除' | '重命名' | '未分类';

export interface FileChange {
  file: string;
  type: ChangeType;
  description: string;
}

export interface LocalCommitMergeResult {
  title: string;
  changes: FileChange[];
}

/**
 * 按文件边界优先拆分 Diff，确保每段不超过指定字符数
 */
export function splitDiffIntoChunks(diff: string, maxLength: number): string[] {
  if (!diff || diff.length <= maxLength) {
    return diff ? [diff] : [];
  }

  const blocks = splitDiffFileBlocks(diff);
  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    if (block.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitOversizedBlock(block, maxLength));
      continue;
    }

    if (current && current.length + block.length > maxLength) {
      chunks.push(current);
      current = block;
      continue;
    }

    current += block;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

/**
 * 将文本集合按长度组成批次，单条超限时继续按完整行拆分
 */
export function createLengthLimitedBatches(texts: string[], maxLength: number): string[][] {
  const separatorLength = 2;
  const pieces = texts.flatMap((text) => splitTextByLength(text, maxLength));
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const piece of pieces) {
    const nextLength = currentLength + (current.length > 0 ? separatorLength : 0) + piece.length;
    if (current.length > 0 && nextLength > maxLength) {
      batches.push(current);
      current = [piece];
      currentLength = piece.length;
      continue;
    }

    current.push(piece);
    currentLength = nextLength;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * 按并发上限执行任务，并保持返回结果与输入顺序一致
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let stopped = false;

  async function runWorker(): Promise<void> {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/**
 * 本地拼接分段提交信息
 */
export function mergeCommitMessagesLocally(messages: string[], files: string[]): LocalCommitMergeResult {
  const titles = messages
    .map(extractCommitTitle)
    .filter((title): title is string => Boolean(title));
  const changes: FileChange[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const change of parseFileChanges(message, files)) {
      const key = `${change.file}\0${change.type}\0${change.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        changes.push(change);
      }
    }
  }

  return {
    title: titles.join('；'),
    changes
  };
}

export function parseFileChanges(message: string, files: string[]): FileChange[] {
  const fileSet = new Set(files);
  const changes: FileChange[] = [];
  const seen = new Set<string>();

  for (const line of message.split(/\r?\n/)) {
    const match = line.trim().match(/^-+\s*(?:\[([^\]]+)\]\s*)?(.+?)\s*[:：]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const file = normalizePathToken(match[2]);
    const description = match[3].trim();
    if (!fileSet.has(file) || !description) {
      continue;
    }

    const type = normalizeChangeType(match[1]);
    const key = `${file}\0${type}\0${description}`;
    if (!seen.has(key)) {
      seen.add(key);
      changes.push({ file, type, description });
    }
  }

  return changes;
}

export function buildChangeLines(files: string[], changes: FileChange[]): string[] {
  const changesByFile = new Map<string, FileChange[]>();
  for (const change of changes) {
    const values = changesByFile.get(change.file) || [];
    values.push(change);
    changesByFile.set(change.file, values);
  }

  return files.flatMap((file) => {
    const values = changesByFile.get(file);
    if (!values || values.length === 0) {
      return [`- [未分类] ${file}：${buildFallbackDescription(file)}`];
    }
    return values.map((change) => `- [${change.type}] ${file}：${change.description}`);
  });
}

function splitDiffFileBlocks(diff: string): string[] {
  const headerIndexes: number[] = [];
  const pattern = /^diff --git /gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(diff)) !== null) {
    headerIndexes.push(match.index);
  }

  if (headerIndexes.length === 0) {
    return [diff];
  }

  const blocks: string[] = [];
  for (let index = 0; index < headerIndexes.length; index += 1) {
    const start = index === 0 ? 0 : headerIndexes[index];
    const end = headerIndexes[index + 1] ?? diff.length;
    blocks.push(diff.slice(start, end));
  }
  return blocks;
}

function splitOversizedBlock(block: string, maxLength: number): string[] {
  const firstLineEnd = block.indexOf('\n');
  const header = block.startsWith(DIFF_HEADER) && firstLineEnd >= 0
    ? block.slice(0, firstLineEnd + 1)
    : '';
  const chunks: string[] = [];
  let offset = 0;

  while (offset < block.length) {
    const prefix = offset > 0 && header.length < maxLength ? header : '';
    const contentLimit = maxLength - prefix.length;
    const end = findLineBoundary(block, offset, contentLimit);
    chunks.push(prefix + block.slice(offset, end));
    offset = end;
  }

  return chunks;
}

function splitTextByLength(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const pieces: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = findLineBoundary(text, offset, maxLength);
    pieces.push(text.slice(offset, end));
    offset = end;
  }
  return pieces;
}

function findLineBoundary(text: string, offset: number, length: number): number {
  const hardEnd = Math.min(offset + length, text.length);
  if (hardEnd === text.length) {
    return hardEnd;
  }

  const lineEnd = text.lastIndexOf('\n', hardEnd - 1);
  return lineEnd >= offset ? lineEnd + 1 : hardEnd;
}

export function extractCommitTitle(message: string): string | undefined {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const candidate = lines[0];
  if (
    candidate.startsWith('-')
    || candidate === '修改内容：'
    || candidate === '变更内容：'
    || candidate === '涉及组件：'
  ) {
    return undefined;
  }
  return candidate;
}

function normalizeChangeType(value: string | undefined): ChangeType {
  const normalized = value?.trim() as ChangeType | undefined;
  return normalized && CHANGE_TYPES.has(normalized) ? normalized : '未分类';
}

function normalizePathToken(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function buildFallbackDescription(file: string): string {
  const name = file.split('/').pop() || file;
  if (name.endsWith('.vue')) {
    return `调整 ${name.replace('.vue', '')} 组件逻辑`;
  }
  if (name.endsWith('.ts')) {
    return `优化 ${name.replace('.ts', '')} 相关实现`;
  }
  if (name.endsWith('.js')) {
    return `更新 ${name.replace('.js', '')} 相关逻辑`;
  }

  return `更新 ${name} 相关逻辑`;
}
