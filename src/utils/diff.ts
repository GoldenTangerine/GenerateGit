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
  const regex = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(diff)) !== null) {
    const before = match[1];
    const after = match[2];
    const path = after !== '/dev/null' ? after : before;

    if (!seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }

  return files;
}
