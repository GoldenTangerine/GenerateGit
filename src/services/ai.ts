/**
 * AI API 调用服务
 * @author sm
 */

import * as vscode from 'vscode';
import * as logger from '../utils/logger';
import {
  buildMergePrompt,
  buildPrompt,
  DEFAULT_DESCRIPTION_LENGTH_RANGE,
  DEFAULT_TITLE_LENGTH_RANGE,
  DESCRIPTION_LENGTH_RANGES,
  DescriptionLengthRange,
  TITLE_LENGTH_RANGES,
  TitleLengthRange
} from '../utils/prompt';
import { extractChangedFilePaths } from '../utils/diff';
import { DEFAULT_REDACT_PATTERNS, redactSensitiveText } from '../utils/redact';
import { DEFAULT_OUTPUT_TEMPLATE, renderOutputTemplate, resolveOutputTemplate } from '../utils/outputTemplate';
import {
  AnthropicApiResponse,
  AnthropicStreamResult,
  AnthropicUsage,
  ApiMode,
  buildRequestHeaders,
  buildRequestPayload,
  extractAnthropicResponseText,
  extractAnthropicStreamText,
  normalizeApiMode,
  ResolvedApiMode,
  ResolvedApiTarget,
  resolveApiTarget as resolveApiTargetValue
} from '../utils/requestPayload';
import {
  buildChangeLines,
  createAbortError,
  createLengthLimitedBatches,
  extractCommitTitle,
  mapWithConcurrency,
  mergeCommitMessagesLocally,
  parseFileChanges,
  retryAsyncTask,
  splitDiffIntoChunks,
  validateCommitMessage,
  waitForDelay
} from '../utils/largeDiff';

type ChatCompletionsDelivery = 'non-stream-first' | 'stream-first';
type DiffMergeMode = 'local' | 'remote';

const DEFAULT_RETRY_COUNT = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504];
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5000;
const MAX_RETRY_AFTER_MS = 60000;
const RETRYABLE_STATUS_HINT_THRESHOLD = 2;
const DEFAULT_API_ENDPOINT = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_API_MODE: ApiMode = 'auto';
const DEFAULT_CHAT_COMPLETIONS_DELIVERY: ChatCompletionsDelivery = 'non-stream-first';
const DEFAULT_MAX_DIFF_LENGTH = 10000;
const MIN_MAX_DIFF_LENGTH = 1000;
const DEFAULT_DIFF_MERGE_MODE: DiffMergeMode = 'local';
const DEFAULT_DIFF_CONCURRENCY = 1;
const MAX_DIFF_CONCURRENCY = 10;
const DEFAULT_MERGE_RETRY_COUNT = 5;
const DEFAULT_MAX_OUTPUT_TOKENS = 10000;
const MAX_MERGE_ROUNDS = 20;
const RESPONSE_BODY_READ_TIMEOUT_MS = 1200;
const RESPONSE_BODY_MAX_CHARS = 4000;
const RESPONSE_SUMMARY_MAX_CHARS = 240;
const RESPONSE_PREVIEW_MAX_CHARS = 400;

interface RequestWithRetryOptions {
  retryCount: number;
  timeoutMs: number;
  retryStatusCodes: Set<number>;
  signal?: AbortSignal;
}

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
      content: unknown;
      reasoning_content?: string;
      refusal?: string;
    };
    text?: string;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ResponsesApiResponse {
  id: string;
  object: string;
  created_at?: number;
  model: string;
  output_text?: string;
  output?: Array<{
    type: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

type ApiResponse = ChatCompletionResponse | ResponsesApiResponse | AnthropicApiResponse;

interface GenerateCommitConfig {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  apiMode: ApiMode;
  chatCompletionsDelivery: ChatCompletionsDelivery;
  customPrompt: string;
  outputTemplate: string;
  titleLengthRange: TitleLengthRange;
  descriptionLengthRange: DescriptionLengthRange;
  maxOutputTokens: number;
  redactPatterns: string[];
  maxDiffLength: number;
  diffMergeMode: DiffMergeMode;
  diffConcurrency: number;
  mergeModel: string;
  mergeRetryCount: number;
  mergePrompt: string;
  retryCount: number;
  requestTimeoutMs: number;
  retryStatusCodes: number[];
}

interface ResponseErrorDetails {
  summary: string;
  preview?: string;
  contentType?: string;
  requestId?: string;
}

interface ChatCompletionStreamResult {
  text: string;
  usage?: ChatCompletionResponse['usage'];
}

/**
 * 获取扩展配置
 */
function getConfig(): GenerateCommitConfig {
  const config = vscode.workspace.getConfiguration('generateGitCommit');
  return {
    apiEndpoint: config.get<string>('apiEndpoint') || DEFAULT_API_ENDPOINT,
    apiKey: config.get<string>('apiKey') || '',
    model: config.get<string>('model') || DEFAULT_MODEL,
    apiMode: resolveApiMode(config.get<string>('apiMode')),
    chatCompletionsDelivery: resolveChatCompletionsDelivery(config.get<string>('chatCompletionsDelivery')),
    customPrompt: config.get<string>('customPrompt') || '',
    outputTemplate: config.get<string>('outputTemplate') || '',
    titleLengthRange: resolveTitleLengthRange(config.get<string>('titleLengthRange')),
    descriptionLengthRange: resolveDescriptionLengthRange(config.get<string>('descriptionLengthRange')),
    maxOutputTokens: resolveMaxOutputTokens(config.get<number>('maxOutputTokens')),
    redactPatterns: config.get<string[]>('redactPatterns') || [],
    maxDiffLength: resolveMaxDiffLength(config.get<number>('maxDiffLength')),
    diffMergeMode: resolveDiffMergeMode(config.get<string>('diffMergeMode')),
    diffConcurrency: resolveDiffConcurrency(config.get<number>('diffConcurrency')),
    mergeModel: config.get<string>('mergeModel')?.trim() || '',
    mergeRetryCount: resolveRetryCount(
      config.get<number>('mergeRetryCount'),
      DEFAULT_MERGE_RETRY_COUNT
    ),
    mergePrompt: config.get<string>('mergePrompt') || '',
    retryCount: resolveRetryCount(config.get<number>('retryCount')),
    requestTimeoutMs: resolveTimeoutMs(config.get<number>('requestTimeoutMs')),
    retryStatusCodes: resolveRetryStatusCodes(config.get<number[]>('retryStatusCodes'))
  };
}

/**
 * 规范化 API 端点，并推断实际调用模式
 */
function resolveApiTarget(endpoint: string, configuredMode: ApiMode): ResolvedApiTarget {
  return resolveApiTargetValue(endpoint, configuredMode);
}

function resolveApiMode(value: string | undefined): ApiMode {
  const normalized = normalizeApiMode(value);
  if (normalized) {
    return normalized;
  }
  if (typeof value === 'string' && value.trim()) {
    logger.warn(`apiMode 配置无效: ${value}，已回退为 ${DEFAULT_API_MODE}`);
  }
  return DEFAULT_API_MODE;
}

function resolveChatCompletionsDelivery(value: string | undefined): ChatCompletionsDelivery {
  if (value === 'non-stream-first' || value === 'stream-first') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    logger.warn(`chatCompletionsDelivery 配置无效: ${value}，已回退为 ${DEFAULT_CHAT_COMPLETIONS_DELIVERY}`);
  }
  return DEFAULT_CHAT_COMPLETIONS_DELIVERY;
}

function describeChatCompletionsDelivery(value: ChatCompletionsDelivery): string {
  return value === 'stream-first' ? '优先流式，失败后回退非流式' : '优先非流式，缺正文时回退流式';
}

function resolveRetryCount(value: number | undefined, defaultValue = DEFAULT_RETRY_COUNT): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return defaultValue;
  }
  return Math.max(0, Math.floor(value));
}

function resolveMaxDiffLength(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_MAX_DIFF_LENGTH;
  }

  const normalized = Math.floor(value);
  if (normalized < MIN_MAX_DIFF_LENGTH) {
    logger.warn(`maxDiffLength 不能小于 ${MIN_MAX_DIFF_LENGTH}，已按最小值处理`);
    return MIN_MAX_DIFF_LENGTH;
  }
  return normalized;
}

function resolveTitleLengthRange(value: string | undefined): TitleLengthRange {
  if (value && (TITLE_LENGTH_RANGES as readonly string[]).includes(value)) {
    return value as TitleLengthRange;
  }
  if (typeof value === 'string' && value.trim()) {
    logger.warn(`titleLengthRange 配置无效: ${value}，已回退为 ${DEFAULT_TITLE_LENGTH_RANGE}`);
  }
  return DEFAULT_TITLE_LENGTH_RANGE;
}

function resolveDescriptionLengthRange(value: string | undefined): DescriptionLengthRange {
  if (value && (DESCRIPTION_LENGTH_RANGES as readonly string[]).includes(value)) {
    return value as DescriptionLengthRange;
  }
  if (typeof value === 'string' && value.trim()) {
    logger.warn(`descriptionLengthRange 配置无效: ${value}，已回退为 ${DEFAULT_DESCRIPTION_LENGTH_RANGE}`);
  }
  return DEFAULT_DESCRIPTION_LENGTH_RANGE;
}

function resolveMaxOutputTokens(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 1) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.floor(value);
}

function resolveDiffMergeMode(value: string | undefined): DiffMergeMode {
  if (value === 'local' || value === 'remote') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    logger.warn(`diffMergeMode 配置无效: ${value}，已回退为 ${DEFAULT_DIFF_MERGE_MODE}`);
  }
  return DEFAULT_DIFF_MERGE_MODE;
}

function resolveDiffConcurrency(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_DIFF_CONCURRENCY;
  }
  return Math.min(MAX_DIFF_CONCURRENCY, Math.max(1, Math.floor(value)));
}

function resolveTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function resolveRetryStatusCodes(value: number[] | undefined): number[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_RETRY_STATUS_CODES];
  }
  if (value.length === 0) {
    return [];
  }

  const normalized = value
    .map((code) => Number(code))
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);
  const unique = Array.from(new Set(normalized));

  if (unique.length === 0) {
    logger.warn('retryStatusCodes 配置无有效状态码，已回退默认配置');
    return [...DEFAULT_RETRY_STATUS_CODES];
  }

  return unique;
}

function isRetryableStatus(status: number, retryableStatusCodes: Set<number>): boolean {
  return retryableStatusCodes.has(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isAbortError(error)) {
    return true;
  }
  const message = error.message.toLowerCase();
  if (message.includes('invalid url') || message.includes('only absolute urls')) {
    return false;
  }
  return (
    message.includes('fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econn') ||
    message.includes('socket')
  );
}

function getRetryDelayMs(attempt: number): number {
  const baseDelay = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 200);
  return baseDelay + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discardResponseBody(response: Response): void {
  try {
    response.body?.cancel();
  } catch {
    // ignore: best-effort cleanup
  }
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delayMs = dateMs - Date.now();
    if (delayMs > 0) {
      return Math.min(delayMs, MAX_RETRY_AFTER_MS);
    }
  }

  return null;
}

function extractGeneratedText(mode: ResolvedApiMode, data: ApiResponse): string {
  if (mode === 'anthropic') {
    const anthropicText = tryExtractText(
      (value) => extractAnthropicResponseText(value as AnthropicApiResponse),
      data
    );
    if (anthropicText) {
      return anthropicText;
    }

    logger.errorBlock('API 响应缺少可用文本内容', buildExtractionFailureFields(mode, data));
    throw new Error('API 返回结果缺少可用文本，请查看 AI Git Commit 日志中的响应摘要');
  }

  const primaryExtractor = mode === 'openai-responses'
    ? (value: unknown) => extractResponsesText(value as ResponsesApiResponse)
    : (value: unknown) => extractChatCompletionText(value as ChatCompletionResponse);
  const fallbackExtractor = mode === 'openai-responses'
    ? (value: unknown) => extractChatCompletionText(value as ChatCompletionResponse)
    : (value: unknown) => extractResponsesText(value as ResponsesApiResponse);
  const primaryText = tryExtractText(primaryExtractor, data);
  if (primaryText) {
    return primaryText;
  }

  const fallbackText = tryExtractText(fallbackExtractor, data);
  if (fallbackText) {
    logger.warnBlock('API 响应格式与当前模式不一致，已自动回退解析', [
      { label: '当前模式', value: mode },
      { label: '回退模式', value: mode === 'openai-responses' ? 'openai-chat' : 'openai-responses' },
      { label: '对象类型', value: readStringField(data, 'object') || '未知' }
    ]);
    return fallbackText;
  }

  logger.errorBlock('API 响应缺少可用文本内容', buildExtractionFailureFields(mode, data));
  throw new Error('API 返回结果缺少可用文本，请查看 AI Git Commit 日志中的响应摘要');
}

function shouldRetryWithStream(
  mode: ResolvedApiMode,
  data: ApiResponse
): data is ChatCompletionResponse {
  if (mode !== 'openai-chat' || !('choices' in data) || !Array.isArray(data.choices) || data.choices.length === 0) {
    return false;
  }

  const objectType = readStringField(data, 'object') || '';
  if (!objectType.startsWith('chat.completion')) {
    return false;
  }

  return data.choices.some((choice) => {
    const content = extractTextFromUnknown(choice?.message?.content);
    const directText = extractTextFromUnknown(choice?.text);
    return !content && !directText && readStringField(choice?.message, 'role') === 'assistant';
  });
}

function extractChatCompletionText(data: ChatCompletionResponse): string {
  if (!data.choices || data.choices.length === 0) {
    throw new Error('API 返回结果为空');
  }

  for (const choice of data.choices) {
    const message = extractTextFromUnknown(choice?.message?.content);
    if (message) {
      return message;
    }

    const directText = extractTextFromUnknown(choice?.text);
    if (directText) {
      return directText;
    }
  }

  throw new Error('API 返回结果为空');
}

function extractResponsesText(data: ResponsesApiResponse): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data.output) || data.output.length === 0) {
    throw new Error('API 返回结果为空');
  }

  const messageText = data.output
    .filter((item) => item.type === 'message')
    .map((item) => extractTextFromUnknown(item.content))
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!messageText) {
    throw new Error('API 返回结果为空');
  }

  return messageText;
}

function tryExtractText(
  extractor: (data: unknown) => string,
  data: unknown
): string | undefined {
  try {
    const text = extractor(data);
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

function extractTextFromUnknown(value: unknown, depth = 0): string {
  if (depth > 4 || value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextFromUnknown(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const candidateKeys = ['text', 'value', 'content'];
  const fragments = candidateKeys
    .map((key) => extractTextFromUnknown(record[key], depth + 1))
    .filter(Boolean);

  if (fragments.length > 0) {
    return fragments.join('\n').trim();
  }

  return '';
}

function buildExtractionFailureFields(
  mode: ResolvedApiMode,
  data: ApiResponse
): logger.LogField[] {
  const fields: Array<logger.LogField | undefined> = [
    { label: '接口模式', value: mode },
    { label: '对象类型', value: readStringField(data, 'object') || readStringField(data, 'type') || '未知' },
    { label: '模型', value: readStringField(data, 'model') || '未知' }
  ];

  if ('choices' in data) {
    const firstChoice = data.choices?.[0];
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    fields.push(
      { label: 'choices 数量', value: Array.isArray(data.choices) ? data.choices.length : 0 },
      { label: 'finish_reason', value: readStringField(firstChoice, 'finish_reason') || '未知' },
      { label: 'content 类型', value: describeValueShape(message?.content) },
      message && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()
        ? { label: 'reasoning 摘要', value: compactText(message.reasoning_content, RESPONSE_SUMMARY_MAX_CHARS) }
        : undefined,
      message && typeof message.refusal === 'string' && message.refusal.trim()
        ? { label: 'refusal', value: compactText(message.refusal, RESPONSE_SUMMARY_MAX_CHARS) }
        : undefined,
      { label: '响应预览', value: buildSuccessfulResponsePreview(data) }
    );
  } else if ('output' in data || 'output_text' in data) {
    fields.push(
      { label: 'output 数量', value: Array.isArray(data.output) ? data.output.length : 0 },
      { label: 'output_text 类型', value: describeValueShape(data.output_text) },
      { label: '响应预览', value: buildSuccessfulResponsePreview(data) }
    );
  } else if ('content' in data) {
    fields.push(
      { label: 'content 数量', value: Array.isArray(data.content) ? data.content.length : 0 },
      { label: '响应预览', value: buildSuccessfulResponsePreview(data) }
    );
  } else {
    fields.push({ label: '响应预览', value: buildSuccessfulResponsePreview(data) });
  }

  return fields.filter((field): field is logger.LogField => Boolean(field));
}

function buildSuccessfulResponsePreview(data: ApiResponse): string {
  try {
    return compactText(JSON.stringify(data), RESPONSE_PREVIEW_MAX_CHARS);
  } catch {
    return '[响应对象无法序列化]';
  }
}

function describeValueShape(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  return typeof value;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record[key] === 'string' ? record[key] as string : undefined;
}

function createChatCompletionUsageEnvelope(
  model: string,
  usage?: ChatCompletionResponse['usage']
): ChatCompletionResponse | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    id: 'stream-fallback',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [],
    usage
  };
}

function createAnthropicUsageEnvelope(
  model: string,
  usage?: AnthropicUsage
): AnthropicApiResponse | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    id: 'stream-fallback',
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    usage
  };
}

async function requestJsonApiData(
  apiTarget: ResolvedApiTarget,
  apiKey: string,
  model: string,
  payload: Record<string, unknown>,
  options: RequestWithRetryOptions
): Promise<ApiResponse> {
  return requestWithRetry(apiTarget.endpoint, {
    method: 'POST',
    headers: buildRequestHeaders(apiTarget.mode, apiKey),
    body: JSON.stringify(payload)
  }, options, async (response) => {
    if (!response.ok) {
      const responseDetails = await extractResponseErrorDetails(response);
      logger.errorBlock('API 请求失败', buildResponseLogFields(response, responseDetails, [
        { label: '接口地址', value: apiTarget.endpoint },
        { label: '接口模式', value: apiTarget.mode },
        { label: '模型', value: model }
      ]));
      throw new Error(buildHttpErrorMessage(response.status, response.statusText, apiTarget));
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const bodyPreview = await response.text();
      const preview = bodyPreview.substring(0, 200);
      logger.errorBlock('API 响应格式异常', [
        { label: '响应类型', value: contentType || '未知' },
        { label: '接口地址', value: apiTarget.endpoint },
        { label: '响应预览', value: compactText(preview, 200) || '响应体为空' }
      ]);

      if (bodyPreview.trimStart().startsWith('<') || contentType.includes('text/html')) {
        throw new Error(
          'API 端点返回了 HTML 页面而非 JSON 数据，请检查 API 地址是否正确。当前端点: ' + apiTarget.endpoint
        );
      }

      throw new Error(
        `API 端点返回了非 JSON 格式的数据 (Content-Type: ${contentType})，请检查 API 配置`
      );
    }

    return await response.json() as ApiResponse;
  });
}

async function resolveChatCompletionsMessage(
  apiTarget: ResolvedApiTarget,
  config: GenerateCommitConfig,
  requestPayload: Record<string, unknown>,
  requestOptions: RequestWithRetryOptions
): Promise<{ text: string; usageData?: ApiResponse }> {
  if (config.chatCompletionsDelivery === 'stream-first') {
    try {
      const streamResult = await requestChatCompletionTextFromStream(
        apiTarget.endpoint,
        config.apiKey,
        requestPayload,
        requestOptions
      );
      return {
        text: streamResult.text,
        usageData: createChatCompletionUsageEnvelope(config.model, streamResult.usage)
      };
    } catch (error) {
      if (requestOptions.signal?.aborted) {
        throw createAbortError();
      }
      logger.warnBlock('优先流式解析失败，准备回退到非流式请求', [
        { label: '接口地址', value: apiTarget.endpoint },
        { label: '模型', value: config.model },
        error instanceof Error ? { label: '错误信息', value: error.message } : undefined
      ]);
    }
  }

  const data = await requestJsonApiData(apiTarget, config.apiKey, config.model, requestPayload, requestOptions);
  if (config.chatCompletionsDelivery === 'non-stream-first' && shouldRetryWithStream(apiTarget.mode, data)) {
    logger.warnBlock('检测到非流式响应缺少正文，准备回退到流式解析', [
      { label: '接口地址', value: apiTarget.endpoint },
      { label: '模型', value: config.model },
      { label: '对象类型', value: readStringField(data, 'object') || '未知' }
    ]);
    const streamResult = await requestChatCompletionTextFromStream(
      apiTarget.endpoint,
      config.apiKey,
      requestPayload,
      requestOptions
    );
    return {
      text: streamResult.text,
      usageData: createChatCompletionUsageEnvelope(config.model, streamResult.usage) || data
    };
  }

  return {
    text: extractGeneratedText(apiTarget.mode, data),
    usageData: data
  };
}

async function resolveAnthropicMessage(
  apiTarget: ResolvedApiTarget,
  config: GenerateCommitConfig,
  requestPayload: Record<string, unknown>,
  requestOptions: RequestWithRetryOptions
): Promise<{ text: string; usageData?: ApiResponse }> {
  if (config.chatCompletionsDelivery === 'stream-first') {
    try {
      const streamResult = await requestAnthropicTextFromStream(
        apiTarget.endpoint,
        config.apiKey,
        requestPayload,
        requestOptions
      );
      return {
        text: streamResult.text,
        usageData: createAnthropicUsageEnvelope(config.model, streamResult.usage)
      };
    } catch (error) {
      if (requestOptions.signal?.aborted) {
        throw createAbortError();
      }
      logger.warnBlock('Anthropic 优先流式解析失败，准备回退到非流式请求', [
        { label: '接口地址', value: apiTarget.endpoint },
        { label: '模型', value: config.model },
        error instanceof Error ? { label: '错误信息', value: error.message } : undefined
      ]);
    }
  }

  const data = await requestJsonApiData(apiTarget, config.apiKey, config.model, requestPayload, requestOptions);
  if (
    config.chatCompletionsDelivery === 'non-stream-first'
    && !extractAnthropicResponseText(data as AnthropicApiResponse)
  ) {
    logger.warnBlock('检测到 Anthropic 非流式响应缺少正文，准备回退到流式解析', [
      { label: '接口地址', value: apiTarget.endpoint },
      { label: '模型', value: config.model },
      { label: '对象类型', value: readStringField(data, 'type') || '未知' }
    ]);
    const streamResult = await requestAnthropicTextFromStream(
      apiTarget.endpoint,
      config.apiKey,
      requestPayload,
      requestOptions
    );
    return {
      text: streamResult.text,
      usageData: createAnthropicUsageEnvelope(config.model, streamResult.usage) || data
    };
  }

  return {
    text: extractGeneratedText(apiTarget.mode, data),
    usageData: data
  };
}

async function requestAnthropicTextFromStream(
  endpoint: string,
  apiKey: string,
  payload: Record<string, unknown>,
  options: RequestWithRetryOptions
): Promise<AnthropicStreamResult> {
  return requestWithRetry(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders('anthropic', apiKey, true),
    body: JSON.stringify({
      ...payload,
      stream: true
    })
  }, options, async (response) => {
    if (!response.ok) {
      const responseDetails = await extractResponseErrorDetails(response);
      logger.errorBlock('Anthropic 流式请求失败', buildResponseLogFields(response, responseDetails, [
        { label: '接口地址', value: endpoint }
      ]));
      throw new Error(buildStatusLabel(response));
    }

    const rawStream = await response.text();
    const streamResult = extractAnthropicStreamText(rawStream);
    if (streamResult.text) {
      return streamResult;
    }

    logger.errorBlock('Anthropic 流式响应未提取到正文', [
      { label: '接口地址', value: endpoint },
      { label: '响应预览', value: compactText(rawStream, RESPONSE_PREVIEW_MAX_CHARS) || '响应体为空' }
    ]);
    throw new Error('Anthropic 流式响应中未包含可用文本');
  });
}

async function requestChatCompletionTextFromStream(
  endpoint: string,
  apiKey: string,
  payload: Record<string, unknown>,
  options: RequestWithRetryOptions
): Promise<ChatCompletionStreamResult> {
  return requestWithRetry(endpoint, {
    method: 'POST',
    headers: buildRequestHeaders('openai-chat', apiKey, true),
    body: JSON.stringify({
      ...payload,
      stream: true
    })
  }, options, async (response) => {
    if (!response.ok) {
      const responseDetails = await extractResponseErrorDetails(response);
      logger.errorBlock('流式回退请求失败', buildResponseLogFields(response, responseDetails, [
        { label: '接口地址', value: endpoint }
      ]));
      throw new Error(buildStatusLabel(response));
    }

    const rawStream = await response.text();
    const streamResult = extractChatCompletionStreamText(rawStream);
    if (streamResult.text) {
      return streamResult;
    }

    logger.errorBlock('流式回退未提取到正文', [
      { label: '接口地址', value: endpoint },
      { label: '响应预览', value: compactText(rawStream, RESPONSE_PREVIEW_MAX_CHARS) || '响应体为空' }
    ]);
    throw new Error('API 流式响应中未包含可用文本');
  });
}

function extractChatCompletionStreamText(rawStream: string): ChatCompletionStreamResult {
  const fragments: string[] = [];
  let usage: ChatCompletionResponse['usage'] | undefined;

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
      const parsedUsage = parsed.usage as ChatCompletionResponse['usage'] | undefined;
      if (parsedUsage) {
        usage = parsedUsage;
      }
      choices.forEach((choice) => {
        const delta = choice.delta as Record<string, unknown> | undefined;
        // 流式 delta 需直接取字符串，不做 trim，否则单独的 "\n" chunk 会被清除
        if (typeof delta?.content === 'string') {
          fragments.push(delta.content);
          return;
        }

        const message = choice.message as Record<string, unknown> | undefined;
        if (typeof message?.content === 'string') {
          fragments.push(message.content);
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
    usage
  };
}

function logUsage(mode: ResolvedApiMode, data: ApiResponse): void {
  if (!data.usage) {
    return;
  }

  if (mode === 'openai-responses') {
    const usage = data.usage as ResponsesApiResponse['usage'];
    logger.infoBlock('Token 使用统计', [
      { label: 'input', value: usage?.input_tokens ?? '-' },
      { label: 'output', value: usage?.output_tokens ?? '-' },
      { label: 'total', value: usage?.total_tokens ?? '-' }
    ]);
    return;
  }

  if (mode === 'anthropic') {
    const usage = data.usage as AnthropicUsage;
    const total = typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
      ? usage.input_tokens + usage.output_tokens
      : '-';
    logger.infoBlock('Token 使用统计', [
      { label: 'input', value: usage.input_tokens ?? '-' },
      { label: 'output', value: usage.output_tokens ?? '-' },
      { label: 'total', value: total }
    ]);
    return;
  }

  const usage = data.usage as ChatCompletionResponse['usage'];
  logger.infoBlock('Token 使用统计', [
    { label: 'prompt', value: usage?.prompt_tokens ?? '-' },
    { label: 'completion', value: usage?.completion_tokens ?? '-' },
    { label: 'total', value: usage?.total_tokens ?? '-' }
  ]);
}

function buildHttpErrorMessage(status: number, statusText: string, apiTarget: ResolvedApiTarget): string {
  if (status === 404) {
    return `API 请求失败: 404 Not Found，请检查 API 地址、接口模式与模型配置是否匹配。当前端点: ${apiTarget.endpoint}`;
  }

  return `API 请求失败: ${status} ${statusText}`;
}

async function extractResponseErrorDetails(response: Response): Promise<ResponseErrorDetails> {
  const contentType = response.headers.get('content-type') || undefined;
  const requestId = getResponseRequestId(response.headers);
  const bodyText = await readResponseText(response);
  const summary = summarizeResponseBody(bodyText, contentType);
  const preview = buildResponsePreview(bodyText);

  return {
    summary,
    preview: preview && preview !== summary ? preview : undefined,
    contentType,
    requestId
  };
}

function getResponseRequestId(headers: Headers): string | undefined {
  return headers.get('x-request-id')
    || headers.get('request-id')
    || headers.get('cf-ray')
    || headers.get('x-amzn-requestid')
    || undefined;
}

async function readResponseText(response: Response): Promise<string | undefined> {
  if (!response.body) {
    return readResponseTextFallback(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalChars = 0;
  let truncated = false;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    void reader.cancel('timeout');
  }, RESPONSE_BODY_READ_TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) {
        continue;
      }

      const remainingChars = RESPONSE_BODY_MAX_CHARS - totalChars;
      if (remainingChars <= 0) {
        truncated = true;
        break;
      }

      if (chunk.length > remainingChars) {
        chunks.push(chunk.slice(0, remainingChars));
        totalChars = RESPONSE_BODY_MAX_CHARS;
        truncated = true;
        break;
      }

      chunks.push(chunk);
      totalChars += chunk.length;
    }

    if (!truncated && !timedOut) {
      const tail = decoder.decode();
      if (tail) {
        const remainingChars = RESPONSE_BODY_MAX_CHARS - totalChars;
        if (tail.length > remainingChars) {
          chunks.push(tail.slice(0, Math.max(remainingChars, 0)));
          truncated = true;
        } else {
          chunks.push(tail);
        }
      }
    }
  } catch {
    // ignore and use any partial content that was already captured
  } finally {
    clearTimeout(timeoutId);
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return finalizeResponseText(chunks.join(''), {
    truncated,
    timedOut
  });
}

function summarizeResponseBody(bodyText: string | undefined, contentType?: string): string {
  if (!bodyText) {
    return '响应体为空';
  }

  const jsonMessage = extractJsonErrorMessage(bodyText);
  if (jsonMessage) {
    return compactText(jsonMessage, RESPONSE_SUMMARY_MAX_CHARS);
  }

  if (isHtmlResponse(bodyText, contentType)) {
    const htmlText = stripHtmlTags(bodyText);
    return htmlText ? `HTML 响应: ${htmlText}` : 'HTML 响应内容为空';
  }

  return compactText(bodyText, RESPONSE_SUMMARY_MAX_CHARS);
}

function buildResponsePreview(bodyText: string | undefined): string | undefined {
  if (!bodyText) {
    return undefined;
  }

  return compactText(bodyText, RESPONSE_PREVIEW_MAX_CHARS);
}

function extractJsonErrorMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return findErrorMessage(parsed);
  } catch {
    return undefined;
  }
}

function findErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findErrorMessage(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const directKeys = ['message', 'detail', 'error_description', 'msg', 'title'];
  for (const key of directKeys) {
    const found = findErrorMessage(record[key], depth + 1);
    if (found) {
      return found;
    }
  }

  const nestedKeys = ['error', 'details', 'response', 'cause'];
  for (const key of nestedKeys) {
    const found = findErrorMessage(record[key], depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function isHtmlResponse(bodyText: string, contentType?: string): boolean {
  return (contentType || '').includes('text/html') || bodyText.trimStart().startsWith('<');
}

function stripHtmlTags(text: string): string {
  return compactText(text.replace(/<[^>]+>/g, ' '), RESPONSE_SUMMARY_MAX_CHARS);
}

function compactText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength)}...`;
}

async function readResponseTextFallback(response: Response): Promise<string | undefined> {
  try {
    const text = await Promise.race([
      response.text(),
      sleep(RESPONSE_BODY_READ_TIMEOUT_MS).then(() => '__READ_TIMEOUT__')
    ]);

    if (text === '__READ_TIMEOUT__') {
      return '[响应体读取超时]';
    }

    return finalizeResponseText(text, {
      truncated: text.length > RESPONSE_BODY_MAX_CHARS,
      timedOut: false
    });
  } catch {
    return undefined;
  }
}

function finalizeResponseText(
  text: string,
  options: { truncated: boolean; timedOut: boolean }
): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return options.timedOut ? '[响应体读取超时]' : undefined;
  }

  let normalized = trimmed;
  if (normalized.length > RESPONSE_BODY_MAX_CHARS) {
    normalized = normalized.slice(0, RESPONSE_BODY_MAX_CHARS);
    options.truncated = true;
  }

  if (options.truncated) {
    normalized += ' ... [已截断]';
  }

  if (options.timedOut) {
    normalized += ' ... [读取超时]';
  }

  return normalized;
}

function buildResponseLogFields(
  response: Response,
  details: ResponseErrorDetails,
  extras: Array<logger.LogField | undefined> = []
): logger.LogField[] {
  const fields: Array<logger.LogField | undefined> = [
    { label: '状态码', value: buildStatusLabel(response) },
    ...extras,
    details.requestId ? { label: '请求 ID', value: details.requestId } : undefined,
    details.contentType ? { label: '响应类型', value: details.contentType } : undefined,
    { label: '错误摘要', value: details.summary },
    details.preview ? { label: '响应预览', value: details.preview } : undefined
  ];

  return fields.filter((field): field is logger.LogField => Boolean(field));
}

function buildStatusLabel(response: Response): string {
  return response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
}

async function requestWithRetry<T>(
  url: string,
  init: RequestInit,
  options: RequestWithRetryOptions,
  consumeResponse: (response: Response) => Promise<T>
): Promise<T> {
  const maxAttempts = options.retryCount + 1;
  let consecutiveNotFound = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    const controller = new AbortController();
    let timedOut = false;
    let retryDelayMs: number | undefined;
    const handleCancellation = () => controller.abort();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', handleCancellation, { once: true });

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });

      if (
        !response.ok &&
        isRetryableStatus(response.status, options.retryStatusCodes) &&
        attempt < maxAttempts
      ) {
        if (response.status === 404) {
          consecutiveNotFound += 1;
          if (consecutiveNotFound >= RETRYABLE_STATUS_HINT_THRESHOLD) {
            logger.warn('连续出现 404，请检查 API 端点或模型名称是否正确');
          }
        } else {
          consecutiveNotFound = 0;
        }

        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
        const delayMs = Math.max(getRetryDelayMs(attempt), retryAfterMs ?? 0);
        const responseDetails = await extractResponseErrorDetails(response);
        logger.warnBlock('API 请求可重试失败', buildResponseLogFields(response, responseDetails, [
          { label: '等待重试', value: `${delayMs}ms` },
          retryAfterMs !== null ? { label: 'Retry-After', value: `${retryAfterMs}ms` } : undefined,
          { label: '重试进度', value: `${attempt}/${maxAttempts - 1}` }
        ]));
        discardResponseBody(response);
        retryDelayMs = delayMs;
      } else {
        consecutiveNotFound = 0;
        return await consumeResponse(response);
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw createAbortError();
      }
      if (attempt < maxAttempts && (timedOut || isRetryableFetchError(error))) {
        const delayMs = getRetryDelayMs(attempt);
        const reason = timedOut ? '请求超时' : '网络异常';
        logger.warnBlock('API 请求异常，准备重试', [
          { label: '原因', value: reason },
          { label: '等待重试', value: `${delayMs}ms` },
          { label: '重试进度', value: `${attempt}/${maxAttempts - 1}` },
          error instanceof Error ? { label: '错误信息', value: error.message } : undefined
        ]);
        retryDelayMs = delayMs;
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', handleCancellation);
    }

    if (retryDelayMs !== undefined) {
      await waitForDelay(retryDelayMs, options.signal);
      continue;
    }
  }

  throw new Error('API 请求失败');
}

/**
 * 调用 AI API 生成提交消息
 */
export async function generateCommitMessage(diff: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const config = getConfig();
  const apiTarget = resolveApiTarget(config.apiEndpoint, config.apiMode);
  if (apiTarget.endpoint !== config.apiEndpoint) {
    logger.info(`API 端点已规范化: ${config.apiEndpoint} -> ${apiTarget.endpoint}`);
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
  const patterns = config.redactPatterns.length > 0 ? config.redactPatterns : DEFAULT_REDACT_PATTERNS;
  const redactionResult = redactSensitiveText(diff, patterns);
  if (redactionResult.invalidPatterns.length > 0) {
    logger.warn(`存在无效的脱敏正则：${redactionResult.invalidPatterns.join(', ')}`);
  }
  const resolvedTemplate = resolveOutputTemplate(config.outputTemplate || undefined);
  if (config.outputTemplate && resolvedTemplate === DEFAULT_OUTPUT_TEMPLATE) {
    logger.warn('outputTemplate 缺少必要占位符，已回退为默认模板');
  }

  // 对超长 diff 进行无损分段
  const diffChunks = splitDiffIntoChunks(redactionResult.text, config.maxDiffLength);

  const retryStatusLabel = config.retryStatusCodes.length > 0
    ? config.retryStatusCodes.join(', ')
    : '无';
  logger.infoBlock('准备调用 AI API', [
    { label: '接口地址', value: apiTarget.endpoint },
    { label: '接口模式', value: apiTarget.mode },
    { label: '模型', value: config.model },
    config.customPrompt
      ? { label: 'Prompt 规则', value: '自定义 Prompt 优先' }
      : { label: '标题/描述长度', value: `${config.titleLengthRange} / ${config.descriptionLengthRange}` },
    { label: '最大输出 Token', value: config.maxOutputTokens },
    { label: 'Diff 分段', value: `${diffChunks.length} 段` },
    { label: '归并方式', value: config.diffMergeMode === 'remote' ? '远程' : '本地' },
    { label: '并发数', value: config.diffConcurrency },
    config.diffMergeMode === 'remote' && diffChunks.length > 1
      ? { label: '归并模型', value: config.mergeModel || config.model }
      : undefined,
    (apiTarget.mode === 'openai-chat' || apiTarget.mode === 'anthropic')
      ? { label: '正文获取策略', value: describeChatCompletionsDelivery(config.chatCompletionsDelivery) }
      : undefined,
    { label: '重试次数', value: `${config.retryCount} 次` },
    { label: '超时时间', value: `${config.requestTimeoutMs}ms` },
    { label: '重试状态码', value: retryStatusLabel }
  ]);
  if (apiTarget.isOfficialOpenAiHost && apiTarget.mode !== 'anthropic') {
    logger.info('检测到官方 OpenAI 端点，请求将附带 store=false 以避免默认保存 diff 内容');
  }

  try {
    const requestOptions: RequestWithRetryOptions = {
      retryCount: config.retryCount,
      timeoutMs: config.requestTimeoutMs,
      retryStatusCodes: new Set(config.retryStatusCodes),
      signal
    };
    const partialMessages = await mapWithConcurrency(
      diffChunks,
      config.diffConcurrency,
      async (chunk, index) => {
        const chunkFiles = extractChangedFilePaths(chunk);
        // 构建 Prompt
        const prompt = buildPrompt(chunk, {
          customPrompt: config.customPrompt || undefined,
          fileList: chunkFiles,
          outputTemplate: resolvedTemplate,
          titleLengthRange: config.titleLengthRange,
          descriptionLengthRange: config.descriptionLengthRange
        });
        logger.info(
          `正在分析 Diff 分段 ${index + 1}/${diffChunks.length}，Diff：${chunk.length} 字符，Prompt：${prompt.length} 字符`
        );
        const contextLabel = `Diff 分段 ${index + 1}/${diffChunks.length}`;
        const result = await requestValidatedAiMessage(
          apiTarget,
          config,
          config.model,
          prompt,
          chunkFiles,
          requestOptions,
          contextLabel
        );
        if (result.usageData) {
          logUsage(apiTarget.mode, result.usageData);
        }
        return normalizeCommitMessage(result.text, chunkFiles, resolvedTemplate);
      },
      signal
    );
    const incompleteChunkIndexes = Array.from(
      { length: diffChunks.length },
      (_, index) => partialMessages[index]?.trim() ? undefined : index + 1
    ).filter((index): index is number => index !== undefined);
    if (partialMessages.length !== diffChunks.length || incompleteChunkIndexes.length > 0) {
      throw new Error(`Diff 分段分析结果不完整：${incompleteChunkIndexes.join(', ') || '分段数量不匹配'}`);
    }
    logger.info(
      partialMessages.length > 1
        ? `Diff 分段分析完成，共 ${partialMessages.length} 段，准备归并`
        : 'Diff 分段分析完成，共 1 段'
    );

    let normalizedMessage: string;
    if (partialMessages.length === 1) {
      normalizedMessage = normalizeCommitMessage(partialMessages[0], changedFiles, resolvedTemplate);
    } else if (config.diffMergeMode === 'remote') {
      normalizedMessage = await mergeCommitMessagesRemotely(
        partialMessages,
        changedFiles,
        resolvedTemplate,
        apiTarget,
        config,
        signal
      );
    } else {
      normalizedMessage = renderLocalMergedMessage(partialMessages, changedFiles, resolvedTemplate);
    }

    logger.infoBlock('提交消息生成完成', [
      { label: '涉及文件', value: changedFiles.length },
      { label: 'Diff 分段', value: diffChunks.length },
      { label: '输出模板', value: resolvedTemplate === DEFAULT_OUTPUT_TEMPLATE ? '默认模板' : '自定义模板' }
    ]);

    return normalizedMessage;
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`API 请求超时（${config.requestTimeoutMs}ms），请稍后重试或检查网络环境`);
      }
      if (error.message.includes('fetch')) {
        throw new Error('网络请求失败，请检查网络连接和 API 端点配置');
      }
      if (error.name === 'SyntaxError') {
        logger.errorBlock('API 响应 JSON 解析失败', [
          { label: '错误信息', value: error.message },
          { label: '接口地址', value: apiTarget.endpoint }
        ]);
        throw new Error(
          'API 响应内容不是有效的 JSON 格式，可能是 API 代理服务异常。请检查 API 端点地址是否正确: ' + apiTarget.endpoint
        );
      }
      throw error;
    }
    throw new Error('未知错误');
  }
}

/**
 * 使用指定模型调用现有 API 请求链路
 */
async function requestAiMessage(
  apiTarget: ResolvedApiTarget,
  config: GenerateCommitConfig,
  model: string,
  prompt: string,
  requestOptions: RequestWithRetryOptions
): Promise<{ text: string; usageData?: ApiResponse }> {
  const requestPayload = buildRequestPayload(apiTarget, model, prompt, config.maxOutputTokens);
  if (apiTarget.mode === 'openai-chat') {
    return resolveChatCompletionsMessage(
      apiTarget,
      { ...config, model },
      requestPayload,
      requestOptions
    );
  }

  if (apiTarget.mode === 'anthropic') {
    return resolveAnthropicMessage(
      apiTarget,
      { ...config, model },
      requestPayload,
      requestOptions
    );
  }

  const data = await requestJsonApiData(apiTarget, config.apiKey, model, requestPayload, requestOptions);
  return {
    text: extractGeneratedText(apiTarget.mode, data),
    usageData: data
  };
}

/**
 * 对单个 Diff 分段或归并批次执行完整请求重试
 */
async function requestValidatedAiMessage(
  apiTarget: ResolvedApiTarget,
  config: GenerateCommitConfig,
  model: string,
  prompt: string,
  files: string[],
  requestOptions: RequestWithRetryOptions,
  contextLabel: string
): Promise<{ text: string; usageData?: ApiResponse }> {
  try {
    return await retryAsyncTask(async () => {
      const result = await requestAiMessage(apiTarget, config, model, prompt, requestOptions);
      const cleanedText = cleanMarkdownCodeBlock(result.text);
      const validation = validateCommitMessage(cleanedText, files);
      if (!validation.valid) {
        const missingFields = [
          validation.missingTitle ? '标题' : undefined,
          validation.missingFiles.length > 0
            ? `文件描述（${validation.missingFiles.join(', ')}）`
            : undefined
        ].filter((value): value is string => Boolean(value));
        throw new Error(`API 返回结果缺少${missingFields.join('、')}`);
      }

      return {
        ...result,
        text: cleanedText
      };
    }, {
      retryCount: requestOptions.retryCount,
      signal: requestOptions.signal,
      getDelayMs: getRetryDelayMs,
      onRetry: (error, attempt, maxAttempts, delayMs) => {
        logger.warnBlock(`${contextLabel} 完整请求失败，准备重试`, [
          { label: '等待重试', value: `${delayMs}ms` },
          { label: '完整重试进度', value: `${attempt}/${maxAttempts - 1}` },
          { label: '错误信息', value: getErrorMessage(error) }
        ]);
      }
    });
  } catch (error) {
    if (requestOptions.signal?.aborted) {
      throw createAbortError();
    }
    const wrappedError = new Error(
      `${contextLabel} 完整请求重试耗尽：${getErrorMessage(error)}`,
      error instanceof Error ? { cause: error } : undefined
    );
    if (error instanceof Error) {
      wrappedError.name = error.name;
    }
    throw wrappedError;
  }
}

/**
 * 按长度分批并递归归并提交信息
 */
async function mergeCommitMessagesRemotely(
  messages: string[],
  files: string[],
  template: string,
  apiTarget: ResolvedApiTarget,
  config: GenerateCommitConfig,
  signal?: AbortSignal
): Promise<string> {
  const mergeModel = config.mergeModel || config.model;
  const requestOptions: RequestWithRetryOptions = {
    retryCount: config.mergeRetryCount,
    timeoutMs: config.requestTimeoutMs,
    retryStatusCodes: new Set(config.retryStatusCodes),
    signal
  };
  let current = messages;

  for (let round = 1; round <= MAX_MERGE_ROUNDS && current.length > 1; round += 1) {
    const batches = createLengthLimitedBatches(current, config.maxDiffLength);
    logger.info(`正在执行远程归并第 ${round} 轮，共 ${batches.length} 批`);
    current = await mapWithConcurrency(
      batches,
      config.diffConcurrency,
      async (batch, index) => {
        const batchFiles = findReferencedFiles(batch, files);
        logger.info(`正在归并第 ${round} 轮 ${index + 1}/${batches.length}`);
        const prompt = buildMergePrompt(batch, {
          mergePrompt: config.mergePrompt || undefined,
          fileList: batchFiles,
          outputTemplate: template,
          titleLengthRange: config.titleLengthRange,
          descriptionLengthRange: config.descriptionLengthRange
        });
        logger.info(`远程归并 Prompt 长度：${prompt.length} 字符`);
        const contextLabel = `远程归并第 ${round} 轮 ${index + 1}/${batches.length}`;
        const result = await requestValidatedAiMessage(
          apiTarget,
          config,
          mergeModel,
          prompt,
          batchFiles,
          requestOptions,
          contextLabel
        );
        if (result.usageData) {
          logUsage(apiTarget.mode, result.usageData);
        }
        return normalizeCommitMessage(result.text, batchFiles, template);
      },
      signal
    );
  }

  if (current.length !== 1) {
    throw new Error(`远程归并在 ${MAX_MERGE_ROUNDS} 轮内未能收敛，请增大 maxDiffLength 后重试`);
  }
  return normalizeCommitMessage(current[0], files, template);
}

/**
 * 从当前归并批次中筛选原始文件清单
 */
function findReferencedFiles(messages: string[], files: string[]): string[] {
  const combined = messages.join('\n');
  return files.filter((file) => combined.includes(file));
}

/**
 * 使用本地归并结果渲染最终输出模板
 */
function renderLocalMergedMessage(messages: string[], files: string[], template: string): string {
  const merged = mergeCommitMessagesLocally(messages, files);
  const title = merged.title || '🐳 chore: 更新提交信息';
  const changeLines = buildChangeLines(files, merged.changes);
  return renderOutputTemplate(template, title, changeLines, files);
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
function normalizeCommitMessage(message: string, files: string[], template: string): string {
  const trimmed = message.trim();
  const title = extractCommitTitle(trimmed) || '🐳 chore: 更新提交信息';

  if (files.length === 0) {
    return title;
  }

  const changeLines = buildChangeLines(files, parseFileChanges(trimmed, files));

  return renderOutputTemplate(template, title, changeLines, files);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}
