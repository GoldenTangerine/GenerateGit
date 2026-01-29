/**
 * Git 操作服务
 * @author sm
 */

import * as vscode from 'vscode';
import { GitExtension, Repository, GitAPI } from '../types/git';
import * as logger from '../utils/logger';

let gitAPI: GitAPI | undefined;

/**
 * 初始化 Git API
 */
export async function initGitAPI(): Promise<boolean> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');

    if (!gitExtension) {
      logger.error('未找到 Git 扩展');
      return false;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const git = gitExtension.exports;

    if (!git.enabled) {
      logger.error('Git 扩展未启用');
      return false;
    }

    gitAPI = git.getAPI(1);
    logger.info('Git API 初始化成功');
    return true;
  } catch (error) {
    logger.error('Git API 初始化失败', error as Error);
    return false;
  }
}

/**
 * 获取当前活动的仓库
 */
export function getActiveRepository(): Repository | undefined {
  if (!gitAPI) {
    logger.warn('Git API 未初始化');
    return undefined;
  }

  const repositories = gitAPI.repositories;

  if (repositories.length === 0) {
    logger.warn('未找到 Git 仓库');
    return undefined;
  }

  // 如果只有一个仓库，直接返回
  if (repositories.length === 1) {
    return repositories[0];
  }

  // 如果有多个仓库，尝试根据当前活动编辑器确定
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeUri = activeEditor.document.uri;
    const repo = gitAPI.getRepository(activeUri);
    if (repo) {
      return repo;
    }
  }

  // 默认返回第一个仓库
  return repositories[0];
}

/**
 * 获取暂存区的 diff
 */
export async function getStagedDiff(): Promise<string | undefined> {
  const repository = getActiveRepository();

  if (!repository) {
    vscode.window.showWarningMessage('未找到 Git 仓库');
    return undefined;
  }

  try {
    // 获取暂存区的 diff（参数 true 表示只获取暂存的变更）
    const diff = await repository.diff(true);

    if (!diff || diff.trim() === '') {
      logger.info('暂存区没有变更');
      return undefined;
    }

    logger.info(`获取到暂存区 diff，长度：${diff.length} 字符`);
    return diff;
  } catch (error) {
    logger.error('获取暂存区 diff 失败', error as Error);
    throw error;
  }
}

/**
 * 设置 SCM 输入框的提交消息
 */
export function setCommitMessage(message: string): boolean {
  const repository = getActiveRepository();

  if (!repository) {
    logger.warn('未找到仓库，无法设置提交消息');
    return false;
  }

  try {
    repository.inputBox.value = message;
    logger.info('提交消息已设置到 SCM 输入框');
    return true;
  } catch (error) {
    logger.error('设置提交消息失败', error as Error);
    return false;
  }
}

/**
 * 检查是否有暂存的变更
 */
export function hasStagedChanges(): boolean {
  const repository = getActiveRepository();

  if (!repository) {
    return false;
  }

  return repository.state.indexChanges.length > 0;
}

/**
 * 获取当前分支名称
 */
export function getCurrentBranch(): string | undefined {
  const repository = getActiveRepository();

  if (!repository || !repository.state.HEAD) {
    return undefined;
  }

  return repository.state.HEAD.name;
}
