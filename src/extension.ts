/**
 * VS Code 扩展入口
 * AI Git Commit Message Generator
 * @author sm
 */

import * as vscode from 'vscode';
import * as gitService from './services/git';
import * as aiService from './services/ai';
import * as statusBar from './handlers/statusBar';
import * as logger from './utils/logger';

/**
 * 扩展激活时调用
 */
export async function activate(context: vscode.ExtensionContext) {
  logger.info('AI Git Commit Message Generator 扩展正在激活...');

  // 初始化 Git API
  const gitInitialized = await gitService.initGitAPI();
  if (!gitInitialized) {
    logger.warn('Git API 初始化失败，部分功能可能不可用');
  }

  // 创建状态栏项
  const statusBarItem = statusBar.createStatusBarItem();
  context.subscriptions.push(statusBarItem);

  // 注册生成提交消息的命令
  const generateCommand = vscode.commands.registerCommand(
    'generate-git-commit.generate',
    generateCommitMessageCommand
  );
  context.subscriptions.push(generateCommand);

  logger.info('AI Git Commit Message Generator 扩展已激活');
}

/**
 * 生成提交消息的命令处理函数
 */
async function generateCommitMessageCommand() {
  logger.info('开始生成提交消息...');

  // 检查是否有暂存的变更
  if (!gitService.hasStagedChanges()) {
    vscode.window.showWarningMessage('没有暂存的变更，请先使用 git add 暂存文件');
    logger.info('没有暂存的变更，取消生成');
    return;
  }

  // 设置加载状态
  statusBar.setLoadingState();

  try {
    // 获取暂存区的 diff
    const diff = await gitService.getStagedDiff();

    if (!diff) {
      statusBar.setErrorState();
      vscode.window.showWarningMessage('无法获取暂存区的变更内容');
      return;
    }

    // 调用 AI 生成提交消息
    const commitMessage = await aiService.generateCommitMessage(diff);

    // 设置到 SCM 输入框
    const success = gitService.setCommitMessage(commitMessage);

    if (success) {
      statusBar.setSuccessState();
      vscode.window.showInformationMessage('提交消息已生成');

      // 自动聚焦到 SCM 视图
      vscode.commands.executeCommand('workbench.view.scm');
    } else {
      statusBar.setErrorState();
      vscode.window.showErrorMessage('无法设置提交消息');
    }
  } catch (error) {
    statusBar.setErrorState();

    const errorMessage = error instanceof Error ? error.message : '未知错误';
    logger.error('生成提交消息失败', error as Error);

    vscode.window.showErrorMessage(`生成提交消息失败: ${errorMessage}`);
  }
}

/**
 * 扩展停用时调用
 */
export function deactivate() {
  logger.info('AI Git Commit Message Generator 扩展正在停用...');
  statusBar.dispose();
  logger.dispose();
}
