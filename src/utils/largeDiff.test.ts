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
  createLengthLimitedBatches,
  mapWithConcurrency,
  mergeCommitMessagesLocally,
  splitDiffIntoChunks
} from './largeDiff';
import { extractChangedFilePaths } from './diff';
import { buildMergePrompt, buildPrompt, getDefaultMergePrompt, getDefaultPrompt } from './prompt';

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
    '✨ feat(core): 新增能力\n\n修改内容：\n- src/a.ts：新增解析逻辑',
    '🐞 fix(core): 修复边界\n\n修改内容：\n- src/a.ts：修复空值处理\n- src/b.ts：补充调用逻辑'
  ];
  const result = mergeCommitMessagesLocally(messages, ['src/a.ts', 'src/b.ts']);

  assert.equal(result.title, '✨ feat(core): 新增能力；🐞 fix(core): 修复边界');
  assert.equal(result.descriptions.get('src/a.ts'), '新增解析逻辑；修复空值处理');
  assert.equal(result.descriptions.get('src/b.ts'), '补充调用逻辑');
});

test('远程归并使用独立提示词和完整输出模板', () => {
  const prompt = buildMergePrompt(['✨ feat: 新增能力'], {
    mergePrompt: '自定义归并规则',
    fileList: ['src/a.ts']
  });

  assert.match(prompt, /^自定义归并规则/);
  assert.match(prompt, /- src\/a\.ts：<一句话描述>/);
  assert.match(prompt, /### 分段结果 1/);
});

test('内置提示词长度与设置说明保持一致', () => {
  assert.equal(getDefaultPrompt().length, 1920);
  assert.equal(buildPrompt('', { fileList: [] }).length, 1972);
  assert.equal(getDefaultMergePrompt().length, 192);
  assert.equal(buildMergePrompt([], { fileList: [] }).length, 294);
});

function buildDiff(file: string, content: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${content}`;
}
