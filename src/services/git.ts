/**
 * Git 操作服务
 * @author sm
 */

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitExtension, Repository, GitAPI } from '../types/git';
import { mergeFunctionContextDiff } from '../utils/diffFilter';
import * as logger from '../utils/logger';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;

let gitAPI: GitAPI | undefined;

interface ResolveRepositoryOptions {
  promptOnAmbiguous?: boolean;
  signal?: AbortSignal;
}

interface RepositoryQuickPickItem extends vscode.QuickPickItem {
  repository: Repository;
}

export interface GetDiffOptions {
  staged: boolean;
  functionContext: boolean;
  signal?: AbortSignal;
}

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
 * 获取仓库展示名称
 */
export function getRepositoryLabel(repository: Repository): string {
  const baseName = path.basename(repository.rootUri.fsPath);
  const relativePath = vscode.workspace.asRelativePath(repository.rootUri, false);

  if (!relativePath || relativePath === repository.rootUri.fsPath) {
    return baseName;
  }

  if (relativePath === baseName) {
    return `${baseName}`;
  }

  return `${baseName} (${relativePath})`;
}

/**
 * 解析命令上下文对应的仓库
 */
export async function resolveRepository(
  context?: unknown,
  options: ResolveRepositoryOptions = {}
): Promise<Repository | undefined> {
  if (!gitAPI) {
    logger.warn('Git API 未初始化');
    return undefined;
  }

  const repositories = gitAPI.repositories;

  if (repositories.length === 0) {
    logger.warn('未找到 Git 仓库');
    return undefined;
  }

  const repositoryFromContext = getRepositoryFromContext(context, repositories);
  if (repositoryFromContext) {
    logger.info(`从命令上下文解析到仓库：${getRepositoryLabel(repositoryFromContext)}`);
    return repositoryFromContext;
  }

  if (repositories.length === 1) {
    return repositories[0];
  }

  const activeEditor = vscode.window.activeTextEditor;
  const activeEditorRepository = activeEditor
    ? findRepositoryByUri(activeEditor.document.uri, repositories)
    : undefined;

  if (options.promptOnAmbiguous) {
    const selectedRepository = await pickRepository(
      repositories,
      activeEditorRepository,
      options.signal
    );
    if (selectedRepository) {
      logger.info(`用户选择仓库：${getRepositoryLabel(selectedRepository)}`);
    }
    return selectedRepository;
  }

  if (activeEditorRepository) {
    logger.info(`从活动编辑器解析到仓库：${getRepositoryLabel(activeEditorRepository)}`);
    return activeEditorRepository;
  }

  if (activeEditor) {
    logger.warn(`活动编辑器 ${activeEditor.document.uri.toString()} 未匹配到 Git 仓库`);
  }

  logger.warn('存在多个 Git 仓库，但未能确定目标仓库');
  return undefined;
}

/**
 * 获取暂存区或工作区的 diff；开启函数级上下文时按文件合并扩展上下文，git 命令不可用时回退到 Git 扩展接口
 */
export async function getDiff(repository: Repository, options: GetDiffOptions): Promise<string | undefined> {
  const scopeLabel = options.staged ? '暂存区' : '工作区';
  // 标准 diff 与扩展 diff 使用相同参数，保证按文件头匹配时格式一致
  const baseArgs = ['diff', '--no-color', '--no-ext-diff', ...(options.staged ? ['--cached'] : [])];
  let diff: string;

  try {
    diff = await runGit(repository, baseArgs, options.signal);
    if (options.functionContext && diff.trim()) {
      try {
        const extendedDiff = await runGit(repository, [...baseArgs, '--function-context'], options.signal);
        const mergedDiff = mergeFunctionContextDiff(diff, extendedDiff);
        logger.info(`已合并函数级上下文，diff 长度：${diff.length} -> ${mergedDiff.length} 字符`);
        diff = mergedDiff;
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        logger.warn(`获取函数级上下文失败，使用标准 diff：${(error as Error).message}`);
      }
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    logger.warn(`执行 git diff 失败，回退到 Git 扩展接口：${(error as Error).message}`);
    try {
      diff = await repository.diff(options.staged);
    } catch (fallbackError) {
      logger.error(`获取${scopeLabel} diff 失败`, fallbackError as Error);
      throw fallbackError;
    }
  }

  if (!diff || diff.trim() === '') {
    logger.info(`${scopeLabel}没有变更`);
    return undefined;
  }

  logger.info(`获取到${scopeLabel} diff，长度：${diff.length} 字符`);
  return diff;
}

/**
 * 暂存全部变更（包含未跟踪文件）
 */
export async function stageAllChanges(repository: Repository, signal?: AbortSignal): Promise<void> {
  await runGit(repository, ['add', '-A'], signal);
  logger.info(`已暂存 ${getRepositoryLabel(repository)} 的全部变更`);
}

/**
 * 获取近期提交消息，接口不可用或失败时返回空数组
 */
export async function getRecentCommitMessages(repository: Repository, count: number): Promise<string[]> {
  if (count <= 0 || typeof repository.log !== 'function') {
    return [];
  }
  try {
    const commits = await repository.log({ maxEntries: count });
    return commits.map((commit) => commit.message);
  } catch (error) {
    logger.warn(`获取近期提交失败：${(error as Error).message}`);
    return [];
  }
}

/**
 * 检查工作区是否有未暂存的变更（含未跟踪文件）
 */
export function hasWorkingTreeChanges(repository: Repository): boolean {
  return repository.state.workingTreeChanges.length + (repository.state.untrackedChanges?.length ?? 0) > 0;
}

/**
 * 是否处于合并或变基过程中，此时输入框通常已被 Git 预填消息
 */
export function isMergeOrRebaseInProgress(repository: Repository): boolean {
  return repository.state.mergeChanges.length > 0 || Boolean(repository.state.rebaseCommit);
}

function runGit(repository: Repository, args: string[], signal?: AbortSignal): Promise<string> {
  if (!gitAPI) {
    return Promise.reject(new Error('Git API 未初始化'));
  }
  const gitPath = gitAPI.git.path;
  return new Promise((resolve, reject) => {
    execFile(gitPath, args, {
      cwd: repository.rootUri.fsPath,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      signal
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 设置 SCM 输入框的提交消息
 */
export function setCommitMessage(repository: Repository, message: string): boolean {
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
export function hasStagedChanges(repository: Repository): boolean {
  return repository.state.indexChanges.length > 0;
}

/**
 * 获取当前分支名称
 */
export function getCurrentBranch(repository: Repository): string | undefined {
  if (!repository.state.HEAD) {
    return undefined;
  }

  return repository.state.HEAD.name;
}

async function pickRepository(
  repositories: Repository[],
  activeEditorRepository?: Repository,
  signal?: AbortSignal
): Promise<Repository | undefined> {
  const sortedRepositories = [...repositories].sort((left, right) => {
    if (!activeEditorRepository) {
      return 0;
    }

    if (isSameUri(left.rootUri, activeEditorRepository.rootUri)) {
      return -1;
    }

    if (isSameUri(right.rootUri, activeEditorRepository.rootUri)) {
      return 1;
    }

    return 0;
  });

  const items: RepositoryQuickPickItem[] = sortedRepositories.map((repository) => {
    const branchName = getCurrentBranch(repository);
    const isActiveEditorRepository =
      activeEditorRepository && isSameUri(repository.rootUri, activeEditorRepository.rootUri);
    const descriptionParts = [];

    if (isActiveEditorRepository) {
      descriptionParts.push('当前编辑器');
    }

    descriptionParts.push(branchName ? `分支：${branchName}` : '未检测到分支');

    return {
      label: getRepositoryLabel(repository),
      description: descriptionParts.join(' · '),
      detail: repository.rootUri.fsPath,
      repository
    };
  });

  const cancellationTokenSource = new vscode.CancellationTokenSource();
  const handleAbort = () => cancellationTokenSource.cancel();
  if (signal?.aborted) {
    handleAbort();
  } else {
    signal?.addEventListener('abort', handleAbort, { once: true });
  }

  try {
    const item = await vscode.window.showQuickPick(items, {
      placeHolder: '检测到多个 Git 仓库，请选择要生成提交消息的仓库',
      ignoreFocusOut: true
    }, cancellationTokenSource.token);
    return item?.repository;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    cancellationTokenSource.dispose();
  }
}

function getRepositoryFromContext(
  context: unknown,
  repositories: Repository[]
): Repository | undefined {
  if (!context) {
    return undefined;
  }

  if (Array.isArray(context)) {
    for (const item of context) {
      const repository = getRepositoryFromContext(item, repositories);
      if (repository) {
        return repository;
      }
    }
    return undefined;
  }

  if (isRepository(context)) {
    return findRepositoryByUri(context.rootUri, repositories) ?? context;
  }

  if (isSourceControl(context)) {
    return context.rootUri ? findRepositoryByUri(context.rootUri, repositories) : undefined;
  }

  if (isSourceControlResourceState(context)) {
    return findRepositoryByUri(context.resourceUri, repositories);
  }

  if (isUriLike(context)) {
    return findRepositoryByUri(context, repositories);
  }

  if (typeof context !== 'object') {
    return undefined;
  }

  const candidate = context as Record<string, unknown>;
  const nestedRepository =
    getRepositoryFromContext(candidate.sourceControl, repositories)
    ?? getRepositoryFromContext(candidate.repository, repositories)
    ?? getRepositoryFromContext(candidate.resourceStates, repositories)
    ?? getRepositoryFromContext(candidate.resourceUri, repositories)
    ?? getRepositoryFromContext(candidate.originalUri, repositories)
    ?? getRepositoryFromContext(candidate.rootUri, repositories)
    ?? getRepositoryFromContext(candidate.uri, repositories);

  return nestedRepository;
}

function findRepositoryByUri(uri: vscode.Uri, repositories: Repository[]): Repository | undefined {
  if (!gitAPI) {
    return undefined;
  }

  return gitAPI.getRepository(uri) ?? repositories.find((repository) => isSameUri(repository.rootUri, uri));
}

function isSameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function isRepository(value: unknown): value is Repository {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const repository = value as Partial<Repository>;
  return isUriLike(repository.rootUri) && typeof repository.diff === 'function' && !!repository.state;
}

function isSourceControl(value: unknown): value is vscode.SourceControl {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const sourceControl = value as Partial<vscode.SourceControl>;
  return typeof sourceControl.id === 'string' && typeof sourceControl.label === 'string' && 'inputBox' in sourceControl;
}

function isSourceControlResourceState(value: unknown): value is vscode.SourceControlResourceState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const resourceState = value as Partial<vscode.SourceControlResourceState>;
  return isUriLike(resourceState.resourceUri);
}

function isUriLike(value: unknown): value is vscode.Uri {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const uri = value as Partial<vscode.Uri>;
  return (
    typeof uri.scheme === 'string'
    && typeof uri.path === 'string'
    && typeof uri.with === 'function'
    && typeof uri.toString === 'function'
  );
}
