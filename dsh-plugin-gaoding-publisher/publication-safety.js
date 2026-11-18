import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** An exclusive journal survives crashes. An unresolved attempt must never trigger a new submission. */
export function beginSubmission(directory, fingerprint) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'submission-attempt.json');
  const value = { schema: 1, attemptId: randomUUID(), stage: 'submission-started', fingerprint, startedAt: new Date().toISOString() };
  try { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('已有提交记录，禁止重复投稿；请先按原作品 ID 核对并恢复版权声明');
    throw error;
  }
  return { path, value };
}

export function finishSubmission(journal, result) {
  const temp = journal.path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify({ ...journal.value, stage: result.ok ? 'verified' : 'needs-reconciliation', result, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  renameSync(temp, journal.path);
}

export function priorPublication(task) {
  for (const directory of new Set([task.release, task.runDir, join(task.runDir, 'release')].filter(Boolean))) {
    const path = join(directory, 'publication.json');
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.published || value.contentId || value.submissionStartedAt || value.stage === 'submission-started') return value;
  }
  return null;
}

/** Runs in the page. Returns only plain data; no browser-controller references. */
export async function readPublishedRows() {
  const token = JSON.parse(localStorage.getItem('token') || '{}');
  const response = await fetch('/api/gaoding-art/v1/users/me/contents?page_num=1&page_size=50&query_scene=my_publish&type=0%2C2', {
    headers: { accept: 'application/json', authorization: 'Bearer ' + (token.access_token || token.token) }
  });
  if (!response.ok) throw Error('发布管理读取失败：' + response.status);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw Error('发布管理返回格式异常');
  return rows.map(row => ({ id: String(row.id), title: row.title || '', publishType: row.ugc_publish_type, declaration: row.material_declaration_status, publishStatus: row.publish_status, publishedAt: row.published_at ?? null, previewUrl: row.preview?.url ?? null }));
}

/** Conservative fallback when the success UI provides no id: only one NEW full-description match. */
export function identifyNewContent(rows, beforeIds, description, publishType) {
  const normalize = text => String(text).replace(/\s+/g, ' ').trim();
  const candidates = rows.filter(row => !beforeIds.includes(String(row.id)) && row.publishType === publishType && normalize(row.title).startsWith(normalize(description)));
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 标题匹配失败时的兜底：标题里带描述前缀不算唯一时，用「本次提交之后新出现的、类型相同」的稿件，
 * 并且必须只有一个候选，避免把别人的作品认成自己的。
 */
export function identifyRecentContent(rows, beforeIds, publishType, startedAt, slackMs = 180000) {
  if (!startedAt) return null;
  const candidates = rows.filter(row => {
    if (beforeIds.includes(String(row.id))) return false;
    if (row.publishType !== publishType) return false;
    const published = Number(row.publishedAt);
    if (!Number.isFinite(published) || published <= 0) return false;
    return published >= startedAt - slackMs;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function verifyPublication(content, topic, requireDeclaration) {
  if (!content?.id) return '未取得本次投稿的唯一作品 ID，需核对真实记录';
  if (!Array.isArray(content.topics) || content.topics.length !== 1 || content.topics[0] !== topic) return '作品详情话题不匹配';
  if (requireDeclaration && !['SUBMITTED', 'APPROVED', 'PASSED'].includes(content.declaration)) return '版权声明未获平台确认';
  return null;
}

/**
 * 释放一次「可证明没有提交」的提交记录，允许安全重试。
 * 只有日志自己证明没进入发布步骤时才允许；已发布或有内容 ID 的必须走对账恢复。
 */
export function abandonUnsubmittedAttempt(directory) {
  const path = join(directory, 'submission-attempt.json');
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const result = value.result ?? {};
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const mayHavePublished = result.published === true || Boolean(result.content?.id) || steps.includes('published') || value.stage === 'verified';
  if (mayHavePublished) throw Error('该次提交可能已经发布，禁止清除记录；请按原作品 ID 对账');
  const target = join(directory, 'submission-attempt.abandoned-' + Date.now() + '.json');
  renameSync(path, target);
  return { archived: target, error: result.error ?? null, steps };
}
