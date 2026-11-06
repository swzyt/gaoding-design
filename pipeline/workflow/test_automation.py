# -*- coding: utf-8 -*-
import copy,json,tempfile,time,threading,unittest
from pathlib import Path
from unittest.mock import patch
from parallel import execute
from research_cache import fingerprint,lookup,store
from jobs import run
from orchestrator import Controller,read,write
class AutomationTests(unittest.TestCase):
 def test_cache_invalidation_and_corruption(self):
  live={'url':'topic/1','title':'one','rules':'size 1242','rules_images':[]}
  samples=[{'rank':str(i),'src':'img/'+str(i),'sha256':str(i)} for i in range(10)]
  key=fingerprint(live,samples)
  self.assertNotEqual(key,fingerprint(dict(live,rules='size 2000'),samples))
  self.assertNotEqual(key,fingerprint(live,list(reversed(samples))))
  changed=copy.deepcopy(samples);changed[0]['sha256']='replaced bytes'
  self.assertNotEqual(key,fingerprint(live,changed))
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'root';root.mkdir();cache=Path(d)/'cache';out=Path(d)/'out';out.mkdir()
   (root/'analysis.md').write_text('observed composition');write(root/'research-review.json',{'passed':True,'samples':list(range(10))});store(cache,key,root)
   self.assertTrue(lookup(cache,key,out));(cache/key/'analysis.md').write_text('tampered');self.assertFalse(lookup(cache,key,out))
 def test_parallel_dependencies_and_bound(self):
  active=0;peak=0;done=set();lock=threading.Lock()
  def worker(n):
   nonlocal active,peak
   with lock:
    self.assertTrue(set(n.get('depends',[]))<=done);active+=1;peak=max(peak,active)
   time.sleep(.03)
   with lock:active-=1;done.add(n['id'])
  execute([{'id':'a'},{'id':'b'},{'id':'c','depends':['a','b']}],worker,2)
  self.assertEqual(peak,2);self.assertEqual(done,{'a','b','c'})
 def test_failure_does_not_launch_dependents(self):
  called=[]
  def worker(n):
   called.append(n['id'])
   if n['id']=='a':raise RuntimeError('failed')
  with self.assertRaises(RuntimeError):execute([{'id':'a'},{'id':'b','depends':['a']}],worker,2)
  self.assertEqual(called,['a'])
 def test_cycle_before_any_work(self):
  with self.assertRaises(ValueError):execute([{'id':'a','depends':['b']},{'id':'b','depends':['a']}],lambda n:self.fail(),2)
 def test_paid_jobs_resume_and_uncertain_never_resubmit(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);write(p/'request.json',{'tool':'t','input':{'p':1}});write(p/'job.json',{'taskId':'existing'})
   with patch('jobs.call',return_value={'state':'completed','taskId':'existing','result':{}}) as call:
    run(p,'t',{'p':1});self.assertEqual(call.call_args.args,('task','get','existing','--json'))
   with patch('jobs.call',side_effect=AssertionError('must reuse')):run(p,'t',{'p':1})
  with tempfile.TemporaryDirectory() as d:
   (Path(d)/'submission-started').write_text('unknown')
   with patch('jobs.call',side_effect=AssertionError('must not resubmit')):
    with self.assertRaises(RuntimeError):run(d,'t',{'p':1})
 def test_exact_topic_and_resume_selection(self):
  with tempfile.TemporaryDirectory() as d:
   c=Controller(d,7,'repo',False,2,'tour')
   self.assertEqual(c.topic_names,['演唱会宣传出圈'])
   self.assertEqual(Controller(d,7,'repo',False,2,'演唱会宣传出圈').topic_names,c.topic_names)
   with self.assertRaises(ValueError):Controller(d,7,'repo',False,2,'concert')
   with self.assertRaises(ValueError):Controller(d,7,'repo',False,2)
  with tempfile.TemporaryDirectory() as d:
   with self.assertRaises(ValueError):Controller(d,7,'repo',False,2,'unknown')
   self.assertFalse((Path(d)/'run.json').exists())
 def test_completed_resume_preserves_time_and_never_republishes(self):
  with tempfile.TemporaryDirectory() as d:
   c=Controller(d,7,'repo',False,2);c.state.update(status='complete',elapsed_seconds=123,completed_at=456);c.save();(Path(d)/'events.jsonl').write_text('')
   with patch.object(c,'collect',side_effect=AssertionError('must not start again')):c.run()
   self.assertEqual(read(Path(d)/'run.json')['completed_at'],456);self.assertEqual(c.state['elapsed_seconds'],123)
 def test_gate_rejects_stale_or_missing_reviews(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);source=root/'input';source.write_text('one');c=Controller(root,7,'repo',False,2)
   with self.assertRaises(RuntimeError):c.gate('qa',[source],'Inspect image')
   gate=root/'gates/qa';request=read(gate/'request.json');write(gate/'response.json',{'passed':True,'token':'wrong','checks':['seen']})
   with self.assertRaises(ValueError):c.gate('qa',[source],'Inspect image')
   write(gate/'response.json',{'passed':True,'token':request['token'],'checks':['seen']});c.gate('qa',[source],'Inspect image')
   source.write_text('changed')
   with self.assertRaises(ValueError):c.gate('qa',[source],'Inspect image')
if __name__=='__main__':unittest.main()
