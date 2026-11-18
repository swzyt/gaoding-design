/**
 * 直接调用宿主 LLM 生成单元创作 prompt。
 * 这里只负责组装请求、解析输出并落盘；不生成图片，也不替用户确认。
 */
import { writePrompt } from './jobs-store.js';

const system = [
  '你是稿定创作者中心的模板/素材提示词作者，输出必须是严格 JSON，不要 Markdown、不要解释。',
  'JSON 结构：',
  '{"title":"作品标题","prompt":"完整画面提示词","negative":"禁止出现的元素","layers":[{"id":"英文短横线id","role":"background|foreground|decoration|container","require_alpha":true}],"assets":[{"id":"英文短横线id","prompt":"该图层的素材描述"}]}',
  '要求：',
  '1. prompt 覆盖画面主体、构图、材质、色彩、光影、文字层级；素材话题只描述单张素材，不要写文字排版；',
  '2. 模板必须按元素分层：背景单独一层并铺满画布，人物/物件/装饰/信息容器各自独立层；文字交给原生文字层，不要写进图片层；',
  '3. 需要抠图的主体/装饰标注 require_alpha:true，并说明透明边缘要干净；',
  '4. 必须遵守话题规范里的尺寸与禁止事项，禁止出现 Logo、二维码或规范禁止的内容；',
  '5. 只输出 JSON 本体。'
].join('\n');

export function buildPromptRequest({ job, unit, spec }) {
  const brief = unit.brief ?? {};
  const lines = [
    '话题：' + (job.topic?.name ?? ''),
    '类型：' + (job.kind === 'material' ? '素材话题（产出单张素材图）' : '模板话题（分层可编辑模板）'),
    '本单元方向：' + (brief.direction ?? '自定'),
    brief.canvas?.length ? '画布：' + brief.canvas.join(' 或 ') + ' px' : null,
    brief.forbidden?.length ? '禁止事项：\n- ' + brief.forbidden.join('\n- ') : null,
    brief.materials?.length ? '关键物料：\n- ' + brief.materials.join('\n- ') : null,
    job.note ? '用户额外要求：' + job.note : null,
    '单元序号：' + (unit.index ?? 1) + ' / ' + (brief.quantity ?? 1) + '（同话题多个单元必须彼此有差异）',
    spec?.directions?.length ? '规范里的其它方向（不要与本次方向重复）：\n- ' + spec.directions.slice(0, 6).join('\n- ') : null,
    spec?.text ? '规范原文摘录：\n' + String(spec.text).slice(0, 1500) : null
  ].filter(Boolean);
  return { system, user: lines.join('\n\n') };
}

function stripFence(text) {
  const value = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(value);
  return fenced ? fenced[1] : value;
}

/** 模型的输出可能带说明文字；优先取 JSON，失败则把整段当 prompt。 */
export function parseModelPrompt(text) {
  const raw = stripFence(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(raw.slice(start, end + 1));
      if (value && typeof value.prompt === 'string' && value.prompt.trim()) {
        return {
          title: typeof value.title === 'string' ? value.title : '',
          prompt: value.prompt.trim(),
          negative: typeof value.negative === 'string' ? value.negative : '',
          layers: Array.isArray(value.layers) ? value.layers : [],
          assets: Array.isArray(value.assets) ? value.assets : []
        };
      }
    } catch {}
  }
  if (!raw) throw Error('模型没有返回内容');
  return { title: '', prompt: raw, negative: '', layers: [], assets: [] };
}

/** 收集一次流式调用的纯文本输出。 */
export async function collectStream(stream) {
  let text = '';
  let failure = null;
  const seen = new Map();
  for await (const chunk of stream) {
    const type = chunk?.type ?? 'unknown';
    seen.set(type, (seen.get(type) ?? 0) + 1);
    if (type === 'text-delta') text += chunk.text ?? '';
    if (type === 'chunk' && chunk.chunk?.type === 'text-delta') text += chunk.chunk.text ?? '';
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure?.message ?? 'model error';
  }
  if (failure) throw Error(failure);
  if (!text.trim()) throw Error('模型没有返回内容（chunks: ' + JSON.stringify([...seen]) + '）');
  return text;
}

export async function generateUnitPrompt({ job, unit, spec, llm, selection, signal }) {
  if (!llm || typeof llm.stream !== 'function') throw Error('当前宿主没有可用的 LLM 服务');
  const provider = selection?.provider;
  const model = selection?.model;
  if (!provider || !model) throw Error('没有可用的默认模型');
  const request = buildPromptRequest({ job, unit, spec });
  const stream = llm.stream({
    provider,
    model,
    system: request.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: request.user }] }],
    // 推理模型会先花掉大量 token 在 reasoning 上，额度太小会在出正文前就结束。
    maxTokens: 6000,
    temperature: 0.7,
    signal
  });
  const text = await collectStream(stream);
  const parsed = parseModelPrompt(text);
  const record = writePrompt(unit, {
    title: parsed.title || (job.topic?.name ?? ''),
    prompt: parsed.prompt,
    negative: parsed.negative,
    direction: unit.brief?.direction ?? null,
    layers: parsed.layers,
    assets: parsed.assets,
    topic: job.topic?.name ?? null
  }, { by: 'model' });
  return { unitId: unit.id, record };
}
