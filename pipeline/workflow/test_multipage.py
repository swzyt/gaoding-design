import hashlib,json,tempfile,unittest
from pathlib import Path
from PIL import Image
from assemble import build
class MultiPageTest(unittest.TestCase):
 def test_two_physical_canvases_native_text_and_reproducible_package(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);Image.new('RGB',(100,100),'navy').save(p/'master.jpg')
   recipe={'canvas':{'w':100,'h':100},'pages':[{'id':'print','canvas':{'w':100,'h':100,'dpi':300}},{'id':'display','canvas':{'w':120,'h':160}}],'layers':[{'id':'b','page':'print','name':'print base','type':'shape','box':[0,0,100,100],'color':[10,20,30,255],'ellipse':True,'copyright_category':'original'},{'id':'t','page':'print','name':'print title','type':'text','box':[30,30,60,20],'text':'Hello','size':12,'color':[255,255,255]},{'id':'s','page':'display','name':'display base','type':'shape','box':[0,0,120,160],'color':[100,120,130,255],'copyright_category':'original'}]}
   f=p/'release-recipe.json';f.write_text(json.dumps(recipe));out=build(f);spec=json.loads((out/'spec.json').read_text());before=hashlib.sha256((out/'spec.json').read_bytes()).hexdigest()
   self.assertEqual(len(spec['pages']),2);self.assertEqual(spec['layers'][1]['type'],'text');self.assertEqual(spec['pages'][0]['canvas']['w'],100);self.assertEqual(spec['pages'][1]['canvas']['h'],160);self.assertTrue((out/'pages/print/template.psd').exists());build(f);self.assertEqual(before,hashlib.sha256((out/'spec.json').read_bytes()).hexdigest())
if __name__=='__main__':unittest.main()
