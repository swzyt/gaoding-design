// UI selectors verified against the current Gaoding editor. Fail instead of silently skipping.
function normalize(name) {
  if (name === '宋体') return '思源宋体 常规';
  if (name === '思源宋体 Heavy') return '思源宋体 特粗';
  if (name === '思源黑体 Heavy') return '思源黑体 特粗';
  return name;
}
async function apply(page, rows, onApplied = () => {}) {
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
    const candidates = [name];
    if (name.endsWith(' 常规')) candidates.push(name.replace(/ 常规$/, ' Regular'));
    if (name.endsWith(' 特粗')) candidates.push(name.replace(/ 特粗$/, ' Heavy'));
    if (name === '思源黑体') candidates.push('思源黑体 常规','思源黑体 Regular');
    await page.fill('input[placeholder="搜索字体"]', name.split(' ')[0]);
    await page.waitForFunction(candidates => [...document.querySelectorAll('.dbu-font-panel__list__item__text')]
      .some(e => candidates.includes(e.innerText.trim())),
      candidates, {timeout:15000});
    const picked = await page.evaluate(candidates => {
      const list = [...document.querySelectorAll('.dbu-font-panel__list__item__text')];
      const el = list.find(e => candidates.includes(e.innerText.trim()));
      if (!el) throw new Error('Font is unavailable: '+candidates.join('/'));
      const picked = el.innerText.trim(); el.click(); return picked;
    }, candidates);
    await page.waitForSelector('.dui-panel-title-block__back-icon__button', {timeout:10000});
    await page.click('.dui-panel-title-block__back-icon__button');
    done.push({layer,font:picked}); await onApplied(done);
    console.log('font',layer,picked);
  }
  return done;
}
module.exports = {apply};
