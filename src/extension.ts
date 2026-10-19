/**
 * VS Code 扩展入口
 * AI Git Commit Message Generator
 * @author sm
 */

import * as vscode from 'vscode';
import * as gitService from './services/git';
import * as aiService from './services/ai';
import * as statusBar from './handlers/statusBar';
import { Repository } from './types/git';
import {
  appendIssueFooter,
  extractIssueFromBranch,
  sanitizeRecentTitles,
  sanitizeUserHint
} from './utils/commitContext';
import * as logger from './utils/logger';

const MAX_USER_HINT_LENGTH = 500;
const MAX_TITLE_CANDIDATES = 5;
const STAGE_ALL_ACTION = '暂存全部并生成';
const WORKING_TREE_ACTION = '分析未暂存改动';

let activeGenerationController: AbortController | undefined;
// 记录各仓库最近一次生成的消息，避免重新生成时把上次结果当作提交意图
const lastGeneratedMessages = new Map<string, string>();

interface WorkflowSettings {
  functionContext: boolean;
  useInputAsHint: boolean;
  recentCommitCount: number;
  appendIssueFooter: boolean;
  titleCandidateCount: number;
}

function getWorkflowSettings(): WorkflowSettings {
  const config = vscode.workspace.getConfiguration('generateGitCommit');
  const toInteger = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return {
    functionContext: config.get<string>('diffContext') !== 'standard',
    useInputAsHint: config.get<boolean>('useInputAsHint') ?? true,
    recentCommitCount: Math.max(0, toInteger(config.get<number>('recentCommitCount'), 10)),
    appendIssueFooter: config.get<boolean>('appendIssueFooter') ?? true,
    titleCandidateCount: Math.min(
      MAX_TITLE_CANDIDATES,
      Math.max(1, toInteger(config.get<number>('titleCandidateCount'), 1))
    )
  };
}

/**
 * 扩展激活时调用
 */
export async function activate(context: vscode.ExtensionContext) {
  logger.initialize();
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
    (...args: unknown[]) => generateCommitMessageCommand(args.length <= 1 ? args[0] : args)
  );
  const cancelCommand = vscode.commands.registerCommand(
    statusBar.CANCEL_GENERATION_COMMAND,
    cancelCommitMessageGeneration
  );
  context.subscriptions.push(generateCommand, cancelCommand);

  logger.info('AI Git Commit Message Generator 扩展已激活');
}

/**
 * 生成提交消息的命令处理函数
 */
async function generateCommitMessageCommand(commandContext?: unknown) {
  if (activeGenerationController) {
    vscode.window.showInformationMessage('提交消息正在生成');
    return;
  }

  const controller = new AbortController();
  activeGenerationController = controller;
  // 生成过程中可能实时写入输入框，失败或取消时需要恢复用户原有内容
  let originalInput: { repository: Repository; value: string } | undefined;

  // 设置加载状态
  statusBar.setLoadingState();
  logger.info('开始生成提交消息...');

  try {
    const repository = await gitService.resolveRepository(commandContext, {
      promptOnAmbiguous: true,
      signal: controller.signal
    });
    if (controller.signal.aborted) {
      throw new vscode.CancellationError();
    }

    if (!repository) {
      statusBar.setNormalState();
      vscode.window.showWarningMessage('未能确定当前 Git 仓库，请在目标仓库的 SCM 面板中重试');
      logger.warn('未能确定目标仓库，取消生成');
      return;
    }

    const repositoryLabel = gitService.getRepositoryLabel(repository);
    const repositoryKey = repository.rootUri.toString();
    const settings = getWorkflowSettings();
    originalInput = { repository, value: repository.inputBox.value };

    // 暂存区为空时，询问是暂存全部还是只分析未暂存改动
    let staged = true;
    if (!gitService.hasStagedChanges(repository)) {
      if (!gitService.hasWorkingTreeChanges(repository)) {
        statusBar.setNormalState();
        vscode.window.showWarningMessage(`[${repositoryLabel}] 没有可提交的变更`);
        logger.info(`仓库 ${repositoryLabel} 没有任何变更，取消生成`);
        return;
      }
      const action = await vscode.window.showWarningMessage(
        `[${repositoryLabel}] 暂存区没有变更`,
        {
          modal: true,
          detail: `“${STAGE_ALL_ACTION}”会执行 git add -A，包含未跟踪的新文件；“${WORKING_TREE_ACTION}”只读取已跟踪文件的修改，不包含新文件，也不会改动暂存区。`
        },
        STAGE_ALL_ACTION,
        WORKING_TREE_ACTION
      );
      if (!action) {
        statusBar.setNormalState();
        logger.info('用户取消选择变更范围');
        return;
      }
      if (action === STAGE_ALL_ACTION) {
        await gitService.stageAllChanges(repository, controller.signal);
      } else {
        staged = false;
      }
    }

    const diff = await gitService.getDiff(repository, {
      staged,
      functionContext: settings.functionContext,
      signal: controller.signal
    });
    if (controller.signal.aborted) {
      throw new vscode.CancellationError();
    }

    if (!diff) {
      if (!staged) {
        statusBar.setNormalState();
        vscode.window.showWarningMessage(
          `[${repositoryLabel}] 未暂存的改动只有新文件，git diff 无法读取，请重新生成并选择“${STAGE_ALL_ACTION}”`
        );
        return;
      }
      statusBar.setErrorState();
      vscode.window.showWarningMessage(`[${repositoryLabel}] 无法获取暂存区的变更内容`);
      return;
    }

    const branchName = gitService.getCurrentBranch(repository);
    const generationContext = {
      userHint: resolveUserHint(repository, settings),
      branchName,
      recentTitles: sanitizeRecentTitles(
        await gitService.getRecentCommitMessages(repository, settings.recentCommitCount)
      )
    };
    if (generationContext.userHint) {
      logger.info(`使用输入框内容作为提交意图：${generationContext.userHint}`);
    }

    const generated = await aiService.generateCommitMessage(diff, {
      signal: controller.signal,
      context: generationContext,
      onProgress: (text) => statusBar.setLoadingState(text),
      onPartialText: (text) => {
        repository.inputBox.value = text.replace(/^```[\w-]*\n?/, '');
      }
    });
    if (controller.signal.aborted) {
      throw new vscode.CancellationError();
    }

    let commitMessage = generated.message;
    repository.inputBox.value = commitMessage;
    if (settings.titleCandidateCount > 1) {
      statusBar.setLoadingState('生成候选标题');
      const titles = await aiService.generateTitleCandidates(generated, settings.titleCandidateCount, {
        context: generationContext,
        signal: controller.signal
      });
      const pickedTitle = await pickTitle(titles, controller.signal);
      if (controller.signal.aborted) {
        throw new vscode.CancellationError();
      }
      if (pickedTitle) {
        commitMessage = [pickedTitle, ...commitMessage.split(/\r?\n/).slice(1)].join('\n');
      }
    }
    if (settings.appendIssueFooter) {
      commitMessage = appendIssueFooter(commitMessage, extractIssueFromBranch(branchName));
    }

    // 设置到 SCM 输入框
    const success = gitService.setCommitMessage(repository, commitMessage);

    if (success) {
      originalInput = undefined;
      lastGeneratedMessages.set(repositoryKey, commitMessage.trim());
      statusBar.setSuccessState();
      vscode.window.showInformationMessage(`[${repositoryLabel}] 提交消息已生成`);

      // 自动聚焦到 SCM 视图
      vscode.commands.executeCommand('workbench.view.scm');
    } else {
      statusBar.setErrorState();
      vscode.window.showErrorMessage('无法设置提交消息');
    }
  } catch (error) {
    restoreInput(originalInput);
    if (controller.signal.aborted || error instanceof vscode.CancellationError) {
      statusBar.setNormalState();
      logger.info('已取消生成提交消息');
      return;
    }

    statusBar.setErrorState();

    const errorMessage = error instanceof Error ? error.message : '未知错误';
    logger.error('生成提交消息失败', error as Error);

    vscode.window.showErrorMessage(`生成提交消息失败: ${errorMessage}`);
  } finally {
    if (activeGenerationController === controller) {
      activeGenerationController = undefined;
    }
  }
}

/**
 * 读取输入框中开发者预先填写的提交意图；与上次生成结果相同或处于合并/变基时忽略
 */
function resolveUserHint(repository: Repository, settings: WorkflowSettings): string | undefined {
  const value = repository.inputBox.value.trim();
  if (
    !settings.useInputAsHint
    || !value
    || value === lastGeneratedMessages.get(repository.rootUri.toString())
    || gitService.isMergeOrRebaseInProgress(repository)
  ) {
    return undefined;
  }
  return sanitizeUserHint(value, MAX_USER_HINT_LENGTH);
}

/**
 * 弹出候选标题列表，关闭列表时返回 undefined 并保留原标题
 */
async function pickTitle(titles: string[], signal: AbortSignal): Promise<string | undefined> {
  if (titles.length <= 1) {
    return undefined;
  }
  const tokenSource = new vscode.CancellationTokenSource();
  const handleAbort = () => tokenSource.cancel();
  signal.addEventListener('abort', handleAbort, { once: true });
  try {
    const picked = await vscode.window.showQuickPick(
      titles.map((title, index) => ({ label: title, description: index === 0 ? '当前标题' : undefined })),
      { placeHolder: '选择提交标题，按 Esc 保留当前标题', ignoreFocusOut: true },
      tokenSource.token
    );
    return picked?.label;
  } finally {
    signal.removeEventListener('abort', handleAbort);
    tokenSource.dispose();
  }
}

function restoreInput(snapshot?: { repository: Repository; value: string }): void {
  if (snapshot && snapshot.repository.inputBox.value !== snapshot.value) {
    snapshot.repository.inputBox.value = snapshot.value;
  }
}

function cancelCommitMessageGeneration(): void {
  if (!activeGenerationController) {
    return;
  }

  logger.info('正在取消生成提交消息...');
  activeGenerationController.abort();
}

/**
 * 扩展停用时调用
 */
export function deactivate() {
  logger.info('AI Git Commit Message Generator 扩展正在停用...');
  activeGenerationController?.abort();
  activeGenerationController = undefined;
  statusBar.dispose();
  logger.dispose();
}
