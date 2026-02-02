/**
 * AI API 调用服务
 * @author sm
 */

import * as vscode from 'vscode';
import * as logger from '../utils/logger';
import { buildPrompt } from '../utils/prompt';
import { extractChangedFilePaths } from '../utils/diff';

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
 * 规范化 API 端点，兼容 base URL 配置
 */
function normalizeApiEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const rawPath = url.pathname || '/';
    const path = rawPath.replace(/\/+$/, '');
    const lowerPath = path.toLowerCase();

    if (lowerPath.endsWith('/chat/completions')) {
      return url.toString();
    }

    if (lowerPath === '' || lowerPath === '/') {
      url.pathname = '/v1/chat/completions';
      return url.toString();
    }

    if (lowerPath.endsWith('/v1')) {
      url.pathname = `${path}/chat/completions`;
      return url.toString();
    }

    return url.toString();
  } catch {
    return trimmed;
  }
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
  const apiEndpoint = normalizeApiEndpoint(config.apiEndpoint);
  if (apiEndpoint !== config.apiEndpoint) {
    logger.info(`API 端点已规范化: ${config.apiEndpoint} -> ${apiEndpoint}`);
  }

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

  const changedFiles = extractChangedFilePaths(diff);

  // 截断过长的 diff
  const truncatedDiff = truncateDiff(diff, config.maxDiffLength);

  // 构建 Prompt
  const prompt = buildPrompt(truncatedDiff, config.customPrompt || undefined, changedFiles);

  logger.info(`准备调用 AI API: ${apiEndpoint}, 模型: ${config.model}`);

  try {
    const response = await fetch(apiEndpoint, {
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

    // 检查响应内容类型，防止代理返回 HTML 页面
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const bodyPreview = await response.text();
      const preview = bodyPreview.substring(0, 200);
      logger.error(`API 响应的 Content-Type 不是 JSON: ${contentType}`);
      logger.error(`响应内容预览: ${preview}`);

      if (bodyPreview.trimStart().startsWith('<') || contentType.includes('text/html')) {
        throw new Error(
          'API 端点返回了 HTML 页面而非 JSON 数据，请检查 API 地址是否正确。当前端点: ' + apiEndpoint
        );
      }

      throw new Error(
        `API 端点返回了非 JSON 格式的数据 (Content-Type: ${contentType})，请检查 API 配置`
      );
    }

    const data = await response.json() as ChatCompletionResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new Error('API 返回结果为空');
    }

    const message = data.choices[0].message.content.trim();

    // 清理可能的 markdown 代码块包裹
    const cleanedMessage = cleanMarkdownCodeBlock(message);
    const normalizedMessage = appendInvolvedFilesSection(cleanedMessage, changedFiles);

    logger.info('成功生成提交消息');
    if (data.usage) {
      logger.info(`Token 使用: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}`);
    }

    return normalizedMessage;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('fetch')) {
        throw new Error('网络请求失败，请检查网络连接和 API 端点配置');
      }
      if (error instanceof SyntaxError) {
        logger.error(`API 响应 JSON 解析失败: ${error.message}`);
        throw new Error(
          'API 响应内容不是有效的 JSON 格式，可能是 API 代理服务异常。请检查 API 端点地址是否正确: ' + apiEndpoint
        );
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

/**
 * 追加“涉及组件”列表（使用本地 diff 文件清单保证准确）
 */
function appendInvolvedFilesSection(message: string, files: string[]): string {
  const trimmed = message.trim();
  if (files.length === 0) {
    return trimmed;
  }

  const sectionHeader = '涉及组件：';
  const sectionBody = files.map((file) => `- ${file}`).join('\n');
  const sectionRegex = new RegExp(`(^|\\n)${sectionHeader}[\\s\\S]*$`);
  const base = trimmed.replace(sectionRegex, '').trim();
  const prefix = base ? `${base}\n\n` : '';

  return `${prefix}${sectionHeader}\n${sectionBody}`;
}
