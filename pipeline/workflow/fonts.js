// UI selectors verified against the current Gaoding editor. Fail instead of silently skipping.
function normalize(name) {
  if (typeof name !== 'string' || !name.trim()) throw Error('Every text layer requires an explicit gd_font');
  name = name.trim();
  if (name === '宋体') return '思源宋体 常规';
  if (name === '思源宋体 Heavy') return '思源宋体 特粗';
  if (name === '思源黑体 Heavy') return '思源黑体 特粗';
  return name;
}
function candidatesFor(wanted) {
  const name = normalize(wanted);
  const candidates = [name];
  if (name.endsWith(' 常规')) candidates.push(name.replace(/ 常规$/, ' Regular'));
  if (name.endsWith(' 特粗')) candidates.push(name.replace(/ 特粗$/, ' Heavy'));
  if (name === '思源黑体') candidates.push('思源黑体 常规', '思源黑体 Regular');
  // 思源黑体 results observed in the real editor: 常规/粗体/极细/特粗/纤细/中等/中细.
  // These are semantic aliases of this family's seven weights, never fallback weights.
  const observedWeights = [
    ['Regular', '常规'], ['Bold', '粗体'], ['ExtraLight', '极细'],
    ['Heavy', '特粗'], ['Light', '纤细'], ['Medium', '中等'], ['Normal', '中细'],
  ];
  for (const aliases of observedWeights) {
    if (aliases.some(weight => name === '思源黑体 ' + weight)) {
      candidates.push(...aliases.map(weight => '思源黑体 ' + weight));
      break;
    }
  }
  return [...new Set(candidates)];
}
function matches(wanted, actual) {
  return typeof actual === 'string' && candidatesFor(wanted).includes(actual.trim());
}
function verifiedRecord(record,wanted) {
  return !!record && matches(wanted,record.font) && /^\d+$/.test(record.font_id || '') &&
    typeof record.font_preview_url === 'string' && !!record.font_preview_url &&
    record.checked_verified === true && record.preview_verified === true && record.persistence_verified === true;
}
async function apply(page, rows, onApplied = () => {}, options = {}) {
  // Validate the complete request before mutating the editor.
  for (const [layer, wanted] of rows) {
    if (typeof layer !== 'string' || !layer.trim()) throw Error('Font request requires a layer name');
    candidatesFor(wanted);
  }
  const done = [];
  for (const [layer, wanted] of rows) {
    if (await page.evaluate(() => !!document.querySelector('.dui-panel-title-block__back-icon__button'))) {
      await page.click('.dui-panel-title-block__back-icon__button');
    }
    await page.click('text=' + JSON.stringify(layer));
    await page.waitForSelector('.dui-text-edit-name-v2', {timeout:15000});
    await page.click('.dui-text-edit-name-v2');
    await page.waitForSelector('input[placeholder="搜索字体"]', {timeout:15000});
    const name = normalize(wanted);
    const candidates = candidatesFor(wanted);
    await page.fill('input[placeholder="搜索字体"]', name.split(' ')[0]);
    await page.waitForFunction(candidates => [...document.querySelectorAll('.dbu-font-panel__list__item__text')]
      .some(e => candidates.includes(e.innerText.trim())),
      candidates, {timeout:15000});
    const picked = await page.evaluate(candidates => {
      const list = [...document.querySelectorAll('.dbu-font-panel__list__item__text')];
      const el = candidates.map(name => list.find(e => e.innerText.trim() === name)).find(Boolean);
      if (!el) throw new Error('Font is unavailable: '+candidates.join('/'));
      return {font:el.innerText.trim(),id:el.getAttribute('data-font-id'),
        preview:el.getAttribute('data-bg-img'),
        checked:!!el.closest('.dbu-font-panel__list__item')?.classList.contains('checked')};
    }, candidates);
    if (!/^\d+$/.test(picked.id || '') || !picked.preview) throw Error('Font option lacks identity/preview evidence: '+wanted);
    if (!picked.checked) {
      if (options.verifyOnly) throw Error('Saved font does not match requested face: '+layer+' / '+wanted);
      // A DOM el.click() did not apply the font in the real editor. Use native
      // input events on the observed stable font ID, and prove the state changed.
      await page.click('.dbu-font-panel__list__item__text[data-font-id="'+picked.id+'"]');
    }
    await page.waitForFunction(({id,font,preview}) => {
      const el = document.querySelector('.dbu-font-panel__list__item__text[data-font-id="'+id+'"]');
      return el?.innerText.trim() === font && el.getAttribute('data-bg-img') === preview &&
        !!el.closest('.dbu-font-panel__list__item')?.classList.contains('checked');
    }, {id:picked.id,font:picked.font,preview:picked.preview}, {timeout:15000});
    await page.waitForSelector('.dui-panel-title-block__back-icon__button', {timeout:10000});
    await page.click('.dui-panel-title-block__back-icon__button');
    await page.waitForFunction(preview => document.querySelector('.dui-text-edit-name-v2 img')?.getAttribute('src') === preview,
      picked.preview, {timeout:15000});
    done.push({layer,font:picked.font,requested:wanted,font_id:picked.id,
      font_preview_url:picked.preview,checked_verified:true,preview_verified:true,
      persistence_verified:options.verifyOnly === true && options.persistenceVerified === true,
      verified_at:new Date().toISOString()});
    await onApplied(done);
    console.log('font verified',layer,picked.font,picked.id);
  }
  return done;
}
module.exports = {apply, normalize, candidatesFor, matches, verifiedRecord};
