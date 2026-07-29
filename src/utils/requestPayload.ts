/**
 * @name: AI 请求负载工具
 * @Descripttion: 构建 Chat Completions 与 Responses API 的统一请求参数
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-07-29 16:41:42
 * @LastEditTime: 2026-07-29 16:41:42
 * @FilePath: src/utils/requestPayload.ts
 */

export interface RequestPayloadTarget {
  mode: 'chat-completions' | 'responses';
  isOfficialOpenAiHost: boolean;
}

export function buildRequestPayload(
  target: RequestPayloadTarget,
  model: string,
  prompt: string,
  maxOutputTokens: number
): Record<string, unknown> {
  const openAiStorePayload = target.isOfficialOpenAiHost ? { store: false } : {};

  if (target.mode === 'responses') {
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
