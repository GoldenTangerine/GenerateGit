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
  splitDiffIntoChunks
} from './largeDiff';
import { extractChangedFilePaths } from './diff';
import { buildMergePrompt, buildPrompt, getDefaultMergePrompt, getDefaultPrompt } from './prompt';
import { buildOutputTemplatePreview, DEFAULT_OUTPUT_TEMPLATE } from './outputTemplate';
import { buildRequestPayload } from './requestPayload';

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

test('请求负载为两种 API 模式设置最大输出 token', () => {
  const responsesPayload = buildRequestPayload(
    { mode: 'responses', isOfficialOpenAiHost: true },
    'gpt-4o-mini',
    'prompt',
    10000
  );
  const chatPayload = buildRequestPayload(
    { mode: 'chat-completions', isOfficialOpenAiHost: false },
    'gpt-4o-mini',
    'prompt',
    10000
  );

  assert.equal(responsesPayload.max_output_tokens, 10000);
  assert.equal(responsesPayload.store, false);
  assert.equal(chatPayload.max_tokens, 10000);
  assert.equal('store' in chatPayload, false);
});

function assertWithinRange(length: number, range: string): void {
  const [minimum, maximum] = range.split('-').map(Number);
  assert.ok(length >= minimum && length <= maximum, `${length} 不在 ${range} 范围内`);
}

function buildDiff(file: string, content: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${content}`;
}
