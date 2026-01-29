/**
 * 状态栏管理
 * @author sm
 */

import * as vscode from 'vscode';
import * as logger from '../utils/logger';

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * 创建状态栏项
 */
export function createStatusBarItem(): vscode.StatusBarItem {
  if (statusBarItem) {
    return statusBarItem;
  }

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  statusBarItem.command = 'generate-git-commit.generate';
  statusBarItem.tooltip = '点击生成 Git 提交消息';
  setNormalState();
  statusBarItem.show();

  logger.info('状态栏项已创建');
  return statusBarItem;
}

/**
 * 设置正常状态
 */
export function setNormalState(): void {
  if (statusBarItem) {
    statusBarItem.text = '$(sparkle) 生成提交';
    statusBarItem.backgroundColor = undefined;
  }
}

/**
 * 设置加载状态
 */
export function setLoadingState(): void {
  if (statusBarItem) {
    statusBarItem.text = '$(loading~spin) 生成中...';
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    );
  }
}

/**
 * 设置成功状态（短暂显示后恢复正常）
 */
export function setSuccessState(): void {
  if (statusBarItem) {
    statusBarItem.text = '$(check) 已生成';
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.prominentBackground'
    );

    // 2秒后恢复正常状态
    setTimeout(() => {
      setNormalState();
    }, 2000);
  }
}

/**
 * 设置错误状态（短暂显示后恢复正常）
 */
export function setErrorState(): void {
  if (statusBarItem) {
    statusBarItem.text = '$(error) 生成失败';
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.errorBackground'
    );

    // 3秒后恢复正常状态
    setTimeout(() => {
      setNormalState();
    }, 3000);
  }
}

/**
 * 销毁状态栏项
 */
export function dispose(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
    logger.info('状态栏项已销毁');
  }
}
