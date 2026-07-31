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

export type RequestBodyOverrides = Partial<Record<ResolvedApiMode, unknown>>;

export interface ThinkingRequestOptions {
  enabled: boolean;
  effort: string;
  overrides?: RequestBodyOverrides;
}

export interface BuiltRequestPayload {
  payload: Record<string, unknown>;
  ignoredOverrideFields: string[];
}

export interface ThinkingSupportState {
  supportByKey: Map<string, boolean>;
  probeByKey: Map<string, Promise<boolean>>;
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
    thinking?: string;
  }>;
  usage?: AnthropicUsage;
}

export interface AnthropicStreamResult {
  text: string;
  thinking?: string;
  usage?: AnthropicUsage;
}

export interface ChatCompletionStreamResult {
  text: string;
  thinking?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

const OPENAI_API_HOSTS = new Set(['api.openai.com']);
const PROTECTED_REQUEST_FIELDS = new Set(['model', 'messages', 'input', 'stream']);
const UNSAFE_OBJECT_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
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
  maxOutputTokens: number,
  thinking: ThinkingRequestOptions
): BuiltRequestPayload {
  const openAiStorePayload = target.isOfficialOpenAiHost && target.mode !== 'anthropic'
    ? { store: false }
    : {};
  let payload: Record<string, unknown>;

  if (target.mode === 'openai-responses') {
    payload = {
      model,
      input: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_output_tokens: maxOutputTokens,
      ...(thinking.enabled
        ? { reasoning: { effort: thinking.effort, summary: 'auto' } }
        : { temperature: 0.7 }),
      ...openAiStorePayload
    };
  } else if (target.mode === 'anthropic') {
    payload = {
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: maxOutputTokens,
      ...(thinking.enabled
        ? {
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: thinking.effort }
        }
        : { temperature: 0.7 })
    };
  } else {
    payload = {
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      ...(thinking.enabled
        ? {
          reasoning_effort: thinking.effort,
          max_completion_tokens: maxOutputTokens
        }
        : {
          temperature: 0.7,
          max_tokens: maxOutputTokens
        }),
      ...openAiStorePayload
    };
  }

  return mergeRequestBodyOverrides(payload, thinking.overrides?.[target.mode]);
}

export function buildChatCompletionStreamPayload(
  payload: Record<string, unknown>,
  includeUsage = false
): Record<string, unknown> {
  const configuredStreamOptions = payload.stream_options;
  const streamOptions = includeUsage && isPlainObject(configuredStreamOptions)
    ? { include_usage: true, ...configuredStreamOptions }
    : includeUsage && configuredStreamOptions === undefined
      ? { include_usage: true }
      : configuredStreamOptions;

  return {
    ...payload,
    ...(streamOptions !== undefined ? { stream_options: streamOptions } : {}),
    stream: true
  };
}

export function mergeRequestBodyOverrides(
  payload: Record<string, unknown>,
  overrides: unknown
): BuiltRequestPayload {
  if (!isPlainObject(overrides)) {
    return { payload, ignoredOverrideFields: [] };
  }

  const ignoredOverrideFields: string[] = [];
  const allowedOverrides: Record<string, unknown> = {};
  Object.entries(overrides).forEach(([key, value]) => {
    if (PROTECTED_REQUEST_FIELDS.has(key) || UNSAFE_OBJECT_FIELDS.has(key)) {
      ignoredOverrideFields.push(key);
      return;
    }
    allowedOverrides[key] = value;
  });

  return {
    payload: deepMergeObjects(payload, allowedOverrides),
    ignoredOverrideFields
  };
}

export async function requestWithThinkingFallback<T>(
  state: ThinkingSupportState,
  key: string,
  request: (thinkingEnabled: boolean) => Promise<T>,
  shouldDisableThinking: (error: unknown) => boolean,
  onThinkingDisabled: (error: unknown) => void
): Promise<T> {
  const cachedSupport = state.supportByKey.get(key);
  if (cachedSupport !== undefined) {
    return request(cachedSupport);
  }

  const activeProbe = state.probeByKey.get(key);
  if (activeProbe) {
    return request(await activeProbe);
  }

  let resolveProbe: (supported: boolean) => void = () => undefined;
  const probe = new Promise<boolean>((resolve) => {
    resolveProbe = resolve;
  });
  state.probeByKey.set(key, probe);

  try {
    const result = await request(true);
    state.supportByKey.set(key, true);
    resolveProbe(true);
    return result;
  } catch (error) {
    if (!shouldDisableThinking(error)) {
      resolveProbe(true);
      throw error;
    }

    state.supportByKey.set(key, false);
    resolveProbe(false);
    onThinkingDisabled(error);
    return request(false);
  } finally {
    state.probeByKey.delete(key);
  }
}

export function shouldFallbackThinkingRequest(
  mode: ResolvedApiMode,
  status: number,
  errorText: string
): boolean {
  if (status !== 400 && status !== 422) {
    return false;
  }

  const details = errorText.toLowerCase();
  if (
    /(?:invalid|unsupported)[_\s-]+(?:value|enum)/i.test(details)
    || /effort[^.]{0,80}(?:must be|one of|allowed values?)/i.test(details)
    || /["'][^"']+["'][^.]{0,80}(?:not supported|unsupported)[^.]{0,80}(?:effort|reasoning)/i.test(details)
    || /effort\s+(?!is\b|not\b)(?:["']?[^\s"']+["']?)\s+(?:is\s+)?not supported/i.test(details)
  ) {
    return false;
  }

  if (!/unsupported|not supported|unknown (?:parameter|field)|unrecognized|not permitted|does not support/i.test(details)) {
    return false;
  }

  const modeFields: Record<ResolvedApiMode, string[]> = {
    'openai-responses': ['reasoning', 'summary'],
    'openai-chat': ['reasoning_effort', 'max_completion_tokens'],
    anthropic: ['thinking', 'output_config', 'adaptive', 'display']
  };
  return modeFields[mode].some((field) => details.includes(field));
}

export function sanitizeThinkingResponseText(rawText: string): string {
  const sanitizeJson = (value: unknown): string => JSON.stringify(value, (key, fieldValue) => {
    if (key === 'reasoning_content' || key === 'thinking' || key === 'summary') {
      return '[思考内容仅输出到临时通道]';
    }
    return fieldValue;
  });

  try {
    return sanitizeJson(JSON.parse(rawText));
  } catch {
    return rawText.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        return line;
      }

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        return line;
      }

      try {
        return `data: ${sanitizeJson(JSON.parse(payload))}`;
      } catch {
        return /["'](?:reasoning_content|thinking|summary)["']\s*:/i.test(payload)
          ? 'data: [思考内容仅输出到临时通道]'
          : line;
      }
    }).join('\n');
  }
}

function deepMergeObjects(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  Object.entries(overrides).forEach(([key, value]) => {
    if (UNSAFE_OBJECT_FIELDS.has(key)) {
      return;
    }
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMergeObjects(current, value)
      : cloneJsonValue(value);
  });

  return result;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isPlainObject(value)) {
    return deepMergeObjects({}, value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function extractResponseThinking(mode: ResolvedApiMode, data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  let fragments: string[] = [];
  if (mode === 'openai-chat') {
    const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : [];
    fragments = choices.map((choice) => {
      const message = choice.message as Record<string, unknown> | undefined;
      return typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    });
  } else if (mode === 'openai-responses') {
    const output = Array.isArray(record.output) ? record.output as Array<Record<string, unknown>> : [];
    fragments = output
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => Array.isArray(item.summary) ? item.summary as Array<Record<string, unknown>> : [])
      .map((item) => typeof item.text === 'string' ? item.text : '');
  } else {
    const content = Array.isArray(record.content) ? record.content as Array<Record<string, unknown>> : [];
    fragments = content
      .filter((item) => item.type === 'thinking')
      .map((item) => typeof item.thinking === 'string' ? item.thinking : '');
  }

  const thinking = fragments.filter(Boolean).join('\n').trim();
  return thinking || undefined;
}

export function extractResponseReasoningTokens(mode: ResolvedApiMode, data: unknown): number | undefined {
  if (mode === 'anthropic' || !data || typeof data !== 'object') {
    return undefined;
  }
  const usage = (data as Record<string, unknown>).usage as Record<string, unknown> | undefined;
  if (!usage) {
    return undefined;
  }

  const detailsKey = mode === 'openai-chat' ? 'completion_tokens_details' : 'output_tokens_details';
  const details = usage[detailsKey] as Record<string, unknown> | undefined;
  return typeof details?.reasoning_tokens === 'number' ? details.reasoning_tokens : undefined;
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

export function extractAnthropicResponseThinking(data: AnthropicApiResponse): string {
  if (!Array.isArray(data.content)) {
    return '';
  }

  return data.content
    .filter((block) => block?.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking || '')
    .join('\n')
    .trim();
}

export function extractChatCompletionStreamText(rawStream: string): ChatCompletionStreamResult {
  const fragments: string[] = [];
  const thinkingFragments: string[] = [];
  let usage: ChatCompletionStreamResult['usage'];

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
      const choices = Array.isArray(parsed.choices) ? parsed.choices as Array<Record<string, unknown>> : [];
      const parsedUsage = parsed.usage as ChatCompletionStreamResult['usage'];
      if (parsedUsage) {
        usage = parsedUsage;
      }
      choices.forEach((choice) => {
        const delta = choice.delta as Record<string, unknown> | undefined;
        // 流式 delta 需直接取字符串，不做 trim，否则单独的 "\n" chunk 会被清除
        if (typeof delta?.content === 'string') {
          fragments.push(delta.content);
        }
        if (typeof delta?.reasoning_content === 'string') {
          thinkingFragments.push(delta.reasoning_content);
        }
        if (typeof delta?.content === 'string' || typeof delta?.reasoning_content === 'string') {
          return;
        }

        const message = choice.message as Record<string, unknown> | undefined;
        if (typeof message?.content === 'string') {
          fragments.push(message.content);
        }
        if (typeof message?.reasoning_content === 'string') {
          thinkingFragments.push(message.reasoning_content);
        }
        if (typeof message?.content === 'string' || typeof message?.reasoning_content === 'string') {
          return;
        }

        if (typeof choice.text === 'string') {
          fragments.push(choice.text);
        }
      });
    } catch {
      // ignore malformed stream chunks and continue collecting usable deltas
    }
  });

  return {
    text: fragments.join('').trim(),
    thinking: thinkingFragments.join('').trim() || undefined,
    usage
  };
}

export function extractAnthropicStreamText(rawStream: string): AnthropicStreamResult {
  const fragments: string[] = [];
  const thinkingFragments: string[] = [];
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
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          thinkingFragments.push(delta.thinking);
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
    thinking: thinkingFragments.join('').trim() || undefined,
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
