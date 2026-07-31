/**
 * @name: AI 请求负载工具
 * @Descripttion: 构建 Chat Completions 与 Responses API 的统一请求参数
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-07-29 16:41:42
 * @LastEditTime: 2026-07-29 16:41:42
 * @FilePath: src/utils/requestPayload.ts
 */

export type ApiMode = 'auto' | 'anthropic' | 'openai-chat' | 'openai-responses';
export type ResolvedApiMode = Exclude<ApiMode, 'auto'>;

export interface RequestPayloadTarget {
  mode: ResolvedApiMode;
  isOfficialOpenAiHost: boolean;
}

export interface ResolvedApiTarget extends RequestPayloadTarget {
  endpoint: string;
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export interface AnthropicApiResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: Array<{
    type: string;
    text?: string;
  }>;
  usage?: AnthropicUsage;
}

export interface AnthropicStreamResult {
  text: string;
  usage?: AnthropicUsage;
}

const OPENAI_API_HOSTS = new Set(['api.openai.com']);
export const ANTHROPIC_API_VERSION = '2023-06-01';

export function normalizeApiMode(value: string | undefined): ApiMode | undefined {
  if (value === 'auto' || value === 'anthropic' || value === 'openai-chat' || value === 'openai-responses') {
    return value;
  }
  if (value === 'chat-completions') {
    return 'openai-chat';
  }
  if (value === 'responses') {
    return 'openai-responses';
  }
  return undefined;
}

export function resolveApiTarget(endpoint: string, configuredMode: ApiMode): ResolvedApiTarget {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return {
      endpoint: trimmed,
      mode: getFallbackMode(configuredMode),
      isOfficialOpenAiHost: false
    };
  }

  try {
    const url = new URL(trimmed);
    const rawPath = url.pathname || '/';
    const path = rawPath.replace(/\/+$/, '');
    const lowerPath = path.toLowerCase();
    const explicitMode = detectApiModeFromPath(lowerPath);
    const isOfficialOpenAiHost = OPENAI_API_HOSTS.has(url.hostname.toLowerCase());
    const mode = resolveRequestedApiMode(configuredMode, isOfficialOpenAiHost, explicitMode);

    if (explicitMode) {
      if (configuredMode !== 'auto' && explicitMode !== mode) {
        url.pathname = replaceApiEndpointPath(path, mode);
      }
      return {
        endpoint: url.toString(),
        mode,
        isOfficialOpenAiHost
      };
    }

    if (lowerPath === '' || lowerPath === '/' || lowerPath.endsWith('/v1')) {
      url.pathname = buildApiEndpointPath(path, mode);
    }

    return {
      endpoint: url.toString(),
      mode,
      isOfficialOpenAiHost
    };
  } catch {
    return {
      endpoint: trimmed,
      mode: getFallbackMode(configuredMode),
      isOfficialOpenAiHost: false
    };
  }
}

export function buildRequestHeaders(
  mode: ResolvedApiMode,
  apiKey: string,
  stream = false
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (mode === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_API_VERSION;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (stream) {
    headers.Accept = 'text/event-stream';
  }

  return headers;
}

export function buildRequestPayload(
  target: RequestPayloadTarget,
  model: string,
  prompt: string,
  maxOutputTokens: number
): Record<string, unknown> {
  const openAiStorePayload = target.isOfficialOpenAiHost && target.mode !== 'anthropic'
    ? { store: false }
    : {};

  if (target.mode === 'openai-responses') {
    return {
      model,
      input: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_output_tokens: maxOutputTokens,
      ...openAiStorePayload
    };
  }

  if (target.mode === 'anthropic') {
    return {
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: maxOutputTokens
    };
  }

  return {
    model,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.7,
    max_tokens: maxOutputTokens,
    ...openAiStorePayload
  };
}

export function extractAnthropicResponseText(data: AnthropicApiResponse): string {
  if (!Array.isArray(data.content)) {
    return '';
  }

  return data.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text || '')
    .join('\n')
    .trim();
}

export function extractAnthropicStreamText(rawStream: string): AnthropicStreamResult {
  const fragments: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let receivedMessageStart = false;
  let receivedMessageStop = false;
  let streamError: string | undefined;

  rawStream.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      return;
    }

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      return;
    }

    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const eventType = typeof parsed.type === 'string' ? parsed.type : '';
      if (eventType === 'error') {
        const error = parsed.error as Record<string, unknown> | undefined;
        const errorType = typeof error?.type === 'string' ? error.type : 'unknown_error';
        const errorMessage = typeof error?.message === 'string' ? error.message : '未知错误';
        streamError = `${errorType}: ${errorMessage}`;
        return;
      }

      if (eventType === 'content_block_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          fragments.push(delta.text);
        }
        return;
      }

      if (eventType === 'message_start') {
        receivedMessageStart = true;
        const message = parsed.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (typeof usage?.input_tokens === 'number') {
          inputTokens = usage.input_tokens;
        }
        if (typeof usage?.output_tokens === 'number') {
          outputTokens = usage.output_tokens;
        }
        return;
      }

      if (eventType === 'message_delta') {
        const usage = parsed.usage as Record<string, unknown> | undefined;
        if (typeof usage?.output_tokens === 'number') {
          outputTokens = usage.output_tokens;
        }
        return;
      }

      if (eventType === 'message_stop') {
        receivedMessageStop = true;
      }
    } catch {
      // ignore malformed stream chunks and continue collecting usable deltas
    }
  });

  if (streamError) {
    throw new Error(`Anthropic 流式响应错误：${streamError}`);
  }

  // 只有完整消息才能作为成功结果，避免连接中断时误用部分文本。
  if (!receivedMessageStart || !receivedMessageStop) {
    throw new Error('Anthropic 流式响应不完整：缺少 message_start 或 message_stop');
  }

  const usage = inputTokens !== undefined || outputTokens !== undefined
    ? { input_tokens: inputTokens, output_tokens: outputTokens }
    : undefined;

  return {
    text: fragments.join('').trim(),
    usage
  };
}

function getFallbackMode(configuredMode: ApiMode): ResolvedApiMode {
  if (configuredMode === 'anthropic' || configuredMode === 'openai-responses') {
    return configuredMode;
  }
  return 'openai-chat';
}

function detectApiModeFromPath(path: string): ResolvedApiMode | undefined {
  if (path.endsWith('/chat/completions')) {
    return 'openai-chat';
  }
  if (path.endsWith('/responses')) {
    return 'openai-responses';
  }
  if (path.endsWith('/messages')) {
    return 'anthropic';
  }
  return undefined;
}

function resolveRequestedApiMode(
  configuredMode: ApiMode,
  isOfficialOpenAiHost: boolean,
  explicitMode?: ResolvedApiMode
): ResolvedApiMode {
  if (configuredMode !== 'auto') {
    return configuredMode;
  }
  if (explicitMode === 'openai-chat' || explicitMode === 'openai-responses') {
    return explicitMode;
  }
  return isOfficialOpenAiHost ? 'openai-responses' : 'openai-chat';
}

function buildApiEndpointPath(path: string, mode: ResolvedApiMode): string {
  const endpointSuffix = mode === 'openai-responses'
    ? 'responses'
    : mode === 'anthropic'
      ? 'messages'
      : 'chat/completions';
  if (!path || path === '/') {
    return `/v1/${endpointSuffix}`;
  }
  return `${path}/${endpointSuffix}`;
}

function replaceApiEndpointPath(path: string, mode: ResolvedApiMode): string {
  const nextPath = mode === 'openai-responses'
    ? '/responses'
    : mode === 'anthropic'
      ? '/messages'
      : '/chat/completions';
  if (/\/responses$/i.test(path)) {
    return path.replace(/\/responses$/i, nextPath);
  }
  if (/\/chat\/completions$/i.test(path)) {
    return path.replace(/\/chat\/completions$/i, nextPath);
  }
  if (/\/messages$/i.test(path)) {
    return path.replace(/\/messages$/i, nextPath);
  }
  return path;
}
