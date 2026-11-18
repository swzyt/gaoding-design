"""Fresh image downloads with bounded original-URL network fallback; no real network."""
import io,json,subprocess,tempfile,unittest
from http.client import RemoteDisconnected
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import research_cache

class ResearchDownloadTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  self.url='https://images.example/original.png?version=2';self.live={'url':'https://www.gaoding.com/topics/current','title':'Current','rules':'Current complete rules','samples':[{'rank':'TOP1','src':self.url}]}
  (self.root/'live.json').write_text(json.dumps(self.live));self.data=io.BytesIO();Image.new('RGB',(8,8),'red').save(self.data,format='PNG');self.png=self.data.getvalue()
 def curl(self,command,**kwargs):
  self.assertEqual(command[-1],self.url);self.assertIn('--max-time',command);self.assertEqual(command[command.index('--max-time')+1],'20');self.assertEqual(kwargs['timeout'],23);self.assertTrue(kwargs['check'])
  Path(command[command.index('--output')+1]).write_bytes(self.png)
 def test_urllib_success_has_timeout_and_never_calls_curl(self):
  with patch.object(research_cache,'urlopen',return_value=io.BytesIO(self.png)) as urlopen,patch.object(research_cache.subprocess,'run') as curl:
   research_cache.download(self.root,1)
  urlopen.assert_called_once_with(self.url,timeout=10);curl.assert_not_called();self.assertTrue((self.root/'sources.json').exists());self.assertEqual(list((self.root/'images').glob('*.partial')),[])
 def test_remote_disconnect_falls_back_to_same_url_and_validates_real_bytes(self):
  with patch.object(research_cache,'urlopen',side_effect=RemoteDisconnected('remote closed')),patch.object(research_cache.subprocess,'run',side_effect=self.curl) as curl:
   research_cache.download(self.root,1)
  self.assertEqual(curl.call_count,1)
  with Image.open(self.root/'images/01.png') as image:self.assertEqual(image.getpixel((0,0)),(255,0,0))
 def test_timeout_and_failed_curl_preserve_both_contexts(self):
  failure=subprocess.CalledProcessError(28,['curl'],stderr='curl maximum time exceeded')
  with patch.object(research_cache,'urlopen',side_effect=TimeoutError('urllib socket timeout')),patch.object(research_cache.subprocess,'run',side_effect=failure):
   with self.assertRaisesRegex(RuntimeError,'urllib socket timeout.*curl maximum time exceeded'):research_cache.download(self.root,1)
  self.assertFalse((self.root/'sources.json').exists());self.assertEqual(list((self.root/'images').glob('*.partial')),[])
 def test_invalid_urllib_image_is_rejected_without_network_error_fallback(self):
  with patch.object(research_cache,'urlopen',return_value=io.BytesIO(b'not an image')),patch.object(research_cache.subprocess,'run') as curl:
   with self.assertRaisesRegex(RuntimeError,'Research image 1'):research_cache.download(self.root,1)
  curl.assert_not_called();self.assertFalse((self.root/'sources.json').exists())
 def test_existing_image_cannot_replace_fresh_failed_or_invalid_download(self):
  dest=self.root/'images/01.png';dest.parent.mkdir();dest.write_bytes(self.png);before=dest.read_bytes()
  def invalid_curl(command,**kwargs):Path(command[command.index('--output')+1]).write_bytes(b'<html>network denial</html>')
  with patch.object(research_cache,'urlopen',side_effect=RemoteDisconnected('remote closed')),patch.object(research_cache.subprocess,'run',side_effect=invalid_curl):
   with self.assertRaisesRegex(RuntimeError,'curl fallback after RemoteDisconnected'):research_cache.download(self.root,1)
  self.assertEqual(dest.read_bytes(),before);self.assertFalse((self.root/'sources.json').exists())
 def test_urllib_partial_is_truncated_before_curl(self):
  class Broken(io.BytesIO):
   def read(self,size=-1):
    if self.tell():raise RemoteDisconnected('partial response')
    return super().read(4)
  def curl(command,**kwargs):
   dest=Path(command[command.index('--output')+1]);self.assertEqual(dest.read_bytes(),b'');dest.write_bytes(self.png)
  with patch.object(research_cache,'urlopen',return_value=Broken(b'partial bytes')),patch.object(research_cache.subprocess,'run',side_effect=curl):research_cache.download(self.root,1)

if __name__=='__main__':unittest.main()
