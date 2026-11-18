import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeleteRejectedScript } from './delete-rejected.js';

test('delete script only targets rejected cards and confirms each deletion', () => {
  const script = buildDeleteRejectedScript({ space: 2, limit: 50, dryRun: false });
  assert.match(script, /审核不通过/, '只处理审核不通过的卡片');
  assert.match(script, /确认删除/, '必须点确认删除');
  assert.match(script, /gda-modal-confirm/, '通过确认弹窗定位按钮');
  assert.match(script, /deleted:\s*' \+ deleted|deleted \+ 1/, '统计已删数量');
  assert.match(script, /audit_cqc_status === 2/, '前后都用接口核对被拒数量');
  assert.match(script, /limit/, '要有上限，避免无限循环');
});

test('dry run never clicks delete', () => {
  const script = buildDeleteRejectedScript({ space: 2, dryRun: true });
  assert.match(script, /dryRun: true/);
  assert.match(script, /if \(dryRun\)/, 'dry run 直接返回统计');
  // dryRun 分支里不应进入删除循环
  const dryBranch = script.split('} else {')[0];
  assert.doesNotMatch(dryBranch, /confirm\(\)/, 'dry run 分支不能有确认动作');
});

test('deletion halts immediately when the count did not drop', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./delete-rejected.js', import.meta.url), 'utf8');
  assert.match(source, /delete-unconfirmed:halt/, '未确认删除要标记并停止');
  const haltBranch = source.split('delete-unconfirmed:halt')[1] ?? '';
  assert.match(haltBranch.slice(0, 200), /break/, '未确认时必须 break，不能继续点下一张');
  assert.doesNotMatch(source, /delete-unconfirmed'\),\s*await p\.waitForTimeout/, '不能再带着未确认状态继续循环');
});
