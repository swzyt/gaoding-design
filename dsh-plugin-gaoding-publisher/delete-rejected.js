import { spawn } from 'node:child_process';
import { egoBinary } from './publisher.js';

/**
 * 批量删除「审核不通过」的作品。
 *
 * 平台没有可用的删除接口（发布管理页走内部请求），只能在列表页逐个：
 * 卡片「更多」→「删除」→「确认删除」。为了不误删：
 * - 只处理卡片文案明确含「审核不通过」的项，已通过/审核中一律跳过；
 * - 每一步都重新读页面，不缓存元素句柄；
 * - 每删一件就重新拉列表，直到没有可删项或达到上限；
 * - dryRun 只统计数量，不动数据。
 */
export function buildDeleteRejectedScript({ space, limit = 200, dryRun = true, startedAt = null }) {
  return `
const task = await taskSpace(${JSON.stringify(space)});
const p = task.page('p1');
const steps = [];
let deleted = 0;
let remaining = null;
const dryRun = ${dryRun ? 'true' : 'false'};
const limit = ${Number(limit) || 200};
const started = ${JSON.stringify(startedAt)};

const countRejected = async () => p.evaluate(async () => {
  const token = JSON.parse(localStorage.getItem('token') || '{}');
  const headers = { authorization: 'Bearer ' + (token.access_token || token.token) };
  let total = 0;
  for (let page = 1; page <= 8; page++) {
    const rows = await fetch('/api/gaoding-art/v1/users/me/contents?page_num=' + page + '&page_size=50&query_scene=my_publish&type=2', { headers }).then(r => r.json()).catch(() => null);
    if (!Array.isArray(rows) || !rows.length) break;
    total += rows.filter(row => row.audit_cqc_status === 2).length;
    if (rows.length < 50) break;
  }
  return total;
});

await p.goto('https://www.gaoding.com/my/publish', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);
remaining = await countRejected();
steps.push('rejected-before:' + remaining);
if (dryRun) {
  console.log('GAODING_DELETE_REJECTED:' + JSON.stringify({ ok: true, dryRun: true, remaining, steps }));
} else {
  for (let round = 0; round < limit; round++) {
    // 每次重新点开第一张「审核不通过」的卡片菜单：
    // 从状态徽标向上找最近的、含「更多」按钮的祖先卡片（虚拟列表每轮都会重渲染）。
    const opened = await p.evaluate(() => {
      const badges = [...document.querySelectorAll('div,span')].filter(el => (el.innerText || '').trim() === '审核不通过');
      for (const badge of badges) {
        let node = badge;
        for (let level = 0; level < 8 && node; level++) {
          const buttons = [...node.querySelectorAll('button')];
          const more = buttons.find(b => /更多/.test(b.innerText || b.getAttribute('aria-label') || ''));
          if (more && buttons.length <= 8) {
            const cardText = node.innerText || '';
            if (/审核不通过/.test(cardText) && !/已通过/.test(cardText)) { more.click(); return true; }
            break;
          }
          node = node.parentElement;
        }
      }
      return false;
    });
    if (!opened) {
      // 可能是列表还没渲染出更多按钮：滚到底再试一次，仍失败才放弃。
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(2000);
      const retried = await p.evaluate(() => {
        const badges = [...document.querySelectorAll('div,span')].filter(el => (el.innerText || '').trim() === '审核不通过');
        for (const badge of badges) {
          let node = badge;
          for (let level = 0; level < 8 && node; level++) {
            const buttons = [...node.querySelectorAll('button')];
            const more = buttons.find(b => /更多/.test(b.innerText || b.getAttribute('aria-label') || ''));
            if (more && buttons.length <= 8) { more.click(); return true; }
            node = node.parentElement;
          }
        }
        return false;
      });
      if (!retried) { steps.push('no-rejected-card'); break; }
    }
    await p.waitForTimeout(1100);

    await p.waitForTimeout(900);
    const menu = await p.evaluate(() => {
      const items = [...document.querySelectorAll('[role=menuitem], li, div, button')]
        .filter(el => (el.innerText || '').trim() === '删除' && el.offsetParent !== null);
      const item = items[items.length - 1];
      if (!item) return false;
      item.click();
      return true;
    });
    if (!menu) { steps.push('no-delete-menu'); break; }
    await p.waitForTimeout(1200);
    const cardInfo = await p.evaluate(() => {
      const dialog = [...document.querySelectorAll('[class*=gda-modal-confirm]')].find(d => /确定要删除/.test(d.innerText || ''));
      const dialogText = dialog ? (dialog.innerText || '').replace(/\s+/g, ' ').slice(0, 80) : '';
      const badges = [...document.querySelectorAll('div,span')].filter(el => /^(审核不通过|已通过|审核中|待声明)$/.test((el.innerText || '').trim()));
      return { dialogText, badges: badges.map(b => (b.innerText || '').trim()).slice(0, 6) };
    });
    const confirmed = await p.evaluate(() => {
      const dialog = [...document.querySelectorAll('[class*=gda-modal-confirm]')].find(d => /确定要删除/.test(d.innerText || ''));
      if (!dialog) return false;
      const btn = [...dialog.querySelectorAll('button')].find(b => (b.innerText || '').trim() === '确认删除');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!confirmed) { steps.push('no-confirm-button'); break; }
    await p.waitForTimeout(3200);
    // 用接口确认真的少了一件；没减少说明这次点击没生效，记下来继续下一轮
    const after = await countRejected();
    if (after !== null && remaining !== null && after < remaining) {
      deleted += 1;
      remaining = after;
      steps.push('deleted:' + deleted);
    } else {
      steps.push('delete-unconfirmed:halt');
      // 数量没减少说明这一下点的不是被拒作品：立刻停，绝不继续点下一张。
      break;
    }
    // 列表刷新后继续；每 10 件重新载入页面，避免长时间操作后虚拟列表失步
    if (deleted % 10 === 0) {
      await p.goto('https://www.gaoding.com/my/publish', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(4000);
    }
  }
  remaining = await countRejected();
  steps.push('rejected-after:' + remaining);
  console.log('GAODING_DELETE_REJECTED:' + JSON.stringify({ ok: true, dryRun: false, deleted, remaining, steps: steps.slice(-8) }));
}
`;
}

/** 执行删除脚本：等我们自己的标记行，不依赖投稿流程的 marker。 */
export function runDeleteScript(script, { executable, spawnProcess = spawn, timeout = 1800000 } = {}) {
  const marker = 'GAODING_DELETE_REJECTED:';
  return new Promise((resolve, reject) => {
    const child = spawnProcess(egoBinary(executable), ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('批量删除超时')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = (out + '\n' + err).split('\n').filter(row => row.startsWith(marker)).pop();
      if (!line) return reject(Error('浏览器没有返回删除结果：' + (err || out).slice(-200)));
      try { resolve(JSON.parse(line.slice(marker.length))); } catch (error) { reject(error); }
    });
    child.stdin.end(script);
  });
}
