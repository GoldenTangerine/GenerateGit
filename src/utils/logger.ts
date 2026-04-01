/**
 * 日志工具
 * @author sm
 */

import * as vscode from 'vscode';

type LogLevel = 'info' | 'warn' | 'error';

export interface LogField {
  label: string;
  value: string | number | boolean | undefined | null;
}

let outputChannel: vscode.LogOutputChannel | undefined;

/**
 * 获取输出通道
 */
function getChannel(): vscode.LogOutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('AI Git Commit', { log: true });
  }
  return outputChannel;
}

/**
 * 记录信息日志
 */
export function info(message: string): void {
  write('info', message);
}

/**
 * 记录警告日志
 */
export function warn(message: string): void {
  write('warn', message);
}

/**
 * 记录错误日志
 */
export function error(message: string, err?: Error): void {
  write('error', message);
  if (err) {
    write('error', `  Stack: ${err.stack || err.message}`);
  }
}

/**
 * 记录块状信息日志
 */
export function infoBlock(title: string, fields: Array<LogField | undefined> = []): void {
  write('info', formatBlock('ℹ', title, fields));
}

/**
 * 记录块状警告日志
 */
export function warnBlock(title: string, fields: Array<LogField | undefined> = []): void {
  write('warn', formatBlock('⚠', title, fields));
}

/**
 * 记录块状错误日志
 */
export function errorBlock(title: string, fields: Array<LogField | undefined> = [], err?: Error): void {
  write('error', formatBlock('✖', title, fields));
  if (err) {
    write('error', `  Stack: ${err.stack || err.message}`);
  }
}

/**
 * 显示输出通道
 */
export function show(): void {
  getChannel().show();
}

/**
 * 销毁输出通道
 */
export function dispose(): void {
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
  }
}

function write(level: LogLevel, message: string): void {
  const channel = getChannel();
  const normalized = normalizeMessage(message);

  if (level === 'info') {
    channel.info(normalized);
    return;
  }

  if (level === 'warn') {
    channel.warn(normalized);
    return;
  }

  channel.error(normalized);
}

function formatBlock(icon: string, title: string, fields: Array<LogField | undefined>): string {
  const normalizedFields = fields
    .filter((field): field is LogField => Boolean(field))
    .filter((field) => field.value !== undefined && field.value !== null && `${field.value}`.trim() !== '')
    .map((field) => ({
      label: field.label,
      value: normalizeFieldValue(field.value)
    }));

  if (normalizedFields.length === 0) {
    return `${icon} ${title}`;
  }

  const lines = [`${icon} ${title}`];

  normalizedFields.forEach((field, index) => {
    const prefix = index === normalizedFields.length - 1 ? '└' : '├';
    lines.push(`  ${prefix} ${field.label}: ${field.value}`);
  });

  return lines.join('\n');
}

function normalizeFieldValue(value: LogField['value']): string {
  return `${value}`.replace(/\r?\n+/g, ' ↩ ');
}

function normalizeMessage(message: string): string {
  return message.replace(/\r\n/g, '\n').trimEnd();
}
