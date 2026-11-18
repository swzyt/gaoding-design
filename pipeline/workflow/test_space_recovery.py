# -*- coding: utf-8 -*-
"""Space recovery contracts; all state is temporary and browser calls are mocked."""
import copy,hashlib,json,os,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import orchestrator
from orchestrator import recover_space,locked,read,write

class SpaceRecoveryTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.data=Path(self.temp.name)/'data';self.root=self.data/'runs'/'original';self.concept=self.root/'build'/'original-concept'
  self.release=self.concept/'release';self.release.mkdir(parents=True)
  self.url='https://www.gaoding.com/editor/design?id=38523285990143122&mode=edit'
  self.state={'space':18,'status':'attention','started_at':123456.75,'requested_topic':'原始话题','topic_snapshot':{'key':'topic-50','id':'50','name':'原始话题','rules_url':'https://gdce.yuque.com/team/book/rules'},'repository_id':None,'mode':'native','registration':'agent','gate':'existing-gate','stages':{'native_creative':{'state':'done','result':str(self.concept)},'build':{'state':'done','result':True,'seconds':12.5},'editor_prepare':{'state':'attention','error':'space missing'},'provider_task':{'state':'done','result':{'taskId':'paid-existing-id','contentId':'38523285990143122'}}}}
  write(self.root/'run.json',self.state)
  write(self.concept/'release-recipe.json',{'output':'release','title':'保留原作品'})
  write(self.release/'editor-state.json',{'stage':'ready-for-visual-review','url':self.url,'importedPages':['main']})
  write(self.release/'publication.json',{'designUrl':self.url,'published':False})
  self.subscription=self.data/'subscriptions'/'original.json';write(self.subscription,{'space':18,'jobs':[{'args':['auto',str(self.root),'--space','18']}]})
  self.inventory={'checked_at':'2026-11-06T13:00:00+00:00','spaces':[{'id':0,'ownership':'user'},{'id':19,'ownership':'agent'}]}
  self.addCleanup(patch.stopall)
  patch.object(orchestrator,'DATA',self.data).start()
  self.inspect=patch.object(orchestrator,'inspect_browser_spaces',return_value=self.inventory).start()
 def recover(self,**kwargs):
  return recover_space(self.root,kwargs.pop('previous_space',18),kwargs.pop('space',19),kwargs.pop('user_authorized',True),**kwargs)
 def assert_rejected_unchanged(self,pattern,**kwargs):
  before=(self.root/'run.json').read_bytes();editor=(self.release/'editor-state.json').read_bytes();subscription=self.subscription.read_bytes()
  with self.assertRaisesRegex((ValueError,RuntimeError),pattern):self.recover(**kwargs)
  self.assertEqual((self.root/'run.json').read_bytes(),before);self.assertEqual((self.release/'editor-state.json').read_bytes(),editor);self.assertEqual(self.subscription.read_bytes(),subscription)
  self.assertFalse((self.root/'space-recovery-history.json').exists())
 def test_only_space_changes_and_history_preserves_original_work(self):
  before=(self.root/'run.json').read_bytes();subscription=self.subscription.read_bytes();editor=(self.release/'editor-state.json').read_bytes()
  result=self.recover();expected=copy.deepcopy(self.state);expected['space']=19
  self.assertEqual(read(self.root/'run.json'),expected)
  self.assertEqual(self.subscription.read_bytes(),subscription);self.assertEqual((self.release/'editor-state.json').read_bytes(),editor)
  history=read(self.root/'space-recovery-history.json');self.assertEqual(len(history),1)
  record=history[0];self.assertTrue(record['user_authorized']);self.assertEqual(record['status'],'applied');self.assertEqual(record['url'],self.url);self.assertEqual(record['previous_space'],18);self.assertEqual(record['space'],19)
  self.assertEqual(record['before_run_sha256'],hashlib.sha256(before).hexdigest());self.assertEqual(record['after_run_sha256'],hashlib.sha256((self.root/'run.json').read_bytes()).hexdigest())
  self.assertEqual(record['browser_verification'],self.inventory);self.assertEqual(result['content_id'],'38523285990143122');self.inspect.assert_called_once_with()
 def test_authorization_and_original_space_are_required(self):
  self.assert_rejected_unchanged('user-authorized',user_authorized=False);self.inspect.assert_not_called()
  self.assert_rejected_unchanged('does not match',previous_space=17)
  self.assert_rejected_unchanged('distinct',space=18)
 def test_existing_original_space_and_user_owned_replacement_fail(self):
  self.inspect.return_value={**self.inventory,'spaces':[{'id':18,'ownership':'agent'},{'id':19,'ownership':'agent'}]}
  self.assert_rejected_unchanged('still exists')
  self.inspect.return_value={**self.inventory,'spaces':[{'id':19,'ownership':'user'}]};self.assert_rejected_unchanged('Agent-owned')
  self.inspect.return_value={**self.inventory,'spaces':[]};self.assert_rejected_unchanged('Agent-owned')
 def test_browser_failure_makes_no_state_changes(self):
  self.inspect.side_effect=RuntimeError('browser unavailable');self.assert_rejected_unchanged('browser unavailable')
 def test_live_controller_editor_lock_and_launch_marker_fail(self):
  with locked(self.root/'.run.lock'):self.assert_rejected_unchanged('Already running')
  with locked(self.data/'.editor.lock'):self.assert_rejected_unchanged('editor busy')
  (self.root/'.plugin-launch.lock').mkdir();self.assert_rejected_unchanged('writer/launch lock')
 def test_live_process_is_rejected_even_when_state_is_attention(self):
  write(self.root/'.plugin-process.json',{'status':'running','pid':os.getpid()});self.assert_rejected_unchanged('still active')
 def test_running_state_requires_positive_exit_evidence_and_preserves_running_stages(self):
  self.state['status']='running';self.state['stages']['editor_prepare']['state']='running';write(self.root/'run.json',self.state)
  self.assert_rejected_unchanged('evidence')
  write(self.root/'.plugin-process.json',{'status':'running','pid':999999})
  with patch.object(orchestrator,'process_alive',return_value=False):self.recover()
  state=read(self.root/'run.json');self.assertEqual(state['status'],'running');self.assertEqual(state['stages'],self.state['stages']);self.assertEqual(state['space'],19)
 def test_uncertain_launch_and_other_writer_markers_fail(self):
  write(self.root/'.plugin-process.json',{'status':'launching'});self.assert_rejected_unchanged('launch state is uncertain')
  write(self.root/'.plugin-process.json',{'status':'failed','finishedAt':'2026-11-06T13:00:00Z'})
  (self.concept/'prepare.lock').write_text('uncertain handoff');self.assert_rejected_unchanged('writer/launch lock')
 def test_missing_permanent_editor_id_and_conflicting_publication_fail(self):
  write(self.release/'editor-state.json',{'url':'https://www.gaoding.com/editor/design?mode=create'});self.assert_rejected_unchanged('permanent')
  write(self.release/'editor-state.json',{'url':self.url});write(self.release/'publication.json',{'contentId':'different-existing-work'});self.assert_rejected_unchanged('CMS content')
 def test_prior_history_is_preserved_and_repeated_old_request_fails(self):
  old={'status':'applied','user_authorized':True,'space':18,'previous_space':17,'url':self.url,'content_id':'38523285990143122','editor_state':str(self.release/'editor-state.json')};write(self.root/'space-recovery-history.json',[old])
  self.recover();history=read(self.root/'space-recovery-history.json');self.assertEqual(history[0],old);self.assertEqual(len(history),2)
  before=(self.root/'run.json').read_bytes();history_bytes=(self.root/'space-recovery-history.json').read_bytes()
  with self.assertRaisesRegex(ValueError,'does not match'):self.recover()
  self.assertEqual((self.root/'run.json').read_bytes(),before);self.assertEqual((self.root/'space-recovery-history.json').read_bytes(),history_bytes)
 def test_failed_history_write_does_not_change_space(self):
  before=(self.root/'run.json').read_bytes()
  with patch.object(orchestrator,'write',side_effect=OSError('disk full')):
   with self.assertRaisesRegex(OSError,'disk full'):self.recover()
  self.assertEqual((self.root/'run.json').read_bytes(),before)
 def published_mapping(self,cms='202307918',source='content'):
  at='2026-11-06T14:21:00Z';latest={'content_id':cms,'version_no':None,'payload':{'id':cms}}
  publication={'published':True,'stage':'metadata-verification-failed','designUrl':self.url,'contentId':cms,'metadataVerification':{'passed':False,'error':'policy mismatch'},'metadataObserved':{'content_id':cms,'designUrl':self.url,'source':source,'observedAt':at,'evidenceFile':'publication-metadata.json'}}
  evidence={'observedAt':at,'source':source,'content':{'id':cms} if source=='content' else None,'versions':[latest] if source=='versions' else None,'latest':latest}
  write(self.release/'publication.json',publication);write(self.release/'publication-metadata.json',evidence)
  return publication,evidence
 def test_published_cms_and_editor_design_ids_are_distinct_and_policy_failure_is_preserved(self):
  publication,_=self.published_mapping();publication_bytes=(self.release/'publication.json').read_bytes()
  result=self.recover();history=read(self.root/'space-recovery-history.json')
  self.assertEqual(result['design_id'],'38523285990143122');self.assertEqual(result['cms_content_id'],'202307918');self.assertEqual(result['content_id_role'],'design_id')
  self.assertEqual(history[-1]['design_id'],'38523285990143122');self.assertEqual(history[-1]['cms_content_id'],'202307918');self.assertEqual((self.release/'publication.json').read_bytes(),publication_bytes)
  self.assertEqual(read(self.release/'publication.json'),publication);self.assertEqual(read(self.root/'run.json')['stages'],self.state['stages'])
 def test_versions_observation_maps_the_same_design_to_its_cms_id(self):
  self.published_mapping(source='versions');editor=orchestrator.recovery_editor(self.root.resolve(),self.state)
  self.assertEqual(editor['design_id'],'38523285990143122');self.assertEqual(editor['cms_content_id'],'202307918')
 def test_unknown_and_conflicting_cms_design_mappings_fail_without_changes(self):
  write(self.release/'publication.json',{'published':True,'contentId':'202307918','designUrl':self.url});self.assert_rejected_unchanged('mapping')
  publication,evidence=self.published_mapping();publication['metadataObserved']['content_id']='202307919';write(self.release/'publication.json',publication);self.assert_rejected_unchanged('mapping')
  publication,evidence=self.published_mapping();publication['designUrl']='https://www.gaoding.com/editor/design?id=123';write(self.release/'publication.json',publication);self.assert_rejected_unchanged('URL conflicts')
  publication,evidence=self.published_mapping();evidence['latest']['content_id']='202307919';write(self.release/'publication-metadata.json',evidence);self.assert_rejected_unchanged('metadata evidence')
 def test_legacy_prepublication_history_is_preserved_after_cms_id_becomes_known(self):
  old={'status':'applied','user_authorized':True,'space':18,'previous_space':17,'content_id':'38523285990143122','url':self.url,'editor_state':str(self.release/'editor-state.json')}
  write(self.root/'space-recovery-history.json',[old]);self.published_mapping();self.recover()
  history=read(self.root/'space-recovery-history.json');self.assertEqual(history[0],old);self.assertNotIn('design_id',history[0]);self.assertEqual(history[-1]['cms_content_id'],'202307918')
 def test_previously_recorded_cms_id_cannot_silently_change(self):
  self.published_mapping(cms='202307919')
  old={'status':'applied','user_authorized':True,'space':18,'previous_space':17,'design_id':'38523285990143122','cms_content_id':'202307918','url':self.url,'editor_state':str(self.release/'editor-state.json')}
  write(self.root/'space-recovery-history.json',[old]);state_before=(self.root/'run.json').read_bytes();history_before=(self.root/'space-recovery-history.json').read_bytes()
  with self.assertRaisesRegex(ValueError,'Original CMS content ID changed'):self.recover()
  self.assertEqual((self.root/'run.json').read_bytes(),state_before);self.assertEqual((self.root/'space-recovery-history.json').read_bytes(),history_before)
 def test_inventory_helper_is_read_only_and_accepts_cli_stderr(self):
  response=SimpleNamespace(stdout='',stderr='GAODING_SPACE_INVENTORY:'+json.dumps(self.inventory['spaces'])+'\n')
  # Keep the real helper callable while recovery itself uses the isolated inventory mock.
  with patch('subprocess.run',return_value=response) as invoke:
   facts=REAL_INSPECT()
  self.assertEqual(facts['spaces'],self.inventory['spaces'])
  script=invoke.call_args.kwargs['input'];self.assertIn('await listTaskSpaces()',script);self.assertNotIn('taskSpace(',script);self.assertNotIn('.page(',script);self.assertNotIn('goto(',script)
 def test_cli_dispatch_preserves_register_assets_and_does_not_launch_browser_for_recovery(self):
  import run as cli
  with patch('sys.argv',['workflow','recover-space',str(self.root),'--previous-space','18','--space','19','--user-authorized']),patch.object(orchestrator,'recover_space',return_value={'space':19}) as recover,patch('builtins.print'):
   cli.main();recover.assert_called_once_with(self.root,18,19,True)
  with patch('sys.argv',['workflow','browser','register-assets',str(self.concept/'release-recipe.json'),'--space','19']),patch.object(cli,'ego',return_value='/mock/ego'),patch.object(cli.subprocess,'run') as invoke:
   cli.main()
  script=invoke.call_args.kwargs['input'];self.assertIn('dam_browser.js',script);self.assertIn('default.register(',script);self.assertIn('registered-assets/request.json',script)

REAL_INSPECT=orchestrator.inspect_browser_spaces
if __name__=='__main__':unittest.main()
