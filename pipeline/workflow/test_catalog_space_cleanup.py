# -*- coding: utf-8 -*-
"""Completed-goal space lifecycle tests using only temporary files and fake browser processes."""
import copy,json,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import Mock,patch
import orchestrator
from orchestrator import Controller,cleanup_catalog_space,read,write

class CatalogSpaceCleanupTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.data=Path(self.temp.name)/'data';self.root=self.data/'runs'/'one-goal';self.concept=self.root/'build'/'one-concept';self.out=self.concept/'release';self.out.mkdir(parents=True)
  self.catalog=self.data/'catalog'/'topics.json';self.url='https://www.gaoding.com/editor/design?id=1001'
  self.catalog_data={'space':19,'source':'https://creator.huaban.com/inspiration','checkedAt':'2026-11-06T12:00:00Z','status':'complete','topics':[{'key':'one','name':'新目录题目','rules_url':'https://gdce.yuque.com/team/book/rules'}],'received':1,'rejected':0}
  write(self.catalog,self.catalog_data)
  self.state={'space':19,'status':'complete','started_at':time.time()-100,'completed_at':time.time(),'elapsed_seconds':100,'mode':'native','repository_id':None,'stages':{'native_creative':{'state':'done','result':str(self.concept)},'submit':{'state':'done','result':{'published':True,'contentId':'1001'}},'reopen_verify':{'state':'done','result':{'verified':True}},'package':{'state':'done','result':str(self.root/'delivery')}}}
  write(self.root/'run.json',self.state);write(self.out/'editor-state.json',{'url':self.url});self.published_mapping()

  patcher=patch.object(orchestrator,'DATA',self.data);patcher.start();self.addCleanup(patcher.stop)
 def published_mapping(self,design='1001',cms='1001'):
  self.url='https://www.gaoding.com/editor/design?id='+design;at='2026-11-06T14:21:00Z'
  write(self.out/'editor-state.json',{'url':self.url})
  write(self.out/'publication.json',{'published':True,'contentId':cms,'designUrl':self.url,'metadataObserved':{'content_id':cms,'designUrl':self.url,'source':'content','observedAt':at,'evidenceFile':'publication-metadata.json'}})
  write(self.out/'publication-metadata.json',{'observedAt':at,'source':'content','content':{'id':cms},'versions':None,'latest':{'content_id':cms,'payload':{'id':cms}}})
 def cleanup(self):return cleanup_catalog_space(self.root,self.state)
 def recovery(self,old=18,new=19,**changes):
  return {'status':'applied','user_authorized':True,'previous_space':old,'space':new,'url':self.url,'content_id':'1001','editor_state':str(self.out/'editor-state.json'),**changes}
 def test_only_space_is_removed_and_all_topic_metadata_is_preserved(self):
  before_state=(self.root/'run.json').read_bytes();before_publication=(self.out/'publication.json').read_bytes();before_editor=(self.out/'editor-state.json').read_bytes()
  result=self.cleanup();expected=dict(self.catalog_data);del expected['space']
  self.assertEqual(result['status'],'cleared');self.assertEqual(read(self.catalog),expected)
  self.assertEqual((self.root/'run.json').read_bytes(),before_state);self.assertEqual((self.out/'publication.json').read_bytes(),before_publication);self.assertEqual((self.out/'editor-state.json').read_bytes(),before_editor)
  self.assertEqual(read(self.root/'catalog-space-cleanup.json')['status'],'cleared')
 def test_another_goals_space_is_never_cleared(self):
  write(self.catalog,dict(self.catalog_data,space=55));before=self.catalog.read_bytes()
  self.assertEqual(self.cleanup()['status'],'different-goal');self.assertEqual(self.catalog.read_bytes(),before)
 def test_authorized_same_work_recovery_chain_can_release_original_binding(self):
  write(self.catalog,dict(self.catalog_data,space=17))
  history=[self.recovery(17,18),self.recovery(18,19)];write(self.root/'space-recovery-history.json',history)
  self.assertEqual(self.cleanup()['status'],'cleared');self.assertNotIn('space',read(self.catalog));self.assertEqual(read(self.root/'space-recovery-history.json'),history)
 def test_legacy_design_id_history_releases_old_binding_after_a_different_cms_id_is_observed(self):
  self.published_mapping(design='38523285990143122',cms='202307918');write(self.catalog,dict(self.catalog_data,space=18))
  old=self.recovery(content_id='38523285990143122');write(self.root/'space-recovery-history.json',[old]);before=(self.root/'space-recovery-history.json').read_bytes();publication=(self.out/'publication.json').read_bytes()
  self.assertEqual(self.cleanup()['status'],'cleared');self.assertNotIn('space',read(self.catalog));self.assertEqual((self.root/'space-recovery-history.json').read_bytes(),before);self.assertEqual((self.out/'publication.json').read_bytes(),publication)
 def test_changed_or_unknown_cms_mapping_does_not_clear_a_recovery_ancestor(self):
  self.published_mapping(design='38523285990143122',cms='202307918');write(self.catalog,dict(self.catalog_data,space=18));before=self.catalog.read_bytes()
  record=self.recovery(design_id='38523285990143122',content_id='38523285990143122',cms_content_id='202307919');write(self.root/'space-recovery-history.json',[record])
  self.assertEqual(self.cleanup()['status'],'warning');self.assertEqual(self.catalog.read_bytes(),before)
  record['cms_content_id']='202307918';write(self.root/'space-recovery-history.json',[record]);publication=read(self.out/'publication.json');publication.pop('metadataObserved');write(self.out/'publication.json',publication)
  self.assertEqual(self.cleanup()['status'],'warning');self.assertEqual(self.catalog.read_bytes(),before);self.assertEqual(self.state['status'],'complete')
 def test_unapplied_unauthorized_unrelated_or_wrong_goal_history_cannot_release_old_space(self):
  for changes in ({'status':'prepared'},{'user_authorized':False},{'space':44},{'content_id':'2002'},{'editor_state':str(self.data/'runs'/'another'/'editor-state.json')},{'url':'https://www.gaoding.com/editor/design?id=2002'}):
   with self.subTest(changes=changes):
    write(self.catalog,dict(self.catalog_data,space=18));before=self.catalog.read_bytes();write(self.root/'space-recovery-history.json',[self.recovery(**changes)])
    result=self.cleanup();self.assertIn(result['status'],('different-goal','warning'));self.assertEqual(self.catalog.read_bytes(),before);self.assertEqual(self.state['status'],'complete')
 def test_failed_waiting_or_unverified_and_unpackaged_runs_do_not_touch_catalog(self):
  before=self.catalog.read_bytes()
  for status in ('running','waiting_agent','attention'):
   state=copy.deepcopy(self.state);state['status']=status
   self.assertEqual(cleanup_catalog_space(self.root,state)['status'],'skipped');self.assertEqual(self.catalog.read_bytes(),before)
  for stage in ('reopen_verify','package'):
   state=copy.deepcopy(self.state);state['stages'][stage]['state']='attention'
   self.assertEqual(cleanup_catalog_space(self.root,state)['status'],'skipped');self.assertEqual(self.catalog.read_bytes(),before)
  self.assertFalse((self.root/'catalog-space-cleanup.json').exists())
 def test_cleanup_failure_is_diagnostic_and_does_not_demote_published_work(self):
  before=self.catalog.read_bytes();publication=(self.out/'publication.json').read_bytes();state=copy.deepcopy(self.state)
  with patch.object(orchestrator.tempfile,'NamedTemporaryFile',side_effect=PermissionError('catalog is read-only')):
   self.assertEqual(self.cleanup()['status'],'warning')
  self.assertEqual(self.catalog.read_bytes(),before);self.assertEqual(self.state,state);self.assertEqual((self.out/'publication.json').read_bytes(),publication)
  self.assertIn('read-only',read(self.root/'catalog-space-cleanup.json')['error'])
 def test_changed_catalog_during_cleanup_is_preserved(self):
  actual_temp=orchestrator.tempfile.NamedTemporaryFile
  def change_before_commit(*args,**kwargs):
   write(self.catalog,dict(self.catalog_data,space=55));return actual_temp(*args,**kwargs)
  with patch.object(orchestrator.tempfile,'NamedTemporaryFile',side_effect=change_before_commit):
   self.assertEqual(self.cleanup()['status'],'warning')
  self.assertEqual(read(self.catalog)['space'],55);self.assertEqual(list(self.catalog.parent.glob('.topics-cleanup-*.tmp')),[])
 def test_symlinked_catalog_is_not_followed(self):
  original=self.data/'external-catalog.json';write(original,self.catalog_data);before=original.read_bytes()
  # This is an existing, explicitly known temporary fixture path.
  self.assertEqual(self.catalog.resolve().parent,(self.data/'catalog').resolve());self.catalog.unlink();self.catalog.symlink_to(original)
  self.assertEqual(self.cleanup()['status'],'warning');self.assertEqual(original.read_bytes(),before)
 def test_cleanup_is_idempotent(self):
  self.cleanup();before=self.catalog.read_bytes();self.assertEqual(self.cleanup()['status'],'already-unbound');self.assertEqual(self.catalog.read_bytes(),before)
 def controller(self,fail=None):
  controller=Controller.__new__(Controller);controller.root=self.root;controller.state=copy.deepcopy(self.state);controller.state['status']='running';controller.registration='gd-cli';controller.research=self.root/'research';controller.workers=1
  def stage(name,fn):
   if name==fail:controller.state['status']='attention';raise RuntimeError('stage failed: '+name)
   controller.state['stages'][name]={'state':'done','result':True};return True
  controller.stage=stage;controller.save=Mock(side_effect=lambda:write(self.root/'run.json',controller.state));controller.report=Mock()
  return controller
 def test_finish_design_cleans_only_after_verify_and_package_succeed(self):
  for failed in ('final_review','reopen_verify','package'):
   with self.subTest(failed=failed):
    controller=self.controller(failed);before=self.catalog.read_bytes()
    with self.assertRaisesRegex(RuntimeError,'stage failed'):controller.finish_design(self.concept)
    self.assertEqual(self.catalog.read_bytes(),before)
  controller=self.controller()
  with patch('builtins.print'):controller.finish_design(self.concept)
  self.assertEqual(controller.state['status'],'complete');self.assertNotIn('space',read(self.catalog));self.assertEqual(read(self.root/'run.json')['status'],'complete')
 def test_completed_run_reentry_cleans_without_repeating_stages(self):
  controller=self.controller();controller.state=copy.deepcopy(self.state);controller.mode='native';controller.stage=Mock(side_effect=AssertionError('must not repeat completed work'))
  with patch('builtins.print'):controller.run()
  controller.stage.assert_not_called();self.assertNotIn('space',read(self.catalog))
 def test_browser_goal_names_are_unique_and_known_missing_spaces_never_create_replacements(self):
  module=Path(__file__).resolve().parents[2]/'dsh-plugin-gaoding-publisher'/'topic-catalog.js'
  script='import {collectFromBrowser,loadCatalog} from '+json.dumps(module.as_uri())+';\n'+r'''
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
const scripts=[];
let failing=false,id=30;
function spawnProcess(_cli,args){
 scripts.push(args[2]);
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
 queueMicrotask(()=>{
  if(failing){child.stderr.emit('data','known TaskSpace unavailable');child.emit('close',1);return;}
  child.stderr.emit('data','GAODING_CATALOG:'+JSON.stringify({space:++id,source:'https://creator.huaban.com/inspiration',checkedAt:new Date().toISOString(),complete:true,payload:{topics:[]}})+'\n');child.emit('close',0);
 });return child;
}
await collectFromBrowser({spawnProcess});await collectFromBrowser({spawnProcess});
const names=scripts.map(s=>s.match(/taskSpace\(("[^"]+")\)/)?.[1]);
assert.ok(names.every(Boolean));assert.notEqual(names[0],names[1]);assert.ok(names.every(n=>n.includes('稿定投稿-')));
failing=true;
await assert.rejects(()=>collectFromBrowser({space:18,spawnProcess}),/unavailable/);
assert.ok(scripts.at(-1).includes('taskSpace(18)'));assert.equal(scripts.length,3);
let writes=0;
const cached={space:18,source:'https://creator.huaban.com/inspiration',status:'complete',topics:[],checkedAt:'2020-01-01T00:00:00Z'};
const result=await loadCatalog({read:()=>cached,write:()=>writes++,fetcher:async()=>({ok:false,status:401}),browser:options=>collectFromBrowser({...options,spawnProcess})});
assert.equal(result.status,'unavailable');assert.deepEqual(result.selectableTopics,[]);assert.equal(writes,0);assert.equal(scripts.length,4);assert.ok(scripts.at(-1).includes('taskSpace(18)'));
const explicit=await loadCatalog({read:()=>cached,write:()=>writes++,space:19,refresh:true,fetcher:async()=>({ok:false,status:401}),browser:options=>collectFromBrowser({...options,spawnProcess})});
assert.equal(explicit.status,'unavailable');assert.equal(scripts.length,5);assert.ok(scripts.at(-1).includes('taskSpace(19)'));
console.log('mock browser lifecycle passed');
'''
  result=subprocess.run(['node','--input-type=module','-e',script],capture_output=True,text=True,check=True,timeout=10)
  self.assertIn('mock browser lifecycle passed',result.stdout)

if __name__=='__main__':unittest.main()
