"""Portable native text subset. Distances are canvas pixels; line_height is a ratio.

Rotation is deliberately rejected until the editor importer preserves transforms.
Weights must be selected with real font/preview_font faces, never synthesized.
"""
import math
import unicodedata
from PIL import Image, ImageDraw


def _number(value, field, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{field} must be a finite number')
    if minimum is not None and value < minimum:
        raise ValueError(f'{field} must be >= {minimum}')
    return value


def normalize_style(row):
    name = row.get('name', 'text')
    for field in ('font_weight', 'font_style', 'weight', 'bold', 'italic', 'fauxBold', 'fauxItalic', 'text_effects', 'effects', 'warp', 'styleRuns', 'tracking', 'leading', 'shadow', 'gradient', 'opacity', 'vertical', 'text_transform', 'underline', 'strikethrough'):
        if field in row:
            raise ValueError(f'{name}: unsupported text field {field}; select a real font face and supported layout fields')
    size = _number(row['size'], 'size', 1)
    if int(size) != size:
        raise ValueError('size must be an integer pixel size for faithful preview')
    align = row.get('align', 'left')
    if align not in ('left', 'center', 'right'):
        raise ValueError(f'{name}: align must be left, center or right')
    line_height = _number(row.get('line_height', 1.25), 'line_height', 0.01)
    spacing = _number(row.get('letter_spacing', 0), 'letter_spacing')
    rotation = _number(row.get('rotation', 0), 'rotation')
    if rotation != 0:
        raise ValueError(f'{name}: nonzero rotation is unsupported by the native editor importer')
    color = row.get('color')
    if not isinstance(color, (list, tuple)) or len(color) not in (3, 4) or any(type(v) is not int or not 0 <= v <= 255 for v in color) or (len(color) == 4 and color[3] != 255):
        raise ValueError(f'{name}: text color must be opaque RGB bytes; translucent fill is unsupported')
    text = row['text']
    if not isinstance(text, str) or not text:
        raise ValueError(f'{name}: text must be a nonempty string')
    if any(c in text for c in ('\r', '\t')):
        raise ValueError(f'{name}: tabs/CR are unsupported; use explicit spaces and LF lines')
    if spacing and any(unicodedata.combining(c) or unicodedata.category(c) in ('Mn', 'Mc', 'Me', 'Cf') or unicodedata.bidirectional(c) in ('R', 'AL', 'AN') or ord(c) > 0xffff or 0x900 <= ord(c) <= 0xdff for c in text):
        raise ValueError(f'{name}: nonzero letter_spacing requires simple Latin/CJK text without combining or contextual shaping')
    stroke = row.get('stroke')
    if stroke is not None:
        if not isinstance(stroke, (list, tuple)) or len(stroke) != 2:
            raise ValueError(f'{name}: stroke must be [[r,g,b], integer_width]')
        color, width = stroke
        if not isinstance(color, (list, tuple)) or len(color) != 3 or any(type(v) is not int or not 0 <= v <= 255 for v in color):
            raise ValueError(f'{name}: stroke color must be RGB bytes')
        _number(width, 'stroke width', 0)
        if int(width) != width:
            raise ValueError('stroke width must be integer pixels')
        stroke = [list(color), int(width)]
    return dict(align=align, line_height=line_height, letter_spacing=spacing, rotation=0, stroke=stroke)


def render_text(canvas, row, font, box):
    """Render without wrapping; reject horizontal/vertical ink overflow, never clip."""
    style = normalize_style(row)
    x, y, w, h = box
    if w <= 0 or h <= 0:
        raise ValueError(f"{row['name']}: text box must have positive dimensions")
    spacing = style['letter_spacing']
    stroke = style['stroke']
    sw = stroke[1] if stroke else 0
    # Retain legacy rounded baseline step, and carry precisely that step to PSD.
    step = round(row['size'] * style['line_height'])
    if step < 1:
        raise ValueError('line_height produces a zero pixel baseline step')
    lines = row['text'].split('\n')
    if (len(lines)-1)*step+sw >= h:
        raise ValueError(f"text vertical overflow: {row['name']}, final line starts outside box")
    draw = ImageDraw.Draw(canvas)
    ink = []
    positions = []
    for i, line in enumerate(lines):
        width = (sum(font.getlength(c) for c in line) + spacing * max(0, len(line)-1)) if spacing else font.getlength(line)
        if width < 0:
            raise ValueError(f"{row['name']}: letter_spacing collapses text advance")
        if spacing and any(font.getlength(c) + spacing <= 0 for c in line[:-1]):
            raise ValueError(f"{row['name']}: letter_spacing reverses glyph order")
        # Preserve legacy tolerance only for old unstyled recipes; new layouts
        # must fit the actual native paragraph box, otherwise PSD would wrap.
        tolerance = 0 if any(k in row for k in ('align', 'letter_spacing', 'stroke')) else 4
        available = w-2*sw
        if width > available+tolerance:
            raise ValueError(f"text overflow: {row['name']}, {width:.1f}>{available}")
        left = x + (sw if style['align'] == 'left' else (w-width)/2 if style['align'] == 'center' else w-width-sw)
        top = y + sw + i*step
        if line:
            # The legacy lt anchor aligns visible ink to each line's top.
            bbox = draw.textbbox((left, top), line, font=font, anchor='lt', stroke_width=sw)
            bottom = bbox[3]
            if bottom > y+h or top-sw < y:
                raise ValueError(f"text vertical overflow: {row['name']}, ink [{top-sw},{bottom}] outside [{y},{y+h}]; enlarge/reposition box for stroke")
            ink.append(bbox)
        positions.append((left, top, line))
    # Draw to an isolated transparent cache so the PSD keeps both editable text
    # metadata and real pixels (ag-psd does not rasterize fonts itself).
    pad = max(int(row['size']) + sw, 4)
    layer = Image.new('RGBA', (w+2*pad, h+2*pad))
    d = ImageDraw.Draw(layer)
    for left, top, line in positions:
        px, py = left-x+pad, top-y+pad
        kwargs = dict(font=font, fill=tuple(row['color']), anchor='lt', stroke_width=sw,
                      stroke_fill=tuple(stroke[0]) if stroke else None)
        if spacing:
            # Use a common baseline, not per-glyph lt anchors (which move punctuation).
            baseline = py - font.getbbox(line, anchor='ls')[1] if line else py
            kwargs['anchor'] = 'ls'
            for char in line:
                d.text((px, baseline), char, **kwargs)
                px += font.getlength(char) + spacing
        else:
            d.text((px, py), line, **kwargs)
    bounds = layer.getbbox()
    if bounds:
        if bounds[0] < pad-4 or bounds[2] > w+pad+4 or bounds[3] > h+pad:
            raise ValueError(f"text ink overflow: {row['name']}; enlarge text box")
        cached = layer.crop(bounds)
        origin = [x+bounds[0]-pad, y+bounds[1]-pad]
        canvas.alpha_composite(cached, tuple(origin))
    else:
        cached = Image.new('RGBA', (1, 1)); origin = [x, y]
    return style, step, cached, origin
