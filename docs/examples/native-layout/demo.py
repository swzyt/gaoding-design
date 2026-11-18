# -*- coding: utf-8 -*-
"""Local rendering demonstration only. No model, upload, account, or submission."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'pipeline/workflow'))
from assemble import preview

ROOT = Path(__file__).resolve().parent


def shape(key, box, color, ellipse=False):
    return dict(id=key, name=key, type='shape', box=box, color=color, ellipse=ellipse, copyright_category='original')


def text(key, content, box, size, color, serif=False, **style):
    return dict(id=key, name=key, type='text', text=content, box=box, size=size, color=color,
                font='SongtiSC-Regular' if serif else 'ArialUnicodeMS',
                preview_font='Songti.ttc' if serif else 'Arial Unicode.ttf',
                gd_font='思源宋体' if serif else '思源黑体', **style)


def recipes():
    cream, ink, orange = [244, 240, 229, 255], [26, 45, 52], [228, 102, 50, 255]
    a = [shape('background', [0, 0, 1080, 1440], cream),
         shape('accent-disc', [612, 558, 366, 366], orange, True),
         shape('disc-cutout', [676, 622, 238, 238], cream, True),
         shape('vertical-rule', [76, 596, 2, 348], [26, 45, 52, 255]),
         shape('footer-rule', [76, 1167, 928, 2], [26, 45, 52, 255]),
         text('issue', 'TYPE / SPACE / COLOR', [76, 84, 900, 60], 26, ink, letter_spacing=3),
         text('headline', '给文字\n留一点呼吸', [68, 209, 940, 334], 112, ink, serif=True, line_height=1.25),
         text('body', '共同对齐，让信息有秩序。\n适当留白，让重点被看见。\n让色彩服务于阅读。', [108, 639, 530, 270], 30, ink, line_height=1.8),
         text('section', '版式与配色练习', [76, 1007, 850, 68], 33, ink, letter_spacing=3),
         text('footer', '本地原生排版演示  ·  未投稿', [76, 1220, 900, 65], 24, ink),
         text('number', '01', [76, 1304, 900, 60], 26, ink, align='right')]
    navy, white, lime = [23, 39, 55, 255], [240, 242, 233], [214, 231, 124, 255]
    b = [shape('background', [0, 0, 1080, 1440], navy),
         shape('accent-disc', [133, 116, 814, 814], lime, True),
         shape('disc-cutout', [179, 162, 722, 722], navy, True),
         shape('body-card', [76, 989, 928, 234], [240, 242, 233, 255]),
         text('issue', 'TYPE / SPACE / COLOR', [76, 77, 928, 54], 24, white, align='center', letter_spacing=3),
         text('headline', '给文字\n留一点呼吸', [74, 365, 932, 300], 96, white, serif=True, align='center', line_height=1.3),
         text('section', '版式与配色练习', [76, 742, 928, 68], 30, white, align='center', letter_spacing=3),
         text('body', '共同对齐  /  适当留白  /  色彩层级\n让画面先传递一个清晰的重点。', [122, 1052, 836, 123], 29, [23, 39, 55], align='center', line_height=1.6),
         text('footer', '本地原生排版演示  ·  未投稿', [76, 1300, 928, 65], 24, white, align='center')]
    return {'editorial': a, 'geometric': b}


if __name__ == '__main__':
    for name, layers in recipes().items():
        recipe = {'canvas': {'w': 1080, 'h': 1440}, 'title': '原生排版开发演示', 'description': '本地开发预览，不用于投稿',
                  'topic': 'offline-demo', 'layers': layers,
                  'layer_audit': {'pairs': [{'subject': 'accent-disc', 'background': 'background'}]}}
        file = ROOT / (name + '.json')
        file.write_text(json.dumps(recipe, ensure_ascii=False, indent=2))
        print(preview(file, ROOT / (name + '.jpg')))
