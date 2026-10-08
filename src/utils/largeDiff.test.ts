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
import { buildOutputTemplatePreview, DEFAULT_OUTPUT_TEMPLATE, renderOutputTemplate } from './outputTemplate';
import {
  ANTHROPIC_API_VERSION,
  buildChatCompletionStreamPayload,
  buildRequestHeaders,
  buildRequestPayload,
  extractAnthropicResponseThinking,
  extractAnthropicResponseText,
  extractAnthropicStreamText,
  extractChatCompletionStreamText,
  extractResponseReasoningTokens,
  extractResponseThinking,
  mergeRequestBodyOverrides,
  normalizeApiMode,
  requestWithThinkingFallback,
  resolveApiTarget,
  sanitizeThinkingResponseText,
  shouldFallbackThinkingRequest
} from './requestPayload';

const chineseFile = 'src/views/digitalRegulation/省内基础指标_columns配置_展开时段_含indexCode_含分工.json';
const quotedChineseFile = String.raw`src/views/digitalRegulation/\347\234\201\345\206\205\345\237\272\347\241\200\346\214\207\346\240\207_columns\351\205\215\347\275\256_\345\261\225\345\274\200\346\227\266\346\256\265_\345\220\253indexCode_\345\220\253\345\210\206\345\267\245.json`;

test('Git 八进制 UTF-8 路径还原为完整中文文件名', () => {
  const diff = `diff --git "a/${quotedChineseFile}" "b/${quotedChineseFile}"\n`;
  assert.deepEqual(extractChangedFilePaths(diff), [chineseFile]);
});

test('已解码路径按顺序去重并兼容未转义中文和空格', () => {
  const diff = [
    `diff --git "a/${quotedChineseFile}" "b/${quotedChineseFile}"`,
    `diff --git a/${chineseFile} b/${chineseFile}`,
    'diff --git a/src/中文 配置.json b/src/中文 配置.json',
    'diff --git a/src/plain.ts b/src/plain.ts'
  ].join('\n');
  assert.deepEqual(extractChangedFilePaths(diff), [chineseFile, 'src/中文 配置.json', 'src/plain.ts']);
});

test('重命名采用新路径，删除保留旧路径，兼容单侧引号', () => {
  const diff = [
    `diff --git a/src/old.json "b/${quotedChineseFile}"`,
    `diff --git "a/${quotedChineseFile}" b/src/new.json`,
    'diff --git "a/src/\\345\\210\\240\\351\\231\\244.json" /dev/null',
    'diff --git /dev/null "b/src/\\346\\226\\260.json"'
  ].join('\n');
  assert.deepEqual(extractChangedFilePaths(diff), [chineseFile, 'src/new.json', 'src/删除.json', 'src/新.json']);
});

test('Git 引号和反斜杠仅解码一次，保留文件名中的字面转义序列', () => {
  const diff = String.raw`diff --git "a/src/\"省\"\\347.json" "b/src/\"省\"\\347.json"`;
  assert.deepEqual(extractChangedFilePaths(diff), [String.raw`src/"省"\347.json`]);
});

test('Git 控制字符转义与四字节 UTF-8 路径正确解码', () => {
  const diff = String.raw`diff --git "a/src/\360\237\230\200\t\n\r\a\b\f\v.json" "b/src/\360\237\230\200\t\n\r\a\b\f\v.json"`;
  assert.deepEqual(extractChangedFilePaths(diff), ['src/😀\t\n\r\x07\b\f\v.json']);
});

test('正文中的转义文本不会被当成路径解析', () => {
  const diff = buildDiff('src/plain.ts', String.raw`+const sample = "\347\234\201";`);
  assert.deepEqual(extractChangedFilePaths(diff), ['src/plain.ts']);
  assert.deepEqual(extractChangedFilePaths('diff --git "a/broken b/broken\n'), []);
});

test('中文路径贯穿分段提示词、结果校验、归并和最终模板', () => {
  const diff = `diff --git "a/${quotedChineseFile}" "b/${quotedChineseFile}"\n${'+value\n'.repeat(250)}`;
  const files = extractChangedFilePaths(diff);
  const chunks = splitDiffIntoChunks(diff, 1000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.deepEqual(extractChangedFilePaths(chunk), [chineseFile]);
    const prompt = buildPrompt(chunk);
    const fileSection = prompt.split('## 变更文件清单（按 diff 顺序）')[1].split('## Git Diff 内容')[0];
    assert.ok(fileSection.includes(`- ${chineseFile}`));
    assert.ok(fileSection.includes(`- [<变更类型>] ${chineseFile}：<变更描述>`));
    assert.ok(!fileSection.includes(quotedChineseFile));
  }
  const message = `🐞 fix: 修复指标配置\n\n变更内容：\n- [修改] ${chineseFile}：修复展开时段配置`;
  assert.equal(validateCommitMessage(message, files).valid, true);
  const merged = mergeCommitMessagesLocally([message, message], files);
  const rendered = renderOutputTemplate(DEFAULT_OUTPUT_TEMPLATE, merged.title, buildChangeLines(files, merged.changes), files);
  assert.ok(rendered.includes(`- [修改] ${chineseFile}：修复展开时段配置`));
  assert.ok(rendered.includes(`涉及组件：\n- ${chineseFile}`));
  assert.ok(!rendered.includes(quotedChineseFile));
  assert.ok(buildMergePrompt([message], { fileList: files }).includes(`- ${chineseFile}`));
});

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
    10000,
    { enabled: true, effort: 'medium' }
  ).payload;
  const chatPayload = buildRequestPayload(
    { mode: 'openai-chat', isOfficialOpenAiHost: false },
    'gpt-4o-mini',
    'prompt',
    10000,
    { enabled: true, effort: 'medium' }
  ).payload;
  const anthropicPayload = buildRequestPayload(
    { mode: 'anthropic', isOfficialOpenAiHost: false },
    'claude-sonnet-4-5',
    'prompt',
    10000,
    { enabled: true, effort: 'medium' }
  ).payload;

  assert.equal(responsesPayload.max_output_tokens, 10000);
  assert.equal(responsesPayload.store, false);
  assert.deepEqual(responsesPayload.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal('temperature' in responsesPayload, false);
  assert.equal(chatPayload.max_completion_tokens, 10000);
  assert.equal(chatPayload.reasoning_effort, 'medium');
  assert.equal('temperature' in chatPayload, false);
  assert.equal('store' in chatPayload, false);
  assert.equal(anthropicPayload.max_tokens, 10000);
  assert.deepEqual(anthropicPayload.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(anthropicPayload.output_config, { effort: 'medium' });
  assert.equal('temperature' in anthropicPayload, false);
  assert.equal('store' in anthropicPayload, false);
  assert.deepEqual(anthropicPayload.messages, [{ role: 'user', content: 'prompt' }]);
});

test('关闭内置思考时保留原有采样参数和 Chat token 字段', () => {
  const responsesPayload = buildRequestPayload(
    { mode: 'openai-responses', isOfficialOpenAiHost: true },
    'gpt-4o-mini',
    'prompt',
    10000,
    { enabled: false, effort: 'medium' }
  ).payload;
  const chatPayload = buildRequestPayload(
    { mode: 'openai-chat', isOfficialOpenAiHost: false },
    'gpt-4o-mini',
    'prompt',
    10000,
    { enabled: false, effort: 'medium' }
  ).payload;

  assert.equal('reasoning' in responsesPayload, false);
  assert.equal(responsesPayload.temperature, 0.7);
  assert.equal('reasoning_effort' in chatPayload, false);
  assert.equal(chatPayload.temperature, 0.7);
  assert.equal(chatPayload.max_tokens, 10000);
  assert.equal('max_completion_tokens' in chatPayload, false);
});

test('请求体 JSON 按模式深度覆盖并保护核心字段', () => {
  const built = buildRequestPayload(
    { mode: 'openai-responses', isOfficialOpenAiHost: true },
    'gpt-4o-mini',
    'prompt',
    10000,
    {
      enabled: true,
      effort: 'medium',
      overrides: {
        'openai-responses': {
          model: 'blocked',
          input: 'blocked',
          reasoning: { effort: 'high' },
          metadata: { source: 'test' }
        },
        anthropic: { output_config: { effort: 'low' } }
      }
    }
  );

  assert.equal(built.payload.model, 'gpt-4o-mini');
  assert.ok(Array.isArray(built.payload.input));
  assert.deepEqual(built.payload.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(built.payload.metadata, { source: 'test' });
  assert.deepEqual(built.ignoredOverrideFields, ['model', 'input']);
});

test('Chat 流式请求仅为官方端点默认返回 usage 且允许 JSON 覆盖', () => {
  assert.deepEqual(buildChatCompletionStreamPayload({ model: 'gpt-4o-mini' }), {
    model: 'gpt-4o-mini',
    stream: true
  });
  assert.deepEqual(buildChatCompletionStreamPayload({ model: 'gpt-4o-mini' }, true), {
    model: 'gpt-4o-mini',
    stream_options: { include_usage: true },
    stream: true
  });
  assert.deepEqual(buildChatCompletionStreamPayload({
    model: 'gpt-4o-mini',
    stream_options: { include_usage: false, custom: true }
  }, true), {
    model: 'gpt-4o-mini',
    stream_options: { include_usage: false, custom: true },
    stream: true
  });
});

test('请求体覆盖以数组和基础类型替换现有值', () => {
  const built = mergeRequestBodyOverrides(
    { metadata: { tags: ['old'], nested: { keep: true } }, temperature: 0.7 },
    { metadata: { tags: ['new'], nested: { added: true } }, temperature: null }
  );

  assert.deepEqual(built.payload.metadata, {
    tags: ['new'],
    nested: { keep: true, added: true }
  });
  assert.equal(built.payload.temperature, null);
});

test('仅思考字段不兼容时允许降级，无效等级保持报错', () => {
  assert.equal(
    shouldFallbackThinkingRequest('openai-chat', 400, 'Unknown parameter: reasoning_effort'),
    true
  );
  assert.equal(
    shouldFallbackThinkingRequest('anthropic', 400, 'adaptive thinking is not supported on this model'),
    true
  );
  assert.equal(
    shouldFallbackThinkingRequest('openai-responses', 400, 'Invalid value for reasoning effort'),
    false
  );
  assert.equal(
    shouldFallbackThinkingRequest(
      'openai-chat',
      400,
      "Unsupported value: 'high' is not supported for reasoning_effort"
    ),
    false
  );
  assert.equal(
    shouldFallbackThinkingRequest(
      'openai-responses',
      400,
      'output_config.effort high is not supported for this model'
    ),
    false
  );
  assert.equal(
    shouldFallbackThinkingRequest('openai-chat', 400, 'reasoning_effort high is not supported'),
    false
  );
  assert.equal(
    shouldFallbackThinkingRequest('openai-chat', 500, 'Unknown parameter: reasoning_effort'),
    false
  );
});

test('并发请求共享首次思考能力探测并缓存降级结果', async () => {
  const state = {
    supportByKey: new Map<string, boolean>(),
    probeByKey: new Map<string, Promise<boolean>>()
  };
  let resolveProbeRequest: (() => void) | undefined;
  let thinkingRequests = 0;
  let fallbackRequests = 0;
  const request = async (thinkingEnabled: boolean): Promise<string> => {
    if (!thinkingEnabled) {
      fallbackRequests += 1;
      return 'fallback';
    }

    thinkingRequests += 1;
    if (thinkingRequests === 1) {
      await new Promise<void>((resolve) => {
        resolveProbeRequest = resolve;
      });
      throw new Error('unsupported thinking');
    }
    return 'thinking';
  };
  const run = () => requestWithThinkingFallback(
    state,
    'openai-chat:model',
    request,
    (error) => error instanceof Error && error.message.includes('unsupported'),
    () => undefined
  );

  const first = run();
  const second = run();
  await Promise.resolve();
  assert.equal(thinkingRequests, 1);
  resolveProbeRequest?.();
  assert.deepEqual(await Promise.all([first, second]), ['fallback', 'fallback']);
  assert.equal(thinkingRequests, 1);
  assert.equal(fallbackRequests, 2);
  assert.equal(await run(), 'fallback');
  assert.equal(fallbackRequests, 3);
});

test('持久日志响应预览过滤 JSON 和流式思考内容', () => {
  const jsonPreview = sanitizeThinkingResponseText(JSON.stringify({
    choices: [{ message: { reasoning_content: 'private thinking', content: 'answer' } }]
  }));
  const streamPreview = sanitizeThinkingResponseText([
    'data: {"choices":[{"delta":{"reasoning_content":"private stream thinking"}}]}',
    'data: {"choices":[{"delta":{"content":"answer"}}]}',
    'data: [DONE]'
  ].join('\n'));

  assert.doesNotMatch(jsonPreview, /private thinking/);
  assert.match(jsonPreview, /answer/);
  assert.doesNotMatch(streamPreview, /private stream thinking/);
  assert.match(streamPreview, /answer/);
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
  const response = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [
      { type: 'thinking', thinking: 'analysis' },
      { type: 'text', text: 'first' },
      { type: 'tool_use' },
      { type: 'text', text: 'second' }
    ]
  };
  const text = extractAnthropicResponseText(response);

  assert.equal(text, 'first\nsecond');
  assert.equal(extractAnthropicResponseThinking(response), 'analysis');
});

test('三种 API 模式从标准字段提取思考摘要和 token', () => {
  const chatResponse = {
    choices: [{ message: { reasoning_content: 'chat thinking', content: 'answer' } }],
    usage: { completion_tokens_details: { reasoning_tokens: 12 } }
  };
  const responsesResponse = {
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'responses thinking' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }
    ],
    usage: { output_tokens_details: { reasoning_tokens: 18 } }
  };
  const anthropicResponse = {
    content: [
      { type: 'thinking', thinking: 'anthropic thinking' },
      { type: 'text', text: 'answer' }
    ],
    usage: { input_tokens: 10, output_tokens: 24 }
  };

  assert.equal(extractResponseThinking('openai-chat', chatResponse), 'chat thinking');
  assert.equal(extractResponseReasoningTokens('openai-chat', chatResponse), 12);
  assert.equal(extractResponseThinking('openai-responses', responsesResponse), 'responses thinking');
  assert.equal(extractResponseReasoningTokens('openai-responses', responsesResponse), 18);
  assert.equal(extractResponseThinking('anthropic', anthropicResponse), 'anthropic thinking');
  assert.equal(extractResponseReasoningTokens('anthropic', anthropicResponse), undefined);
});

test('OpenAI Chat 流式响应分别拼接正文和思考内容', () => {
  const result = extractChatCompletionStreamText([
    'data: {"choices":[{"delta":{"reasoning_content":"think\\n"}}]}',
    'data: {bad json}',
    'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}',
    'data: {"choices":[{"delta":{"content":"first\\n"}}]}',
    'data: {"choices":[{"delta":{"content":"second"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":8,"total_tokens":13,"completion_tokens_details":{"reasoning_tokens":3}}}',
    'data: [DONE]'
  ].join('\n'));

  assert.equal(result.text, 'first\nsecond');
  assert.equal(result.thinking, 'think\nmore');
  assert.equal(result.usage?.completion_tokens_details?.reasoning_tokens, 3);
});

test('Anthropic 流式响应拼接文本并合并累计用量', () => {
  const result = extractAnthropicStreamText([
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}',
    '',
    'data: {bad json}',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"first\\n"}}',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think\\n"}}',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"more"}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"second"}}',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":8}}',
    'event: message_stop',
    'data: {"type":"message_stop"}'
  ].join('\n'));

  assert.equal(result.text, 'first\nsecond');
  assert.equal(result.thinking, 'think\nmore');
  assert.deepEqual(result.usage, {
    input_tokens: 12,
    output_tokens: 8
  });
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
