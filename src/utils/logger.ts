/**
 * 日志工具
 * @author sm
 */

import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * 获取输出通道
 */
function getChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('AI Git Commit');
  }
  return outputChannel;
}

/**
 * 记录信息日志
 */
export function info(message: string): void {
  const timestamp = new Date().toISOString();
  getChannel().appendLine(`[${timestamp}] [INFO] ${message}`);
}

/**
 * 记录警告日志
 */
export function warn(message: string): void {
  const timestamp = new Date().toISOString();
  getChannel().appendLine(`[${timestamp}] [WARN] ${message}`);
}

/**
 * 记录错误日志
 */
export function error(message: string, err?: Error): void {
  const timestamp = new Date().toISOString();
  getChannel().appendLine(`[${timestamp}] [ERROR] ${message}`);
  if (err) {
    getChannel().appendLine(`  Stack: ${err.stack || err.message}`);
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
