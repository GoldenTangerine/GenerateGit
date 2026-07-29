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

export interface LocalCommitMergeResult {
  title: string;
  descriptions: Map<string, string>;
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
    .map(extractTitle)
    .filter((title): title is string => Boolean(title));
  const descriptionLists = new Map<string, string[]>();

  for (const message of messages) {
    const descriptions = extractFileDescriptions(message, files);
    for (const [file, description] of descriptions) {
      const values = descriptionLists.get(file) || [];
      if (!values.includes(description)) {
        values.push(description);
      }
      descriptionLists.set(file, values);
    }
  }

  return {
    title: titles.join('；'),
    descriptions: new Map(
      Array.from(descriptionLists, ([file, descriptions]) => [file, descriptions.join('；')])
    )
  };
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

function extractTitle(message: string): string | undefined {
  const lines = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const candidate = lines[0];
  if (candidate.startsWith('-') || candidate === '修改内容：' || candidate === '涉及组件：') {
    return undefined;
  }
  return candidate;
}

function extractFileDescriptions(message: string, files: string[]): Map<string, string> {
  const fileSet = new Set(files);
  const descriptions = new Map<string, string>();

  for (const line of message.split(/\r?\n/)) {
    const match = line.trim().match(/^-+\s*(.+?)\s*[:：]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const path = normalizePathToken(match[1]);
    const description = match[2].trim();
    if (fileSet.has(path) && description && !descriptions.has(path)) {
      descriptions.set(path, description);
    }
  }

  return descriptions;
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
