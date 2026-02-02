/**
 * Diff 解析工具
 * @author sm
 */

/**
 * 从 diff 中提取变更文件路径（按 diff 顺序，去重）
 */
export function extractChangedFilePaths(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const lines = diff.split(/\r?\n/);

  for (const line of lines) {
    const parsed = parseDiffGitLine(line);
    if (!parsed) {
      continue;
    }

    const before = stripPrefix(parsed.before, 'a/');
    const after = stripPrefix(parsed.after, 'b/');
    const path = after !== '/dev/null' ? after : before;

    if (!path || path === '/dev/null') {
      continue;
    }

    if (!seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }

  return files;
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function parseDiffGitLine(line: string): { before: string; after: string } | null {
  if (!line.startsWith('diff --git ')) {
    return null;
  }

  const match = line.match(/^diff --git (?:\"(.+?)\"|(\S+)) (?:\"(.+?)\"|(\S+))$/);
  if (!match) {
    return null;
  }

  const before = match[1] || match[2];
  const after = match[3] || match[4];

  if (!before || !after) {
    return null;
  }

  return { before, after };
}
