/**
 * 敏感信息脱敏工具
 * @author sm
 */

export const DEFAULT_REDACT_PATTERNS = [
  '-----BEGIN [^-]+ PRIVATE KEY-----[\\s\\S]*?-----END [^-]+ PRIVATE KEY-----',
  'sk-[A-Za-z0-9]{16,}',
  'ghp_[A-Za-z0-9]{36}',
  'github_pat_[A-Za-z0-9_]{22,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+',
  '(?:api|access|secret|token)[_-]?key\\s*[:=]\\s*[\'"]?[A-Za-z0-9_\\-]{16,}[\'"]?'
];

export function redactSensitiveText(text: string, patterns: string[]): {
  text: string;
  invalidPatterns: string[];
} {
  let redacted = text;
  const invalidPatterns: string[] = [];

  for (const pattern of patterns) {
    if (!pattern) {
      continue;
    }
    try {
      const regex = new RegExp(pattern, 'gi');
      redacted = redacted.replace(regex, '<redacted>');
    } catch {
      invalidPatterns.push(pattern);
    }
  }

  return { text: redacted, invalidPatterns };
}
