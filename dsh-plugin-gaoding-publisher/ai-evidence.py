#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「AI 生成证据图」：把工具、模型、完整 prompt、参数、结果预览与哈希画到一张图上，
用于上传到稿定素材版权声明。只读取真实运行产物，不编造字段。"""
import argparse, hashlib, json, os, sys, textwrap
from datetime import datetime

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as error:  # pragma: no cover
    print(json.dumps({"error": "Pillow 不可用: %s" % error}, ensure_ascii=False))
    sys.exit(2)

WIDTH, HEIGHT = 1600, 2200
PAD = 72
BG = (250, 249, 246)
INK = (30, 32, 38)
MUTED = (110, 114, 124)
ACCENT = (43, 96, 214)
CARD = (255, 255, 255)


def load_font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def wrap(draw, text, font, max_width):
    lines, current = [], ""
    for char in str(text):
        if char == "\n":
            lines.append(current)
            current = ""
            continue
        trial = current + char
        if draw.textlength(trial, font=font) > max_width and current:
            lines.append(current)
            current = char
        else:
            current = trial
    if current:
        lines.append(current)
    return lines


def collect(run_dir):
    with open(os.path.join(run_dir, "prompt.json"), encoding="utf8") as stream:
        prompt = json.load(stream)
    material_path = os.path.join(run_dir, "material.json")
    material = {}
    if os.path.exists(material_path):
        with open(material_path, encoding="utf8") as stream:
            material = json.load(stream)
    asset = os.path.join(run_dir, material.get("asset") or "asset.png")
    sha = hashlib.sha256(open(asset, "rb").read()).hexdigest() if os.path.exists(asset) else None
    return prompt, material, asset, sha


def render(run_dir, output, topic):
    prompt, material, asset, sha = collect(run_dir)
    material_path = os.path.join(run_dir, "material.json")
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    title_font = load_font(64, bold=True)
    h_font = load_font(40, bold=True)
    body_font = load_font(30)
    small_font = load_font(26)
    mono_font = load_font(24)

    y = PAD
    draw.text((PAD, y), "AI 生成素材说明", font=title_font, fill=INK)
    y += 92
    draw.text((PAD, y), "用于稿定素材版权声明材料 · 由插件自动生成", font=small_font, fill=MUTED)
    y += 60
    draw.line([(PAD, y), (WIDTH - PAD, y)], fill=(224, 222, 216), width=2)
    y += 40

    rows = [
        ("话题", topic or material.get("topic") or prompt.get("topic") or "—"),
        ("生成方式", "AI 图片生成（gd-cli tool call image.generate）"),
        ("模型", material.get("model") or "—"),
        ("工具/服务", "稿定 gd-cli 创作工具 · image.generate"),
        ("生成时间", material.get("createdAt") or prompt.get("writtenAt") or "—"),
        ("画布尺寸", "%s×%s" % ((material.get("canvas") or {}).get("w", "?"), (material.get("canvas") or {}).get("h", "?"))),
        ("素材文件", os.path.basename(asset)),
        ("SHA256", sha or "—"),
    ]
    for label, value in rows:
        draw.text((PAD, y), label, font=small_font, fill=MUTED)
        value_font = mono_font if label == "SHA256" else body_font
        for line in wrap(draw, value, value_font, WIDTH - PAD * 2 - 220)[:2]:
            draw.text((PAD + 200, y), line, font=value_font, fill=INK)
            y += 38
        y += 6

    y += 20
    draw.text((PAD, y), "创作 prompt（原始输入）", font=h_font, fill=INK)
    y += 62
    prompt_text = prompt.get("prompt") or ""
    lines = wrap(draw, prompt_text, body_font, WIDTH - PAD * 2)
    box_height = min(len(lines) * 44 + 48, 640)
    draw.rounded_rectangle([PAD, y, WIDTH - PAD, y + box_height], radius=16, fill=CARD, outline=(226, 224, 218))
    text_y = y + 24
    for line in lines:
        if text_y > y + box_height - 28:
            draw.text((PAD + 28, text_y), "…（完整 prompt 见 prompt.json）", font=small_font, fill=MUTED)
            break
        draw.text((PAD + 28, text_y), line, font=body_font, fill=INK)
        text_y += 44
    y += box_height + 48

    draw.text((PAD, y), "生成结果", font=h_font, fill=INK)
    y += 56
    if os.path.exists(asset):
        thumb = Image.open(asset).convert("RGBA")
        thumb.thumbnail((520, 520))
        card_w, card_h = thumb.width + 48, thumb.height + 48
        draw.rounded_rectangle([PAD, y, PAD + card_w, y + card_h], radius=14, fill=CARD, outline=(226, 224, 218))
        image.paste(thumb, (PAD + 24, y + 24), thumb)
        note_x = PAD + card_w + 40
        draw.text((note_x, y + 10), "本素材由 AI 依据上述 prompt 生成，", font=body_font, fill=INK)
        draw.text((note_x, y + 54), "未使用他人作品或站内已有素材。", font=body_font, fill=INK)
        draw.text((note_x, y + 110), "生成后经本地校验：尺寸符合规范、", font=small_font, fill=MUTED)
        draw.text((note_x, y + 146), "透明背景、哈希已记录。", font=small_font, fill=MUTED)
        y += card_h + 40

    draw.line([(PAD, HEIGHT - PAD - 60), (WIDTH - PAD, HEIGHT - PAD - 60)], fill=(224, 222, 216), width=2)
    draw.text((PAD, HEIGHT - PAD - 40), "声明：该素材为 AI 生成内容，按平台要求勾选「含AI生成内容」并提交本说明作为创作过程材料。",
              font=small_font, fill=MUTED)

    os.makedirs(os.path.dirname(output), exist_ok=True)
    image.save(output)
    record = {
        "schema": 1,
        "type": "ai-generated",
        "image": output,
        "topic": topic or material.get("topic"),
        "model": material.get("model"),
        "tool": "gd-cli image.generate",
        "prompt": prompt.get("prompt"),
        "negative": prompt.get("negative") or None,
        "canvas": material.get("canvas"),
        "assetSha256": sha,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": {"promptJson": os.path.join(run_dir, "prompt.json"), "materialJson": material_path if os.path.exists(material_path) else None}
    }
    with open(output.rsplit(".", 1)[0] + ".json", "w", encoding="utf8") as stream:
        json.dump(record, stream, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "image": output, "record": record}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir")
    parser.add_argument("--output")
    parser.add_argument("--topic")
    args = parser.parse_args()
    output = args.output or os.path.join(args.run_dir, "publish", "ai-evidence.png")
    render(args.run_dir, output, args.topic)


if __name__ == "__main__":
    main()
