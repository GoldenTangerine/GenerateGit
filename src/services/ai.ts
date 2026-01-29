/**
 * AI API 调用服务
 * @author sm
 */

import * as vscode from 'vscode';
import * as logger from '../utils/logger';
import { buildPrompt } from '../utils/prompt';

/**
 * AI API 响应结构
 */
interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * 获取扩展配置
 */
function getConfig() {
  const config = vscode.workspace.getConfiguration('generateGitCommit');
  return {
    apiEndpoint: config.get<string>('apiEndpoint') || 'https://api.openai.com/v1/chat/completions',
    apiKey: config.get<string>('apiKey') || '',
    model: config.get<string>('model') || 'gpt-4o-mini',
    customPrompt: config.get<string>('customPrompt') || '',
    maxDiffLength: config.get<number>('maxDiffLength') || 10000
  };
}

/**
 * 截断 diff 内容
 */
function truncateDiff(diff: string, maxLength: number): string {
  if (diff.length <= maxLength) {
    return diff;
  }

  logger.warn(`Diff 内容过长 (${diff.length} 字符)，将截断至 ${maxLength} 字符`);

  // 尝试在文件边界处截断
  const truncated = diff.substring(0, maxLength);
  const lastDiffHeader = truncated.lastIndexOf('\ndiff --git');

  if (lastDiffHeader > maxLength * 0.5) {
    return truncated.substring(0, lastDiffHeader) + '\n\n... (部分内容已省略)';
  }

  return truncated + '\n\n... (部分内容已省略)';
}

/**
 * 调用 AI API 生成提交消息
 */
export async function generateCommitMessage(diff: string): Promise<string> {
  const config = getConfig();

  // 检查 API Key
  if (!config.apiKey) {
    const action = await vscode.window.showErrorMessage(
      '请先配置 AI API Key',
      '打开设置'
    );
    if (action === '打开设置') {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'generateGitCommit.apiKey'
      );
    }
    throw new Error('未配置 API Key');
  }

  // 截断过长的 diff
  const truncatedDiff = truncateDiff(diff, config.maxDiffLength);

  // 构建 Prompt
  const prompt = buildPrompt(truncatedDiff, config.customPrompt || undefined);

  logger.info(`准备调用 AI API: ${config.apiEndpoint}, 模型: ${config.model}`);

  try {
    const response = await fetch(config.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`API 请求失败: ${response.status} ${response.statusText}`);
      logger.error(`错误详情: ${errorText}`);
      throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as ChatCompletionResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new Error('API 返回结果为空');
    }

    const message = data.choices[0].message.content.trim();

    // 清理可能的 markdown 代码块包裹
    const cleanedMessage = cleanMarkdownCodeBlock(message);

    logger.info('成功生成提交消息');
    if (data.usage) {
      logger.info(`Token 使用: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}`);
    }

    return cleanedMessage;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('fetch')) {
        throw new Error('网络请求失败，请检查网络连接和 API 端点配置');
      }
      throw error;
    }
    throw new Error('未知错误');
  }
}

/**
 * 清理 markdown 代码块包裹
 */
function cleanMarkdownCodeBlock(text: string): string {
  // 移除开头的 ```xxx 和结尾的 ```
  let cleaned = text;

  // 处理 ```commit 或 ``` 开头的情况
  const codeBlockMatch = cleaned.match(/^```[\w]*\n?([\s\S]*?)\n?```$/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1];
  }

  return cleaned.trim();
}
