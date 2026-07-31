/**
 * @name: 超长 Diff 处理测试
 * @Descripttion: 验证 Diff 无损分段、并发调度和本地归并行为
 * @version: 1.0.0
 * @Author: sm
 * @Date: 2026-07-29 14:32:36
 * @LastEditTime: 2026-07-29 14:32:36
 * @FilePath: src/utils/largeDiff.test.ts
 */

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChangeLines,
  createLengthLimitedBatches,
  extractCommitTitle,
  mapWithConcurrency,
  mergeCommitMessagesLocally,
  parseFileChanges,
  retryAsyncTask,
  splitDiffIntoChunks,
  validateCommitMessage
} from './largeDiff';
import { extractChangedFilePaths } from './diff';
import { buildMergePrompt, buildPrompt, getDefaultMergePrompt, getDefaultPrompt } from './prompt';
import { buildOutputTemplatePreview, DEFAULT_OUTPUT_TEMPLATE } from './outputTemplate';
import {
  ANTHROPIC_API_VERSION,
  buildRequestHeaders,
  buildRequestPayload,
  extractAnthropicResponseText,
  extractAnthropicStreamText,
  normalizeApiMode,
  resolveApiTarget
} from './requestPayload';

test('未超限的 diff 保持为单段', () => {
  const diff = buildDiff('src/a.ts', '+const value = 1;\n');
  assert.deepEqual(splitDiffIntoChunks(diff, 1000), [diff]);
});

test('优先按文件边界分段且不丢失内容', () => {
  const first = buildDiff('src/a.ts', `${'+a\n'.repeat(120)}`);
  const second = buildDiff('src/b.ts', `${'+b\n'.repeat(120)}`);
  const diff = first + second;
  const chunks = splitDiffIntoChunks(diff, first.length + 10);

  assert.deepEqual(chunks, [first, second]);
  assert.equal(chunks.join(''), diff);
});

test('单个超大文件按行拆分并为续段补充文件头', () => {
  const header = 'diff --git a/src/large.ts b/src/large.ts\n';
  const diff = header + `${'+const value = 1;\n'.repeat(180)}`;
  const chunks = splitDiffIntoChunks(diff, 1000);
  const restored = chunks
    .map((chunk, index) => index === 0 ? chunk : chunk.slice(header.length))
    .join('');

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  assert.ok(chunks.every((chunk) => extractChangedFilePaths(chunk)[0] === 'src/large.ts'));
  assert.equal(restored, diff);
});

test('超长单行按字符兜底且不超过上限', () => {
  const header = 'diff --git a/src/large.ts b/src/large.ts\n';
  const diff = header + `+${'x'.repeat(2500)}\n`;
  const chunks = splitDiffIntoChunks(diff, 1000);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
});

test('归并文本按上限组成批次', () => {
  const batches = createLengthLimitedBatches(['a'.repeat(700), 'b'.repeat(700), 'c'.repeat(200)], 1000);

  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.join('\n\n').length <= 1000));
  assert.equal(batches.flat().join(''), `${'a'.repeat(700)}${'b'.repeat(700)}${'c'.repeat(200)}`);
});

test('并发调度保持顺序且不超过上限', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([3, 1, 2, 0], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, value * 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [6, 2, 4, 0]);
  assert.equal(maxActive, 2);
});

test('并发任务全部完成后才进入后续归并阶段', async () => {
  const events: string[] = [];
  const results = await mapWithConcurrency([20, 5], 2, async (delay, index) => {
    events.push(`start-${index + 1}`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push(`complete-${index + 1}`);
    return `result-${index + 1}`;
  });
  events.push('merge');

  assert.deepEqual(results, ['result-1', 'result-2']);
  assert.equal(events.at(-1), 'merge');
  assert.ok(events.indexOf('merge') > events.indexOf('complete-1'));
  assert.ok(events.indexOf('merge') > events.indexOf('complete-2'));
});

test('任一并发任务失败时整体失败', async () => {
  const started: number[] = [];
  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 1) {
        throw new Error('request failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    }),
    /request failed/
  );
  assert.ok(started.length <= 2);
});

test('每个并发任务独立计算完整重试次数', async () => {
  const attempts = [0, 0];
  const results = await mapWithConcurrency([10, 20], 2, (value, index) => retryAsyncTask(async () => {
    attempts[index] += 1;
    if (index === 1 && attempts[index] < 3) {
      throw new Error('temporary failure');
    }
    return value * 2;
  }, {
    retryCount: 2,
    getDelayMs: () => 0
  }));

  assert.deepEqual(results, [20, 40]);
  assert.deepEqual(attempts, [1, 3]);
});

test('完整重试耗尽后抛出最后一次错误', async () => {
  let attempts = 0;
  await assert.rejects(
    retryAsyncTask(async () => {
      attempts += 1;
      throw new Error(`failure-${attempts}`);
    }, {
      retryCount: 2,
      getDelayMs: () => 0
    }),
    /failure-3/
  );
  assert.equal(attempts, 3);
});

test('取消后不再执行或重试任务', async () => {
  const controller = new AbortController();
  let attempts = 0;
  controller.abort();

  await assert.rejects(
    retryAsyncTask(async () => {
      attempts += 1;
      throw new Error('request failed');
    }, {
      retryCount: 5,
      signal: controller.signal
    }),
    (error: Error) => error.name === 'AbortError'
  );
  assert.equal(attempts, 0);
});

test('退避等待期间取消会立即停止后续重试', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    retryAsyncTask(async () => {
      attempts += 1;
      throw new Error('request failed');
    }, {
      retryCount: 5,
      signal: controller.signal,
      getDelayMs: () => 1000,
      onRetry: () => controller.abort()
    }),
    (error: Error) => error.name === 'AbortError'
  );
  assert.equal(attempts, 1);
});

test('模型输出需要标题和每个文件的变更描述', () => {
  const validMessage = [
    '✨ feat(core): 新增能力',
    '- [新增] src/a.ts：增加解析入口',
    '- [修改] src/b.ts：调整空值处理'
  ].join('\n');
  const missingFileMessage = [
    '✨ feat(core): 新增能力',
    '- [新增] src/a.ts：增加解析入口'
  ].join('\n');

  assert.deepEqual(validateCommitMessage(validMessage, ['src/a.ts', 'src/b.ts']), {
    valid: true,
    missingTitle: false,
    missingFiles: []
  });
  assert.deepEqual(validateCommitMessage(missingFileMessage, ['src/a.ts', 'src/b.ts']), {
    valid: false,
    missingTitle: false,
    missingFiles: ['src/b.ts']
  });
  assert.deepEqual(validateCommitMessage('- [修改] src/a.ts：调整逻辑', ['src/a.ts']), {
    valid: false,
    missingTitle: true,
    missingFiles: []
  });
});

test('本地归并直接拼接标题并合并重复文件描述', () => {
  const messages = [
    '✨ feat(core): 新增能力\n\n变更内容：\n- [新增] src/a.ts：新增解析逻辑',
    '🐞 fix(core): 修复边界\n\n变更内容：\n- [修改] src/a.ts：修复空值处理\n- [新增] src/b.ts：补充调用逻辑'
  ];
  const result = mergeCommitMessagesLocally(messages, ['src/a.ts', 'src/b.ts']);

  assert.equal(result.title, '✨ feat(core): 新增能力；🐞 fix(core): 修复边界');
  assert.deepEqual(result.changes, [
    { file: 'src/a.ts', type: '新增', description: '新增解析逻辑' },
    { file: 'src/a.ts', type: '修改', description: '修复空值处理' },
    { file: 'src/b.ts', type: '新增', description: '补充调用逻辑' }
  ]);
});

test('变更解析保留同文件多行并将异常标签标记为未分类', () => {
  const message = [
    '- [新增] src/a.ts：增加解析入口',
    '- [修改] ./src/a.ts：调整空值处理',
    '- [优化] src/b.ts：减少重复计算',
    '- src/b.ts：补充边界说明',
    '- [新增] src/a.ts：增加解析入口'
  ].join('\n');

  assert.deepEqual(parseFileChanges(message, ['src/a.ts', 'src/b.ts']), [
    { file: 'src/a.ts', type: '新增', description: '增加解析入口' },
    { file: 'src/a.ts', type: '修改', description: '调整空值处理' },
    { file: 'src/b.ts', type: '未分类', description: '减少重复计算' },
    { file: 'src/b.ts', type: '未分类', description: '补充边界说明' }
  ]);
});

test('变更行按文件清单排序并为缺失描述添加未分类兜底', () => {
  const lines = buildChangeLines(
    ['src/b.ts', 'src/a.ts', 'src/c.vue'],
    [
      { file: 'src/a.ts', type: '新增', description: '增加解析入口' },
      { file: 'src/b.ts', type: '修改', description: '调整空值处理' },
      { file: 'src/b.ts', type: '删除', description: '移除废弃分支' }
    ]
  );

  assert.deepEqual(lines, [
    '- [修改] src/b.ts：调整空值处理',
    '- [删除] src/b.ts：移除废弃分支',
    '- [新增] src/a.ts：增加解析入口',
    '- [未分类] src/c.vue：调整 c 组件逻辑'
  ]);
});

test('标题解析兼容新旧正文标题并拒绝列表行', () => {
  assert.equal(extractCommitTitle('✨ feat: 新增能力\n\n变更内容：'), '✨ feat: 新增能力');
  assert.equal(extractCommitTitle('修改内容：\n- src/a.ts：调整逻辑'), undefined);
  assert.equal(extractCommitTitle('- [修改] src/a.ts：调整逻辑'), undefined);
});

test('远程归并使用独立提示词和完整输出模板', () => {
  const prompt = buildMergePrompt(['✨ feat: 新增能力'], {
    mergePrompt: '自定义归并规则',
    fileList: ['src/a.ts']
  });

  assert.match(prompt, /^自定义归并规则/);
  assert.match(prompt, /- \[<变更类型>\] src\/a\.ts：<变更描述>/);
  assert.match(prompt, /### 分段结果 1/);
});

test('内置提示词应用标题和描述长度档位', () => {
  const prompt = getDefaultPrompt({
    titleLengthRange: '35-50',
    descriptionLengthRange: '80-130'
  });
  const mergePrompt = getDefaultMergePrompt({
    titleLengthRange: '10-20',
    descriptionLengthRange: '10-25'
  });

  assert.match(prompt, /主题长度控制在 35-50 个字符/);
  assert.match(prompt, /每条描述控制在 80-130 个字符/);
  assert.match(mergePrompt, /主题长度控制在 10-20 个字符/);
  assert.match(mergePrompt, /每条描述控制在 10-25 个字符/);
});

test('内置提示词示例符合所有标题和描述长度档位', () => {
  for (const range of ['10-20', '20-35', '35-50'] as const) {
    const prompt = getDefaultPrompt({ titleLengthRange: range });
    const title = prompt.match(/✨ feat\(components\): (.+)/)?.[1];
    assert.ok(title);
    assertWithinRange(title.length, range);
  }

  for (const range of ['10-25', '20-50', '40-80', '80-130'] as const) {
    const prompt = getDefaultPrompt({ descriptionLengthRange: range });
    const descriptions = Array.from(prompt.matchAll(/^- \[(?:新增|修改)\] .+?：(.+)$/gm), (match) => match[1]);
    assert.equal(descriptions.length, 2);
    descriptions.forEach((description) => assertWithinRange(description.length, range));
  }
});

test('自定义提示词优先且不注入内置长度规则', () => {
  const prompt = buildPrompt('', {
    customPrompt: '完全自定义规则',
    fileList: [],
    titleLengthRange: '35-50',
    descriptionLengthRange: '80-130'
  });

  assert.match(prompt, /^完全自定义规则/);
  assert.doesNotMatch(prompt, /主题长度控制在 35-50 个字符/);
  assert.doesNotMatch(prompt, /每条描述控制在 80-130 个字符/);
});

test('默认输出模板使用变更内容和分类标签', () => {
  const preview = buildOutputTemplatePreview(DEFAULT_OUTPUT_TEMPLATE, ['src/a.ts']);

  assert.match(preview, /变更内容：/);
  assert.match(preview, /- \[<变更类型>\] src\/a\.ts：<变更描述>/);
  assert.doesNotMatch(preview, /\[新增\|修改\|删除\|重命名\]/);
});

test('请求负载为三种 API 模式设置最大输出 token', () => {
  const responsesPayload = buildRequestPayload(
    { mode: 'openai-responses', isOfficialOpenAiHost: true },
    'gpt-4o-mini',
    'prompt',
    10000
  );
  const chatPayload = buildRequestPayload(
    { mode: 'openai-chat', isOfficialOpenAiHost: false },
    'gpt-4o-mini',
    'prompt',
    10000
  );
  const anthropicPayload = buildRequestPayload(
    { mode: 'anthropic', isOfficialOpenAiHost: false },
    'claude-sonnet-4-5',
    'prompt',
    10000
  );

  assert.equal(responsesPayload.max_output_tokens, 10000);
  assert.equal(responsesPayload.store, false);
  assert.equal(chatPayload.max_tokens, 10000);
  assert.equal('store' in chatPayload, false);
  assert.equal(anthropicPayload.max_tokens, 10000);
  assert.equal('store' in anthropicPayload, false);
  assert.deepEqual(anthropicPayload.messages, [{ role: 'user', content: 'prompt' }]);
});

test('接口模式兼容旧值并拒绝未知值', () => {
  assert.equal(normalizeApiMode('auto'), 'auto');
  assert.equal(normalizeApiMode('anthropic'), 'anthropic');
  assert.equal(normalizeApiMode('openai-chat'), 'openai-chat');
  assert.equal(normalizeApiMode('openai-responses'), 'openai-responses');
  assert.equal(normalizeApiMode('chat-completions'), 'openai-chat');
  assert.equal(normalizeApiMode('responses'), 'openai-responses');
  assert.equal(normalizeApiMode('unknown'), undefined);
});

test('auto 保持原有 OpenAI 路由且不自动识别 Anthropic', () => {
  assert.equal(resolveApiTarget('https://api.openai.com/v1', 'auto').mode, 'openai-responses');
  assert.equal(
    resolveApiTarget('https://api.openai.com/v1', 'auto').endpoint,
    'https://api.openai.com/v1/responses'
  );
  assert.equal(resolveApiTarget('https://example.com/v1', 'auto').mode, 'openai-chat');
  assert.equal(
    resolveApiTarget('https://example.com/v1/messages', 'auto').mode,
    'openai-chat'
  );
});

test('显式模式补全或替换对应端点路径', () => {
  assert.equal(
    resolveApiTarget('https://api.anthropic.com', 'anthropic').endpoint,
    'https://api.anthropic.com/v1/messages'
  );
  assert.equal(
    resolveApiTarget('https://example.com/v1/chat/completions', 'anthropic').endpoint,
    'https://example.com/v1/messages'
  );
  assert.equal(
    resolveApiTarget('https://example.com/v1/messages', 'openai-responses').endpoint,
    'https://example.com/v1/responses'
  );
});

test('OpenAI 与 Anthropic 使用各自标准鉴权头', () => {
  assert.deepEqual(buildRequestHeaders('openai-chat', 'openai-key', true), {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer openai-key',
    'Accept': 'text/event-stream'
  });
  assert.deepEqual(buildRequestHeaders('anthropic', 'anthropic-key'), {
    'Content-Type': 'application/json',
    'x-api-key': 'anthropic-key',
    'anthropic-version': ANTHROPIC_API_VERSION
  });
});

test('Anthropic 非流式响应仅拼接文本内容块', () => {
  const text = extractAnthropicResponseText({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [
      { type: 'thinking' },
      { type: 'text', text: 'first' },
      { type: 'tool_use' },
      { type: 'text', text: 'second' }
    ]
  });

  assert.equal(text, 'first\nsecond');
});

test('Anthropic 流式响应拼接文本并合并累计用量', () => {
  const result = extractAnthropicStreamText([
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
    '',
    'data: {bad json}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"first\\n"}}',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"ignored"}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"second"}}',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":8}}',
    'event: message_stop',
    'data: {"type":"message_stop"}'
  ].join('\n'));

  assert.equal(result.text, 'first\nsecond');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 8 });
});

test('Anthropic 流式响应在部分文本后报错时拒绝返回部分结果', () => {
  assert.throws(() => extractAnthropicStreamText([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
    'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
  ].join('\n')), /overloaded_error: Overloaded/);
});

test('Anthropic 流式响应缺少正常结束事件时拒绝返回部分结果', () => {
  assert.throws(() => extractAnthropicStreamText([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}'
  ].join('\n')), /流式响应不完整/);
});

function assertWithinRange(length: number, range: string): void {
  const [minimum, maximum] = range.split('-').map(Number);
  assert.ok(length >= minimum && length <= maximum, `${length} 不在 ${range} 范围内`);
}

function buildDiff(file: string, content: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${content}`;
}
