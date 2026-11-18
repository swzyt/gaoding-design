"""Local contract and pixel/PSD round-trip tests; no production or browser calls."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageFont
from assemble import build, preview
from zipfile import ZipFile
from text_style import normalize_style, render_text

ROOT = Path(__file__).resolve().parents[2]
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'


def row(**changes):
    return dict(dict(id='title', name='Title', type='text', text='HH\nHH', box=[10, 10, 180, 90],
                     size=24, color=[255, 0, 0], font='ArialMT', preview_font=FONT), **changes)


class TypographyTest(unittest.TestCase):
    def render(self, **changes):
        r = row(**changes)
        canvas = Image.new('RGBA', (220, 150))
        render_text(canvas, r, ImageFont.truetype(FONT, r['size']), r['box'])
        return canvas

    def test_alignment_and_baseline_positions_by_actual_pixels(self):
        left = self.render(text='HH', align='left')
        center = self.render(text='HH', align='center')
        right = self.render(text='HH', align='right')
        lb, cb, rb = (im.getbbox() for im in (left, center, right))
        self.assertAlmostEqual((cb[0]+cb[2])/2, 100, delta=2)
        self.assertAlmostEqual(rb[2], 190, delta=3)
        self.assertGreater(cb[0], lb[0]+60)
        self.assertGreater(rb[0], cb[0]+60)
        image = self.render(line_height=1.5)
        rows = [y for y in range(image.height) if image.getchannel('A').crop((0,y,220,y+1)).getbbox()]
        starts = [y for y in rows if y-1 not in rows]
        self.assertEqual(starts, [10, 46])

    def test_spacing_expands_glyph_positions_and_stroke_has_real_pixels(self):
        normal = self.render(text='HH', letter_spacing=0)
        spaced = self.render(text='HH', letter_spacing=8)
        self.assertEqual(spaced.getbbox()[2]-normal.getbbox()[2], 8)
        self.assertEqual(spaced.getbbox()[0], normal.getbbox()[0])
        outlined = self.render(text='HH', stroke=[[0, 0, 255], 2])
        colors = list(outlined.getdata())
        self.assertTrue(any(b > 200 and r < 20 and a > 200 for r,g,b,a in colors))
        self.assertTrue(any(r > 200 and b < 20 and a > 200 for r,g,b,a in colors))
        self.assertGreater(outlined.getbbox()[3]-outlined.getbbox()[1], normal.getbbox()[3]-normal.getbbox()[1])

    def test_vertical_overflow_and_unsupported_effects_fail_explicitly(self):
        for change in (dict(box=[10,10,180,25]), dict(rotation=20), dict(align='justify'),
                       dict(font_weight=700), dict(letter_spacing=2, text='a\u0301'),
                       dict(stroke=[[0,0,0],1.5]), dict(line_height=float('nan'))):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.render(**change)
        self.assertEqual(normalize_style(row())['line_height'], 1.25)

    def test_preview_does_not_require_master_or_write_release(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            Image.new('RGBA',(4,4),(0,255,0,255)).save(root/'source.png')
            recipe = {'canvas':{'w':220,'h':150}, 'layers':[
                {'id':'image','name':'Image','type':'image','source':'source.png','box':[0,0,4,4]},row()]}
            path = root/'draft.json'; path.write_text(json.dumps(recipe))
            with patch('assemble.subprocess.run', side_effect=AssertionError('preview must not invoke PSD')):
                result = preview(path, root/'chosen.png')
            self.assertEqual(Image.open(result).getpixel((1,1)), (0,255,0,255))
            self.assertFalse((root/'release').exists())
            self.assertFalse((root/'master.jpg').exists())

    def test_legacy_direct_spec_and_rotation_rejection(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            spec = {'canvas':{'w':220,'h':150}, 'layers':[row(size=18)]}
            path = root/'spec.json'; path.write_text(json.dumps(spec))
            env = dict(os.environ, NODE_PATH=str(ROOT/'pipeline/workflow/node_modules'))
            command = ['node',str(ROOT/'tooling/spec_to_psd.js'),str(path),str(root/'out.psd')]
            subprocess.run(command,env=env,check=True,capture_output=True)
            code = "const {readPsd}=require('ag-psd');const fs=require('fs');console.log(readPsd(fs.readFileSync(process.argv[1]),{skipLayerImageData:true,skipCompositeImageData:true}).children[0].text.style.leading)"
            self.assertEqual(subprocess.check_output(['node','-e',code,str(root/'out.psd')],env=env).strip(), b'22')
            for changes in (dict(rotation=15),dict(color=[255,0,0,128]),dict(align='justify'),dict(shadow=True)):
                spec['layers']=[row(**changes)];path.write_text(json.dumps(spec))
                result = subprocess.run(command,env=env,capture_output=True,text=True)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('Error:',result.stderr)

    def test_psd_native_style_dpi_and_raster_cache_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            Image.new('RGB',(220,150)).save(root/'master.jpg')
            r = row(align='right', line_height=1.5, letter_spacing=3, stroke=[[0,0,255],2])
            recipe = {'canvas':{'w':220,'h':150,'dpi':300},'layers':[r]}
            path = root/'recipe.json'; path.write_text(json.dumps(recipe))
            out = build(path)
            with ZipFile(out/'materials.zip') as archive:
                self.assertIn('text-cache/title.png', archive.namelist())
            code = """
const fs = require('fs'); const {readPsd, initializeCanvas} = require('ag-psd');
initializeCanvas(() => {throw new Error('Canvas not needed');}, (width,height) => ({width,height,data:new Uint8ClampedArray(width*height*4)}));
const p = readPsd(fs.readFileSync(process.argv[1]), {useImageData:true,skipCompositeImageData:true});
const l=p.children[0]; console.log(JSON.stringify({count:p.children.length,text:l.text,
 left:l.left,top:l.top,dpi:p.imageResources.resolutionInfo.horizontalResolution,
 width:l.imageData.width,height:l.imageData.height,pixels:Buffer.from(l.imageData.data).toString('base64')}));
"""
            env = dict(os.environ, NODE_PATH=str(ROOT/'pipeline/workflow/node_modules'))
            data = json.loads(subprocess.check_output(['node','-e',code,str(out/'template.psd')], env=env))
            self.assertEqual(data['count'], 1)  # No fake extra raster text layer.
            self.assertEqual(data['text']['text'], 'HH\nHH')
            self.assertEqual(data['text']['style']['font']['name'], 'ArialMT')
            self.assertEqual(data['text']['style']['leading'], 36)
            self.assertFalse(data['text']['style']['autoLeading'])
            self.assertEqual(data['text']['style']['tracking'], 125)
            self.assertEqual(data['text']['style']['outlineWidth'], 2)
            self.assertTrue(data['text']['style']['strokeFlag'])
            self.assertEqual(data['text']['paragraphStyle']['justification'], 'right')
            self.assertEqual(data['text']['shapeType'], 'box')
            self.assertEqual(data['text']['boxBounds'], [2,2,178,88])
            self.assertEqual(data['dpi'], 300)
            pixels = Image.frombytes('RGBA',(data['width'],data['height']),base64.b64decode(data['pixels']))
            expected = self.render(align='right', line_height=1.5, letter_spacing=3, stroke=[[0,0,255],2])
            # Re-read actual PSD channels, compare local glyph pixels and positions.
            restored = Image.new('RGBA',(220,150)); restored.alpha_composite(pixels,(data['left'],data['top']))
            self.assertEqual(restored.tobytes(), expected.tobytes())
            self.assertGreater(restored.getbbox()[0], 140)
            self.assertEqual(restored.getbbox()[1], 10)


if __name__ == '__main__':
    unittest.main()
