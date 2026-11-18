import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { yuqueTarget, htmlToLines, parseSpecContent, fetchSpec, refreshSpecs, readIndex, readSpec, readFailures, specFile, specIsFresh, summaryOf } from './spec-catalog.js';

const sample = `<h1>测试话题</h1>
<p>小红书封面/配图：1242*1656px，画面严禁添加Logo、二维码</p>
<p>教育培训：备考重点、提分技巧</p>
<p>03 <img src="https://cdn.nlark.com/a.png" /><img src="//cdn.nlark.com/b.png" /></p>
<script>var leaked = 1</script>
<p>禁止直接抄袭或复刻他人作品；不得出现二维码</p>`;

test('yuque links resolve to host, book path and slug', () => {
  assert.deepEqual(yuqueTarget('https://gdce.yuque.com/gksiz6/drcay5/nw57rwx4u7g7touo'), { host: 'gdce.yuque.com', bookPath: 'gksiz6/drcay5', slug: 'nw57rwx4u7g7touo' });
  assert.equal(yuqueTarget('https://www.gaoding.com/topics/abc'), null);
  assert.equal(yuqueTarget('http://gdce.yuque.com/gksiz6/drcay5/slug123456'), null);
  assert.equal(yuqueTarget('https://gdce.yuque.com/book'), null);
});

test('html becomes clean text lines without scripts or tags', () => {
  const lines = htmlToLines(sample);
  assert.equal(lines.some(line => line.includes('leaked')), false, 'script content must not leak into the spec');
  assert.equal(lines.some(line => line.includes('<p>')), false);
  assert.ok(lines[0].includes('测试话题'));
});

test('spec parsing extracts canvas, prohibitions, directions and images', () => {
  const spec = parseSpecContent(sample, { title: '测试话题' });
  assert.deepEqual(spec.canvas, [{ width: 1242, height: 1656, label: '1242×1656' }]);
  assert.ok(spec.forbidden.some(text => text.includes('严禁添加Logo')));
  assert.ok(spec.forbidden.some(text => text.includes('禁止直接抄袭')));
  assert.ok(spec.directions.includes('教育培训：备考重点、提分技巧'), JSON.stringify(spec.directions));
  assert.deepEqual(spec.images, ['https://cdn.nlark.com/a.png', 'https://cdn.nlark.com/b.png']);
  assert.match(spec.contentSha256, /^[a-f0-9]{64}$/);
  assert.ok(spec.wordCount > 20);
  assert.ok(spec.text.includes('1242*1656px'));
});

test('images come from Yuque image cards and directions skip rule metadata', () => {
  const encoded = 'data:' + encodeURIComponent(JSON.stringify({ src: 'https://cdn.nlark.com/yuque/demo.png', taskId: 'x' }));
  const spec = parseSpecContent(`<p>活动时间：2026.10.8-10.18</p><p>奖励说明：作品需有明确用户对象</p><p>教育培训：备考重点、提分技巧</p><card type="inline" name="image" value="${encoded}"></card>`);
  assert.deepEqual(spec.images, ['https://cdn.nlark.com/yuque/demo.png']);
  assert.deepEqual(spec.directions, ['教育培训：备考重点、提分技巧'], JSON.stringify(spec.directions));
});

test('material topics keep square sticker sizes while templates ignore them', () => {
  const html = '<p>单张贴纸2000*2000px，1620*2880px</p>';
  assert.deepEqual(parseSpecContent(html).canvas.map(row => row.label), ['1620×2880']);
  assert.deepEqual(parseSpecContent(html, { allowSquare: true }).canvas.map(row => row.label), ['2000×2000', '1620×2880']);
});

test('square and tiny canvases are ignored, duplicates collapse', () => {
  const spec = parseSpecContent('<p>1242*1656</p><p>1242×1656</p><p>800x800</p><p>100*200</p><p>1242*2688</p>');
  assert.deepEqual(spec.canvas.map(row => row.label), ['1242×1656', '1242×2688']);
});

function fetcherFor({ page = '<html>"book_id":77084162</html>', api = null, onCall = () => {} } = {}) {
  return async (url) => {
    onCall(url);
    if (url.includes('/api/docs/')) {
      if (api) return { ok: true, status: 200, json: async () => api };
      throw Error('HTTP 404');
    }
    return { ok: true, status: 200, text: async () => page };
  };
}

test('fetchSpec resolves the book id, parses the document and records provenance', async () => {
  const books = {};
  const calls = [];
  const fetcher = fetcherFor({
    onCall: url => calls.push(url),
    api: { data: { title: '长期高下载｜测试', content: sample, content_updated_at: '2026-10-01T00:00:00.000Z' } }
  });
  const spec = await fetchSpec({ key: 'topic-abc', name: '测试话题', rules_url: 'https://gdce.yuque.com/gksiz6/drcay5/nw57rwx4u7g7touo' }, { fetcher, books, now: new Date('2026-11-17T00:00:00.000Z') });
  assert.equal(spec.key, 'topic-abc');
  assert.equal(spec.bookId, '77084162');
  assert.equal(spec.title, '长期高下载｜测试');
  assert.equal(spec.canvas[0].label, '1242×1656');
  assert.equal(spec.fetchedAt, '2026-11-17T00:00:00.000Z');
  assert.equal(spec.updatedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(books['gdce.yuque.com/gksiz6/drcay5'], '77084162', 'book id must be cached for later topics');
  assert.ok(calls.some(url => url.includes('/api/docs/nw57rwx4u7g7touo?book_id=77084162')));
});

test('fetchSpec refuses empty documents and topics without a spec link', async () => {
  await assert.rejects(
    () => fetchSpec({ key: 'topic-empty', name: '空规范', rules_url: 'https://gdce.yuque.com/gksiz6/drcay5/nw57rwx4u7g7touo' }, { fetcher: fetcherFor({ api: { data: { content: '   ' } } }) }),
    /正文为空/
  );
  await assert.rejects(() => fetchSpec({ key: 'topic-none', name: '无链接', rules_url: null }, { fetcher: fetcherFor() }), /没有可解析的规范链接/);
});

test('login-restricted specs fail with an explicit reason', async () => {
  await assert.rejects(
    () => fetchSpec({ key: 'topic-locked', name: '受限话题', rules_url: 'https://gdce.yuque.com/gksiz6/drcay5/locked123' }, {
      fetcher: async () => ({ ok: false, status: 401, text: async () => '', json: async () => ({ status: 401 }) })
    }),
    /需要登录/
  );
});

test('spec files reject unsafe keys instead of escaping the data directory', () => {
  assert.throws(() => specFile('/tmp/data', '../escape'), /Invalid topic key/);
  assert.throws(() => specFile('/tmp/data', 'a/b'), /Invalid topic key/);
  assert.ok(specFile('/tmp/data', 'topic-1a6562590ef19d1045d0').endsWith('/catalog/specs/topic-1a6562590ef19d1045d0.json'));
});

test('batch refresh writes specs, skips fresh entries and isolates failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaoding-specs-'));
  try {
    const topics = [
      { key: 'topic-one', name: '话题一', rules_url: 'https://gdce.yuque.com/gksiz6/drcay5/slugone01' },
      { key: 'topic-two', name: '话题二', rules_url: 'https://gdce.yuque.com/gksiz6/drcay5/slugtwo02' },
      { key: 'topic-nolink', name: '无规范', rules_url: null }
    ];
    const fetcher = async (url) => {
      if (url.includes('slugtwo02')) throw Error('HTTP 500');
      if (url.includes('/api/docs/')) return { ok: true, status: 200, json: async () => ({ data: { title: '话题一规范', content: sample } }) };
      return { ok: true, status: 200, text: async () => '<html>"book_id":77084162</html>' };
    };
    const first = await refreshSpecs({ topics, dataRoot: root, fetcher, now: new Date('2026-11-17T00:00:00.000Z') });
    assert.deepEqual(first.ok, ['topic-one']);
    assert.deepEqual(first.failed.map(row => row.key), ['topic-two']);
    assert.equal(first.skipped.length, 0);
    const index = readIndex(root);
    assert.deepEqual(index.map(row => row.key), ['topic-one']);
    assert.equal(index[0].canvas[0], '1242×1656');
    assert.ok(readSpec(root, 'topic-one'));

    const second = await refreshSpecs({ topics, dataRoot: root, fetcher, now: new Date('2026-11-17T01:00:00.000Z') });
    assert.deepEqual(second.skipped, ['topic-one'], 'a fresh cached spec is not fetched again');
    assert.deepEqual(second.failed.map(row => row.key), ['topic-two']);
    assert.deepEqual(readFailures(root).map(row => row.key), ['topic-two'], 'failures stay visible across runs');

    const forced = await refreshSpecs({ topics, dataRoot: root, fetcher, force: true, now: new Date('2026-11-17T01:00:00.000Z') });
    assert.deepEqual(forced.ok, ['topic-one']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('index summaries stay small and freshness is explicit', () => {
  const spec = { key: 'k', name: 'n', title: 't', url: 'u', canvas: [{ width: 1, height: 2, label: '1×2' }], forbidden: ['a'], directions: ['b'], text: 'x'.repeat(5000), wordCount: 9, fetchedAt: '2026-11-17T00:00:00.000Z', contentSha256: 'hash' };
  const summary = summaryOf(spec);
  assert.equal('text' in summary, false, 'the list index must not carry full spec text');
  assert.deepEqual(summary.canvas, ['1×2']);
  assert.equal(specIsFresh(spec, Date.parse('2026-11-20T00:00:00.000Z')), true);
  assert.equal(specIsFresh(spec, Date.parse('2027-01-20T00:00:00.000Z')), false);
});
