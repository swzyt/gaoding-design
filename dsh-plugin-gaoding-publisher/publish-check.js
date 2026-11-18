/**
 * 投稿前检查：图层是否真的分离、版权是否按层覆盖、审查是否仍然有效。
 * 只读真实运行产物，不写入、不替 Agent 做视觉判断。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const requiredChecks = [
  'recipe', 'layers', 'text_editable', 'image_count', 'evidence_coverage',
  'evidence_files', 'alpha', 'background', 'audit', 'restored', 'final_gate',
  'reviews', 'not_published'
];

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function sha(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

/** 读取 PNG 头部尺寸与颜色类型，不依赖图像库。 */
export function pngSize(file) {
  try {
    const buffer = readFileSync(file);
    if (buffer.length < 26 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
    return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20), colorType: buffer.readUInt8(25) };
  } catch { return null; }
}

/**
 * 素材投稿检查：单张素材，没有模板图层，检查尺寸/透明/哈希与话题规范是否一致。
 * 返回结构与 checkRun 相同，面板与接口不用分支。
 */
export function checkMaterialRun(runDir) {
  const root = resolve(runDir);
  const checks = [];
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok: !!ok, detail: String(detail) });
  const material = readJson(join(root, 'material.json'));
  if (!material) {
    add('material', '存在素材记录', false, '缺少 material.json');
    return { ok: false, checks, layers: [], summary: null, publication: null, kind: 'material' };
  }
  add('material', '存在素材记录', true, material.topic ? '话题：' + material.topic : '素材记录完整');
  const assetName = material.asset ?? 'asset.png';
  const asset = resolve(root, assetName);
  const inside = asset.startsWith(root + '/');
  add('asset_path', '素材文件在运行目录内', inside, inside ? assetName : '路径越界');
  const exists = inside && existsSync(asset);
  add('asset_file', '素材文件存在', exists, exists ? assetName : '缺少素材文件');
  const size = exists ? pngSize(asset) : null;
  const canvas = material.canvas ?? null;
  add('asset_size', '素材尺寸符合规范', !!(size && canvas && size.w === canvas.w && size.h === canvas.h),
    size && canvas ? size.w + '×' + size.h + ' / 规范 ' + canvas.w + '×' + canvas.h : '无法读取尺寸');
  const needAlpha = material.alpha === true;
  const declared = Array.isArray(material.alpha_range) ? material.alpha_range : null;
  const hasAlphaChannel = size ? (size.colorType === 6 || size.colorType === 4) : false;
  const alphaOk = !needAlpha || (hasAlphaChannel && Array.isArray(declared) && declared[0] === 0);
  add('asset_alpha', '贴纸类素材有透明背景', alphaOk,
    needAlpha ? (hasAlphaChannel ? (declared ? 'alpha ' + declared.join('–') : '缺少 alpha_range 记录') : 'PNG 没有 alpha 通道') : '非贴纸素材，不要求透明');
  const hash = exists ? sha(asset) : null;
  add('asset_sha', '素材哈希与记录一致', !!(hash && material.sha256 && hash === material.sha256),
    hash ? (material.sha256 ? '哈希一致' : '记录缺 sha256') : '无法计算哈希');
  const publication = readJson(join(root, 'publication.json'));
  const published = publication?.published === true;
  // 已投稿是终态，不是失败：面板要显示「已投稿」，不能把不重复提交说成检查未通过。
  add('not_published', published ? '已投稿（不会重复提交）' : '尚未投稿', !published,
    published ? '作品 ID ' + (publication?.contentId ?? '未知') + '，话题：' + (publication?.topics ?? []).join('、') : '未发现发布记录');
  const ok = checks.every(check => check.ok);
  return {
    ok, published, status: published ? 'published' : ok ? 'ready' : 'blocked',
    checks, layers: [], kind: 'material', publication,
    summary: {
      topic: material.topic ?? null,
      kind: 'material',
      canvas: canvas ?? null,
      assets: 1,
      concept: root,
      release: root,
      recipe: null,
      asset
    }
  };
}

/**
 * 插件自建模板稿检查：产物是 creation.json + release-recipe.json + release/，
 * 没有仓库原生工作流的 run.json / gates / 逐层审计。这里只检查能真实验证的部分，
 * 含外部图片的模板一律判失败（需要按层版权证据，插件未实现）。
 */
export function checkTemplateRun(runDir) {
  const root = resolve(runDir);
  const checks = [];
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok: !!ok, detail: String(detail) });
  const creation = readJson(join(root, 'creation.json'));
  add('creation', '存在模板创作记录', !!(creation && creation.kind === 'template'),
    creation ? (creation.status === 'complete' ? '创作完成' : '状态：' + String(creation.status)) : '缺少 creation.json');
  const recipeFile = join(root, 'release-recipe.json');
  const recipe = readJson(recipeFile);
  const layers = Array.isArray(recipe?.layers) ? recipe.layers : [];
  const canvas = recipe?.canvas ?? creation?.canvas ?? null;
  add('recipe', '发布配方存在', !!recipe && layers.length > 0 && !!canvas, recipe ? layers.length + ' 个图层' : '缺少 release-recipe.json');

  const ids = layers.map(layer => layer.id).filter(Boolean);
  add('layer_ids', '每层都有唯一 ID', ids.length === layers.length && new Set(ids).size === ids.length,
    ids.length + '/' + layers.length + ' 个图层有唯一 ID');

  const textLayers = layers.filter(layer => layer.type === 'text');
  const textState = textLayers.every(layer => typeof layer.text === 'string' && layer.text.trim() && layer.font && layer.gd_font);
  add('text_native', '文字是可编辑原生文字', textLayers.length > 0 && textState,
    textLayers.length ? textLayers.length + ' 个原生文字层' + (textState ? '' : '，有图层缺字体信息') : '没有文字层');

  const badBox = layers.filter(layer => {
    const box = layer.box;
    if (!Array.isArray(box) || box.length !== 4) return true;
    if (!canvas) return false;
    const [x, y, w, h] = box.map(Number);
    return !(w > 0 && h > 0) || x < -1 || y < -1 || x + w > canvas.w + 1 || y + h > canvas.h + 1;
  });
  add('boxes', '图层都在画布内', badBox.length === 0,
    badBox.length ? '越界或无效：' + badBox.map(layer => layer.name ?? layer.id).join('、') : '全部落在 ' + (canvas ? canvas.w + '×' + canvas.h : '画布') + ' 内');

  const release = join(root, 'release');
  const artifacts = ['template.psd', 'preview.jpg', 'layer-manifest.json'].filter(name => !existsSync(join(release, name)));
  add('artifacts', 'PSD、预览图与图层清单存在', artifacts.length === 0,
    artifacts.length ? '缺少：' + artifacts.join('、') : 'template.psd / preview.jpg / layer-manifest.json');

  const manifest = readJson(join(release, 'layer-manifest.json'));
  const rows = Array.isArray(manifest) ? manifest : [];
  const rowsByName = new Map(rows.map(row => [row.name, row]));
  const missing = layers.filter(layer => !rowsByName.has(layer.name)).map(layer => layer.name);
  // 原生文字层在清单里是 editable_text，没有 PNG 文件；只有栅格层才要求文件与哈希。
  const textNames = new Set(layers.filter(layer => layer.type === 'text').map(layer => layer.name));
  const broken = rows.filter(row => {
    const isText = row.type === 'editable_text' || textNames.has(row.name);
    if (isText) return 'text' in row ? false : true;
    if (!row.file) return true;
    const file = resolve(release, row.file);
    if (!file.startsWith(release + '/') || !existsSync(file)) return true;
    return Boolean(row.sha256) && sha(file) !== row.sha256;
  });
  add('manifest', '图层清单与每层文件一致', rows.length === layers.length && missing.length === 0 && broken.length === 0,
    rows.length !== layers.length ? '清单 ' + rows.length + ' 项 / 图层 ' + layers.length + ' 个'
      : missing.length ? '清单缺：' + missing.join('、')
        : broken.length ? '文件缺失或哈希不符：' + broken.map(row => row.name).join('、')
          : rows.length + ' 项文件与哈希已核验');

  // 图片层来源必须可声明：AI 生成的图声明为「原创 AI 素材」，程序绘制声明为「原创素材」；
  // 未标注或标成外部来源的层拒绝投稿（那种必须走按层版权证据）。
  const imageLayersForSource = layers.filter(layer => layer.type === 'image');
  const unknown = imageLayersForSource.filter(layer => !['original', 'original_ai'].includes(layer.copyright_category ?? 'original'));
  const aiImages = imageLayersForSource.filter(layer => (layer.copyright_category ?? 'original') === 'original_ai');
  add('sources', '图片层来源可声明', unknown.length === 0,
    unknown.length
      ? '来源不明或外部素材：' + unknown.map(layer => layer.name ?? layer.id).join('、')
      : imageLayersForSource.length
        ? imageLayersForSource.length + ' 个图片层（' + aiImages.length + ' 个 AI 生成 / ' + (imageLayersForSource.length - aiImages.length) + ' 个程序绘制）'
        : '没有图片层，全部为程序绘制图形与原生文字');

  const publication = readJson(join(root, 'publication.json'));
  const published = publication?.published === true;
  add('not_published', published ? '已投稿（不会重复提交）' : '尚未投稿', !published,
    published ? '作品 ID ' + (publication?.contentId ?? '未知') : '未发现发布记录');

  const ok = checks.every(check => check.ok);
  return {
    ok, published, status: published ? 'published' : ok ? 'ready' : 'blocked',
    checks, layers: [], kind: 'template', publication,
    summary: {
      topic: creation?.topic ?? recipe?.topic ?? null,
      kind: 'template',
      plugin: true,
      canvas,
      images: layers.filter(layer => layer.type !== 'text').length,
      texts: textLayers.length,
      title: creation?.title ?? recipe?.title ?? null,
      description: creation?.description ?? recipe?.description ?? null,
      concept: root,
      release,
      recipe: recipeFile
    }
  };
}

/** 从 run.json 找到本次概念与发布目录，找不到返回 null。 */
export function locate(runDir) {
  const root = resolve(runDir);
  const run = readJson(join(root, 'run.json'));
  if (!run) return null;
  const stages = run.stages ?? {};
  const concept = stages.native_creative?.result ?? stages.creative?.result ?? null;
  if (typeof concept !== 'string' || !existsSync(concept)) return null;
  const recipeFile = join(concept, 'release-recipe.json');
  const recipe = readJson(recipeFile) ?? readJson(join(concept, 'release', 'recipe.json'));
  const output = recipe?.output ?? 'release';
  const release = resolve(concept, output);
  return { root, run, concept: resolve(concept), release, recipe, recipeFile };
}

// 程序绘制的 shape 与外部 image 都会输出 PNG，二者都算图片层，都要参与版权覆盖。
function isRaster(layer) { return layer?.type !== 'text'; }

function isBackground(layer, canvas) {
  if (/背景|background/i.test(layer.id ?? '') || /背景/.test(layer.name ?? '')) return true;
  const box = layer.box;
  return Array.isArray(box) && box.length === 4 && canvas && box[2] === canvas.w && box[3] === canvas.h;
}

/**
 * 计算一次运行的投稿就绪度。
 * 返回 {ok, checks:[{id,label,ok,detail}], layers:[...], summary, publication}
 */
export function checkRun(runDir) {
  // 素材运行没有模板产物，走独立检查。
  if (!existsSync(join(runDir, 'run.json')) && existsSync(join(runDir, 'material.json'))) return checkMaterialRun(runDir);
  // 插件自建的模板稿没有 run.json，用 creation.json + release-recipe.json 判定。
  if (!existsSync(join(runDir, 'run.json')) && existsSync(join(runDir, 'creation.json')) && existsSync(join(runDir, 'release-recipe.json'))) return checkTemplateRun(runDir);
  const located = locate(runDir);
  const checks = [];
  const add = (id, label, ok, detail = '') => checks.push({ id, label, ok: !!ok, detail: String(detail) });
  if (!located) {
    add('recipe', '找到运行与配方', false, '缺少 run.json 或概念目录');
    return { ok: false, checks, layers: [], summary: null, publication: null };
  }
  const { run, concept, release, recipe } = located;
  const canvas = recipe?.canvas ?? null;
  const layers = Array.isArray(recipe?.layers) ? recipe.layers : [];
  add('recipe', '发布配方存在', !!recipe && layers.length > 0, recipe ? layers.length + ' 个图层' : '缺少 recipe.json');
  const ids = layers.map(layer => layer.id).filter(Boolean);
  add('layers', '每层都有稳定 ID', ids.length === layers.length && new Set(ids).size === ids.length, ids.length + '/' + layers.length + ' 个图层有唯一 ID');

  const textLayers = layers.filter(layer => layer.type === 'text');
  const imageLayers = layers.filter(layer => isRaster(layer));
  add('text_editable', '文字是可编辑原生文字', textLayers.length > 0, textLayers.length + ' 个文字层');

  const manifest = readJson(join(release, 'layer-manifest.json')) ?? [];
  const manifestByName = new Map((Array.isArray(manifest) ? manifest : []).map(row => [row.name, row]));
  const evidence = readJson(join(concept, 'copyright-evidence.json'));
  const categories = evidence?.categories ?? {};
  const covered = new Set();
  const evidenceRows = [];
  for (const [category, rows] of Object.entries(categories)) {
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const id of Array.isArray(row.layers) ? row.layers : []) covered.add(id);
      evidenceRows.push({ category, row });
    }
  }
  const imageIds = imageLayers.map(layer => layer.id);
  const uncovered = imageIds.filter(id => !covered.has(id));
  const extra = [...covered].filter(id => !imageIds.includes(id));
  add('image_count', '版权候选数量等于图片层数', covered.size === imageIds.length && uncovered.length === 0 && extra.length === 0,
    '图片层 ' + imageIds.length + ' 个 / 证据覆盖 ' + covered.size + ' 个' + (uncovered.length ? '，未覆盖：' + uncovered.join(',') : '') + (extra.length ? '，多余：' + extra.join(',') : ''));
  add('evidence_coverage', '每个图片层都有版权分类', uncovered.length === 0, uncovered.length ? '缺：' + uncovered.join(',') : '全部覆盖');

  const badEvidence = [];
  for (const { row } of evidenceRows) {
    const file = resolve(concept, row.path ?? '');
    if (!file.startsWith(concept + '/')) { badEvidence.push((row.path ?? '') + '（路径越界）'); continue; }
    if (!existsSync(file)) { badEvidence.push((row.path ?? '') + '（缺失）'); continue; }
    if (row.sha256 && sha(file) !== row.sha256) badEvidence.push((row.path ?? '') + '（哈希不符）');
  }
  add('evidence_files', '版权证据文件真实存在且哈希一致', !!evidence && evidenceRows.length > 0 && badEvidence.length === 0,
    evidenceRows.length ? (badEvidence.length ? badEvidence.join('；') : evidenceRows.length + ' 份证据已核验') : '缺少 copyright-evidence.json');

  const layerRows = layers.map(layer => {
    const info = manifestByName.get(layer.name) ?? null;
    const alphaRange = info?.alpha_range ?? null;
    const background = isBackground(layer, canvas);
    const raster = isRaster(layer);
    const alphaOk = raster && !background ? (alphaRange ? alphaRange[0] === 0 : false) : null;
    const matched = Object.entries(categories).find(([, rows]) => (rows ?? []).some(row => (row.layers ?? []).includes(layer.id)));
    return {
      id: layer.id, name: layer.name, type: layer.type,
      category: matched ? matched[0] : null,
      background, raster, alphaRange, alphaOk,
      requireAlpha: layer.require_alpha === true || layer.role === 'foreground',
      file: info?.file ?? null, sha256: info?.sha256 ?? null,
      audited: null
    };
  });
  // 声明了 require_alpha/foreground 的主体必须有透明区；其余矩形装饰只要求可单独隐藏，不强行要求透明。
  const alphaFailures = layerRows.filter(row => {
    if (!row.raster || row.background) return false;
    if (!row.alphaRange) return true;
    return row.requireAlpha ? row.alphaRange[0] !== 0 : false;
  });
  const opaqueRects = layerRows.filter(row => row.raster && !row.background && !row.requireAlpha && row.alphaRange && row.alphaRange[0] !== 0);
  add('alpha', '声明为主体/人物的图层有真实透明区', alphaFailures.length === 0,
    alphaFailures.length ? '无透明像素或缺少清单：' + alphaFailures.map(row => row.name).join('、')
      : (opaqueRects.length ? '主体透明已满足；另有 ' + opaqueRects.length + ' 个不透明矩形装饰（未声明透明要求）' : '所有声明为主体的图层都有 alpha=0 像素'));

  // 新的 native 任务带分离契约：对象必须映射到各自独立的图层。
  const nativeInput = readJson(join(concept, 'native-input.json'));
  const contract = nativeInput?.brief?.concepts?.[0]?.separation_contract ?? readJson(join(concept, 'separation-contract.json'));
  let contractOk = true; let contractDetail = '旧稿没有分层契约，分离由最终视觉审查覆盖';
  if (contract) {
    const objects = Array.isArray(contract.objects) ? contract.objects : [];
    const problems = [];
    const usedLayers = new Set();
    for (const object of objects) {
      const id = object?.layer_id;
      if (!id || !ids.includes(id)) problems.push((object?.id ?? '?') + ' 指向不存在的图层 ' + String(id));
      else if (usedLayers.has(id)) problems.push('两个对象共用图层 ' + id);
      else usedLayers.add(id);
      if (object?.require_alpha === true || object?.role === 'foreground') {
        const row = layerRows.find(item => item.id === id);
        if (row && row.alphaRange && row.alphaRange[0] !== 0) problems.push((object?.id ?? id) + ' 声明透明但无 alpha=0 像素');
      }
    }
    if (!objects.length && contract.schema_version === 1) problems.push('契约没有列出任何对象');
    contractOk = problems.length === 0;
    contractDetail = contractOk ? objects.length + ' 个对象各自绑定独立图层' : problems.join('；');
  }
  add('contract', '按元素分离的图层契约', contractOk, contractDetail);

  const backgrounds = layerRows.filter(row => row.background);
  add('background', '存在完整背景层', backgrounds.length > 0, backgrounds.length ? backgrounds.map(row => row.name).join('、') : '没有识别到整幅背景层');

  const pairs = Array.isArray(recipe?.layer_audit?.pairs) ? recipe.layer_audit.pairs : [];
  const audit = readJson(join(release, 'layer-audit', 'audit.json'));
  const originals = audit && typeof audit.originals === 'object' && audit.originals ? Object.keys(audit.originals) : [];
  const named = new Set(pairs.flatMap(pair => [pair.subject, pair.background]).filter(Boolean));
  for (const row of layerRows) {
    if (row.background) row.audited = true;
    else if (named.has(row.name) || originals.includes(row.name)) row.audited = true;
  }
  const auditShots = pairs.every((_, index) => existsSync(join(release, 'layer-audit', 'pair-' + (index + 1) + '-subject-hidden.png')) && existsSync(join(release, 'layer-audit', 'pair-' + (index + 1) + '-background-hidden.png')));
  // 审计用语义名记录（如「独立完整茶壶」），不能要求与 recipe 层名逐字相等；只要求审计真实完成且覆盖数量不少于主体数。
  const auditOk = pairs.length > 0 && auditShots && audit?.status === 'complete' && originals.length >= pairs.length;
  add('audit', '主体有逐层隐藏验收', auditOk,
    auditOk ? pairs.length + ' 组隐藏/恢复截图，审计记录 ' + originals.length + ' 个对象'
      : !pairs.length ? '配方没有 layer_audit.pairs' : !auditShots ? '缺少隐藏截图' : !audit?.status ? '缺少 audit.json' : '审计对象少于主体数');

  const restored = join(release, 'layer-audit', 'restored-after-reload.png');
  add('restored', '刷新后恢复图存在', existsSync(restored), existsSync(restored) ? 'restored-after-reload.png' : '缺少刷新恢复图');

  const gateDir = join(located.root, 'gates', '04-final');
  const gateRequest = readJson(join(gateDir, 'request.json'));
  const gateResponse = readJson(join(gateDir, 'response.json'));
  const gateOk = gateResponse?.passed === true && gateRequest?.token && gateResponse?.token === gateRequest.token && Array.isArray(gateResponse.checks) && gateResponse.checks.length > 0;
  add('final_gate', '最终视觉审查已通过', !!gateOk, gateOk ? '审查记录 token 一致' : '缺少或过期的 04-final 审查');

  const specFile = join(release, 'spec.json');
  const bindingsFile = join(release, 'bound-assets.json');
  const visual = readJson(join(release, 'visual-review.json'));
  const material = readJson(join(release, 'material-review.json'));
  const reviewsOk = visual?.passed === true && visual?.spec_sha256 === sha(specFile) && material?.passed === true && material?.bindings_sha256 === sha(bindingsFile);
  add('reviews', '视觉与素材审查对应当前文件', !!reviewsOk, reviewsOk ? '哈希与当前 spec/绑定一致' : '审查缺失或文件已变更');

  const publication = readJson(join(release, 'publication.json'));
  const published = publication?.published === true;
  add('not_published', published ? '已投稿（不会重复提交）' : '尚未投稿', !published,
    published ? '作品 ID ' + (publication?.contentId ?? '未知') : '未发现发布记录');

  const ok = checks.every(check => check.ok);
  return { ok, published, status: published ? 'published' : ok ? 'ready' : 'blocked', checks, layers: layerRows, summary: { topic: run.requested_topic ?? null, canvas, images: imageLayers.length, texts: textLayers.length, concept, release, recipe: join(concept, 'release-recipe.json') }, publication };
}
