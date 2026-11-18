# -*- coding: utf-8 -*-
"""Build browsable local text snapshots and a complete source/analysis index."""
import hashlib, json, re
from pathlib import Path
ROOT = Path(__file__).resolve().parent
catalog = json.loads((ROOT/'catalog.json').read_text())
notes = json.loads((ROOT/'notes.json').read_text())
assets = json.loads((ROOT/'sources/assets-index.json').read_text())['assets']
by_url = {v['url']:v for v in assets.values()}
cases = (ROOT/'04-优质作品与活动案例.md').read_text()
for block in re.split(r'(?m)^### ', cases)[1:]:
    slug = re.search(r'https://gdce\.yuque\.com/gksiz6/bp2afo/([a-z0-9]+)',block)
    core = re.search(r'\*\*核心内容：\*\* (.*)',block)
    if slug and core and slug.group(1) not in notes:
        notes[slug.group(1)] = core.group(1) + ' 历史案例不作为当前奖励或审核承诺，详见案例专题。'
missing = [d['id'] for d in catalog['documents'] if d['id'] not in notes]
if missing: raise RuntimeError('Missing per-document analysis: '+str(missing))
(ROOT/'documents').mkdir(exist_ok=True)
rows=[]
for entry in catalog['documents']:
    doc=json.loads((ROOT/'sources'/f"{entry['id']}.json").read_text())
    entry['title']=doc['title']
    source_hash=hashlib.sha256(doc['text'].encode()).hexdigest()
    if source_hash != doc['sha256']: raise RuntimeError('Text hash mismatch: '+entry['id'])
    title=doc['title']; content=[f'# {title}', '', f"来源：{entry['url']}", f"采集：{doc['collectedAt']}（UTC）", f"正文SHA256：`{source_hash}`", '', '> 本页为浏览器正文快照与表格、链接、图片来源的汇总。不是官方最新页面；图像只作研究，不作生产素材。原始HTML见对应source JSON。', '', '## 分析摘要', '', notes[entry['id']], '', '## 正文快照', '', re.sub(r'\n(?:[ \t]*\n){2,}', '\n\n', doc['text']).strip()]
    if doc['tables']:
        content += ['', '## 原始表格摘录', '', '> 保留原表行顺序。此渲染不还原合并单元格；原始HTML另存，空值不能据此继承或补默认值。']
        for i,table in enumerate(doc['tables'],1):
            if not table: continue
            width=max(map(len,table)); fmt=lambda row:'| '+' | '.join(str(v).replace('|','\\|').replace('\n','<br>') for v in row+['']*(width-len(row)))+' |'
            content += ['',f'### 表{i}','',fmt(table[0]),'| '+' | '.join(['---']*width)+' |',*[fmt(row) for row in table[1:]]]
    if doc['bodyLinks']:
        content += ['', '## 正文链接', '']; seen=set()
        for link in doc['bodyLinks']:
            if link['url'] in seen:continue
            seen.add(link['url']);content.append(f"- [{link['title'].strip().replace(chr(10),' ') or '链接'}]({link['url']})")
    if doc['images']:
        content += ['', '## 配图索引', '', '> 索引从0开始。下列是图片来源登记，不表示全部已实看；已看项目见视觉观察专题。']
        for im in doc['images']:
            asset=by_url.get(im['src'],{}); target='../'+asset['file'] if asset.get('status')=='saved' else im['src']
            content.append(f"- 图片{im['index']}：[{'本地归档' if asset.get('status')=='saved' else '在线来源'}]({target})；[原始URL]({im['src']})")
    (ROOT/'documents'/f"{entry['id']}.md").write_text('\n'.join(content)+'\n')
    scope='首页' if entry['id']=='home' else ('正文补充链接' if entry['id'] in {'ypqqgnsltvhlme2x','dxemgcergpgwazvi'} else '目录内')
    rows.append(f"| {len(rows)+1} | [{title.replace('|','｜')}](documents/{entry['id']}.md) · [原文]({entry['url']}) | {scope} | {notes[entry['id']].replace('|','｜')} |")
header='# 全部文档逐篇索引与分析\n\n采集日期：2026-11-06（Asia/Shanghai）。已展开并滚动核对目录70篇全部覆盖；另正文补充链接2篇及首页，共73条。每篇均有正文快照、原始HTML/表格/链接及独立分析摘要；历史案例27篇另有详细专题。并非所有配图均已视觉观察，也未逐一打开视频、第三方工具或知识库外部文档。\n\n| 序号 | 文档与来源 | 范围 | 分析摘要 |\n| --- | --- | --- | --- |\n'
(ROOT/'01-逐篇索引与分析.md').write_text(header+'\n'.join(rows)+'\n')
(ROOT/'catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n')
spec=json.loads((ROOT/'sources/fgkyq8l9mb8ax5a0.json').read_text())
(ROOT/'material-specs.json').write_text(json.dumps({'source':spec['url'],'collectedAt':spec['collectedAt'],'status':'raw_tables_not_normalized','warning':'原始表格可能含合并单元格和笔误，未确认数值不可自动作默认值。','tables':spec['tables']},ensure_ascii=False,indent=2)+'\n')
toc=json.loads((ROOT/'sources/toc.json').read_text())
toc_urls={'https://gdce.yuque.com/gksiz6/bp2afo/'+v['url'] for v in toc['entries'] if v.get('type')=='DOC' and v.get('url')}
captured={d['url'] for d in catalog['documents']}
report={'collectedDate':'2026-11-06','timezone':'Asia/Shanghai','directoryDocuments':len(toc_urls),'records':len(catalog['documents']),'missingDirectoryDocuments':sorted(toc_urls-captured),'articleCount':len(catalog['documents'])-1,'supplementaryArticles':2,'perDocumentAnalyses':len(notes),'collectionErrors':[d for d in catalog['documents'] if d['status']!='collected'],'uniqueImageSources':len(assets),'localAssets':sum(v['status']=='saved' for v in assets.values()),'referencedAssets':sum(v['status']=='referenced' for v in assets.values()),'assetErrors':[v['url'] for v in assets.values() if v['status']=='error'],'missingImageSources':sum(not im['src'] for d in catalog['documents'] for im in json.loads((ROOT/'sources'/f"{d['id']}.json").read_text())['images']),'localAssetBytes':sum(v.get('bytes',0) for v in assets.values()),'visualReview':{'imagesOpened':11,'sourceArticles':5,'allImagesReviewed':False},'scopeExclusions':['知识库外第三方文档、工具、视频逐帧内容','实时话题目录和登录后账户页面','全部历史配图逐张视觉验收'],'noGenerationOrPublication':True}
(ROOT/'coverage-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False))
