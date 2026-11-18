#!/usr/bin/env python3
"""生成「程序原创素材声明材料」：逐层列出全部图片层的真实缩略图与哈希。

数据全部来自本稿真实产物（creation.json / release-recipe.json /
release/layer-manifest.json / release/assets/*.png），不使用任何 AI 生成图像。
输出：
  publish/original-evidence.png      声明材料图（逐层覆盖）
  publish/declaration-evidence.json  声明材料清单（供提交前预检比对）
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOLD = '/System/Library/Fonts/STHeiti Medium.ttc'
REGULAR = '/System/Library/Fonts/STHeiti Light.ttc'
WIDTH, HEIGHT = 1600, 2400
COLUMNS = 5


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else REGULAR, size, index=1 if bold else 0)


def wrap(text, limit):
    text = str(text)
    return [text[i:i + limit] for i in range(0, max(len(text), 1), limit)]


def build(run_dir, output, topic_override=None):
    run = Path(run_dir)
    creation = json.loads((run / 'creation.json').read_text())
    recipe_path = run / 'release-recipe.json'
    recipe = json.loads(recipe_path.read_text())
    recipe_sha = hashlib.sha256(recipe_path.read_bytes()).hexdigest()
    manifest_rows = json.loads((run / 'release' / 'layer-manifest.json').read_text())
    image_layers = [row for row in manifest_rows if row.get('type') != 'text' and row.get('file')]
    if not image_layers:
        raise SystemExit('layer-manifest.json 里没有图片层，无法生成逐层证据')
    text_layers = [row for row in manifest_rows if row.get('type') == 'text' or not row.get('file')]
    candidates = len({row.get('sha256') for row in image_layers})
    canvas = recipe.get('canvas') or {}
    topic = topic_override or creation.get('topic') or recipe.get('topic') or ''

    image = Image.new('RGB', (WIDTH, HEIGHT), (250, 249, 246))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, WIDTH, 190], fill=(31, 41, 55))
    draw.text((70, 58), '素材来源与生成说明', font=font(62, True), fill=(255, 255, 255))

    rows = [
        ('作品标题', creation.get('title') or recipe.get('title') or ''),
        ('所属话题', topic),
        ('生成方式', '图像层由图像模型按提示词生成；图形层由本地渲染生成；文字为原生可编辑文字'),
        ('声明覆盖', '%d 个图片层（对应平台 %d 个去重候选）+ %d 个原生文字层'
         % (len(image_layers), candidates, len(text_layers))),
        ('画布 / 配方', '%s×%s ／ release-recipe.json' % (canvas.get('w'), canvas.get('h'))),
        ('配方 SHA256', recipe_sha),
        ('生成时间', datetime.now().strftime('%Y-%m-%d %H:%M:%S')),
    ]
    y = 240
    for label, value in rows:
        draw.text((70, y), label, font=font(30, True), fill=(95, 95, 95))
        y += 44
        for line in wrap(value, 52):
            draw.text((70, y), line, font=font(32), fill=(25, 25, 25))
            y += 42
        y += 14

    grid_top = y + 18
    cell_w, cell_h = 296, 198
    for index, layer in enumerate(image_layers):
        column, row = index % COLUMNS, index // COLUMNS
        x = 70 + column * cell_w
        cell_y = grid_top + row * cell_h
        if cell_y + cell_h > HEIGHT - 150:
            break
        source = run / 'release' / layer.get('file', '')
        box_top = cell_y + 30
        box_size = 112
        draw.rectangle([x, box_top, x + box_size, box_top + box_size], fill=(255, 255, 255), outline=(205, 205, 205))
        if source.exists():
            try:
                thumb = Image.open(source).convert('RGBA')
                thumb.thumbnail((box_size - 6, box_size - 6))
                image.paste(thumb, (x + (box_size - thumb.width) // 2, box_top + (box_size - thumb.height) // 2), thumb)
            except Exception:
                pass
        draw.text((x, cell_y), '%02d' % (index + 1), font=font(22, True), fill=(31, 41, 55))
        draw.text((x + 40, cell_y + 2), layer.get('name', '')[:9], font=font(22), fill=(40, 40, 40))
        draw.text((x, box_top + box_size + 6), 'sha ' + (layer.get('sha256') or '')[:12], font=font(17), fill=(120, 120, 120))

    statement = ('声明：以上图层均由本人创作。标注为图像层的由图像模型按本人提示词生成（原创 AI 素材），'
                 '图形层由程序绘制与本地渲染完成；缩略图即最终投稿使用的图层文件，'
                 '哈希与 release/layer-manifest.json 一致；未使用第三方素材。')
    bottom = HEIGHT - 130
    for index, line in enumerate(wrap(statement, 48)):
        draw.text((70, bottom + index * 40), line, font=font(27), fill=(60, 60, 60))

    destination = Path(output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination)
    manifest = {
        'schema': 1,
        'image': str(destination),
        'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
        'recipeSha256': recipe_sha,
        'topic': topic,
        'layers': [row.get('name') for row in image_layers],
        'layerCount': len(image_layers),
        'candidates': candidates,
        'textLayers': len(text_layers),
        'kind': 'original',
        'generatedAt': datetime.now().isoformat(timespec='seconds'),
    }
    (destination.parent / 'declaration-evidence.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return {
        'image': str(destination),
        'sha256': manifest['sha256'],
        'recipeSha256': recipe_sha,
        'topic': topic,
        'layers': manifest['layers'],
        'layerCount': len(image_layers),
        'candidates': candidates,
        'textLayers': len(text_layers),
        'kind': 'original',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_dir')
    parser.add_argument('--topic', default='')
    parser.add_argument('--output')
    args = parser.parse_args()
    output = args.output or str(Path(args.run_dir) / 'publish' / 'original-evidence.png')
    try:
        print(json.dumps(build(args.run_dir, output, args.topic or None), ensure_ascii=False))
    except SystemExit:
        raise
    except Exception as error:  # 失败如实返回，不产出假证据
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
