/**
 * Diff 解析工具
 * @author sm
 * @name: Diff 路径解析
 * @Descripttion: 提取变更文件路径并还原 Git 引号内的 UTF-8 转义
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-10-08 16:49:52
 * @LastEditTime: 2026-10-08 16:49:52
 * @FilePath: src/utils/diff.ts
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

  const match = line.match(/^diff --git ("(?:\\.|[^"\\])*"|a\/.+?|\/dev\/null) ("(?:\\.|[^"\\])*"|b\/.+|\/dev\/null)$/);
  if (!match) {
    return null;
  }

  const before = decodeGitPath(match[1]);
  const after = decodeGitPath(match[2]);

  if (!before || !after) {
    return null;
  }

  return { before, after };
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }

  const escapes: Record<string, string> = {
    a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '"': '"', '\\': '\\'
  };

  // Git 八进制转义表示 UTF-8 字节；单次替换避免把字面反斜杠再次解码。
  return value.slice(1, -1).replace(/(?:\\[0-3][0-7]{2})+|\\([abfnrtv"\\])/g, (escaped, character: string | undefined) => {
    if (character !== undefined) {
      return escapes[character];
    }
    const bytes = escaped.slice(1).split('\\').map((octal: string) => parseInt(octal, 8));
    return Buffer.from(bytes).toString('utf8');
  });
}
