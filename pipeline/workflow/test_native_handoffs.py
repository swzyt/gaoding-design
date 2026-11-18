"""Empty native handoff optimization keeps asset provenance and actual visual gates intact."""
import json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch
from agent_assets import prepare,validate
from orchestrator import Controller,AgentGatePending,complete_empty_native_handoff,read,write


class NativeHandoffTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name);self.concept=self.root/'build'/'native';self.concept.mkdir(parents=True)
  self.plan={'assets':[]};self.variants=[{'id':'a','recipe':'layout-a.json','rationale':'large type'},{'id':'b','recipe':'layout-b.json','rationale':'offset type'}]
  self.snapshot={'brief':{'concepts':[{'id':'native','asset_plan':self.plan,'layout_variants':self.variants}]}}
  write(self.concept/'native-input.json',self.snapshot);self.request=prepare(self.concept,self.plan)
  self.recipe={'canvas':{'w':400,'h':500},'layers':[{'id':'background','name':'background','type':'shape','box':[0,0,400,500],'color':[20,30,40],'copyright_category':'original'},{'id':'title','name':'title','type':'text','text':'original title','box':[20,20,300,100],'size':30,'font':'Example','preview_font':'Example','gd_font':'actual-font-id'}]}
  for variant in self.variants:write(self.concept/variant['recipe'],self.recipe)
 def response(self):return self.concept/'agent-assets/response.json'
 def test_frozen_empty_plan_creates_explicit_matching_response_without_claiming_visual_approval(self):
  self.assertTrue(complete_empty_native_handoff(self.concept));response=read(self.response())
  self.assertEqual(response['schema_version'],1);self.assertEqual(response['token'],self.request['token']);self.assertEqual(response['plan_sha256'],self.request['plan_sha256']);self.assertEqual(response['assets'],[])
  self.assertNotIn('passed',response);self.assertNotIn('selected_id',response);self.assertTrue(validate(self.concept,self.recipe)['validated'])
  before=self.response().read_bytes();self.assertTrue(complete_empty_native_handoff(self.concept));self.assertEqual(self.response().read_bytes(),before)
  self.assertFalse((self.root/'gates/03-layout/response.json').exists())
 def test_nonempty_plan_never_creates_an_empty_response(self):
  root=self.root/'nonempty';root.mkdir();plan={'assets':[{'id':'subject','source':'assets/subject.png'}]};prepare(root,plan)
  self.assertFalse(complete_empty_native_handoff(root));self.assertFalse((root/'agent-assets/response.json').exists())
 def test_missing_recipe_keeps_the_agent_preparation_handoff(self):
  missing=self.concept/'layout-b.json';self.assertEqual(missing.resolve().parent,self.concept.resolve());missing.unlink()
  self.assertFalse(complete_empty_native_handoff(self.concept));self.assertFalse(self.response().exists())
 def test_image_or_unknown_layer_cannot_be_misclassified_as_pure_native(self):
  for kind in ('image','unsupported-widget'):
   with self.subTest(kind=kind):
    recipe=dict(self.recipe,layers=[*self.recipe['layers'],{'id':'photo','type':kind,'source':'assets/photo.png'}]);write(self.concept/'layout-a.json',recipe)
    self.assertFalse(complete_empty_native_handoff(self.concept));self.assertFalse(self.response().exists())
 def test_changed_request_hash_and_native_plan_fail_without_generating_response(self):
  request=dict(self.request,plan_sha256='not-current');write(self.concept/'agent-assets/request.json',request)
  with self.assertRaisesRegex(ValueError,'mismatched'):complete_empty_native_handoff(self.concept)
  self.assertFalse(self.response().exists());write(self.concept/'agent-assets/request.json',self.request)
  snapshot=json.loads(json.dumps(self.snapshot));snapshot['brief']['concepts'][0]['asset_plan']={'assets':[{'id':'surprise'}]};write(self.concept/'native-input.json',snapshot)
  with self.assertRaisesRegex(ValueError,'differs'):complete_empty_native_handoff(self.concept)
  self.assertFalse(self.response().exists())
 def test_existing_conflicting_provenance_is_never_overwritten(self):
  write(self.response(),{'schema_version':1,'token':'stale','plan_sha256':self.request['plan_sha256'],'assets':[]});before=self.response().read_bytes()
  with self.assertRaisesRegex(ValueError,'mismatched'):complete_empty_native_handoff(self.concept)
  self.assertEqual(self.response().read_bytes(),before)
 def controller(self):
  controller=Controller(self.root,7,None,False,1,'tour');controller.state['stages'].update(research_collect={'state':'done','result':{'key':'fixture'}},native_creative={'state':'done','result':str(self.concept)})
  controller.save();return controller
 def run_to_visual_gate(self,prepare_missing=False):
  controller=self.controller();calls=[]
  def gate(name,inputs,instructions):
   calls.append(name)
   if name=='02-assets' and prepare_missing:
    write(self.concept/'layout-b.json',self.recipe);self.assertTrue(complete_empty_native_handoff(self.concept));return {'passed':True,'checks':['prepared fixture only, no appearance approval']}
   raise AgentGatePending('Actual Agent visual/preparation handoff required: '+name)
  controller.gate=gate
  records=[{'id':v['id'],'recipe':v['recipe'],'preview':v['id']+'.jpg'} for v in self.variants]
  with patch('native_design.render_variants',return_value=records),patch('orchestrator.subprocess.run',side_effect=AssertionError('must not invoke browser or provider')):
   with self.assertRaises(AgentGatePending):controller.run_native()
  return controller,calls
 def test_eligible_case_saves_exactly_one_preparation_gate_and_retains_03_visual_gate(self):
  controller,calls=self.run_to_visual_gate();self.assertEqual(calls,['03-layout']);self.assertEqual(controller.state['stages']['native_selection']['state'],'waiting_agent')
  self.assertNotIn('native_selection',controller.state.get('completed',[]));controller.report();report=read(self.root/'timing-report.json');self.assertEqual(report['handoffs']['unique_empty_asset_gates_avoided'],1)
  # Previous flow always requested 02-assets plus 03-layout. No timing percentage is inferred.
  self.assertEqual(2-len(calls),1)
 def test_missing_recipe_path_still_requires_02_then_03(self):
  missing=self.concept/'layout-b.json';self.assertEqual(missing.resolve().parent,self.concept.resolve());missing.unlink()
  controller,calls=self.run_to_visual_gate(prepare_missing=True);self.assertEqual(calls,['02-assets','03-layout']);self.assertEqual(controller.state['stages']['native_selection']['state'],'waiting_agent')
  controller.report();self.assertEqual(read(self.root/'timing-report.json')['handoffs']['unique_empty_asset_gates_avoided'],0)
 def test_nonempty_plan_stops_at_02_without_automatic_calls(self):
  root=self.root/'other';root.mkdir();plan={'assets':[{'id':'subject'}]};prepare(root,plan);self.concept=root
  controller,calls=self.run_to_visual_gate();self.assertEqual(calls,['02-assets']);self.assertFalse((root/'agent-assets/response.json').exists());self.assertNotIn('native_selection',controller.state['stages'])
 def test_registration_gate_points_to_existing_helper_without_assuming_page_label(self):
  controller=self.controller();controller.registration='agent';captured=[]
  controller.stage=lambda name,fn:fn() if name=='browser_registration' else True
  controller.gate=lambda name,inputs,instructions:captured.append((name,instructions)) or {'passed':True}
  with patch('browser_registration.prepare'),patch('browser_registration.validate',return_value={'validated':True}),patch('builtins.print'):controller.finish_design(self.concept)
  name,instructions=captured[0];self.assertEqual(name,'05-register');self.assertIn('register-assets',instructions);self.assertIn('<actual dedicated DAM Page label>',instructions);self.assertIn('Do not hand-calculate hashes or rewrite',instructions);self.assertIn('never navigate over the editor',instructions);self.assertIn('inspect the real',instructions)
 def test_review_packet_summary_is_advisory_without_missing_evidence_becoming_approval(self):
  controller=self.controller();controller.registration='gd-cli';captured=[]
  def packet(recipe):
   directory=recipe.parent/'release/review-packet';write(directory/'manifest.json',{'issues':['copyright evidence missing']});(directory/'agent-summary.md').write_text('Missing copyright evidence; actual visual review required')
   return {'directory':str(directory),'summary':str(directory/'agent-summary.md')}
  def gate(name,inputs,instructions):captured.append((name,inputs,instructions));raise AgentGatePending('Review required')
  controller.gate=gate;controller.stage=lambda name,fn:fn() if name=='final_review' else True
  fake=types.SimpleNamespace(build_packet=packet)
  with patch.dict('sys.modules',{'review_packet':fake}):
   with self.assertRaises(AgentGatePending):controller.finish_design(self.concept)
  name,inputs,instructions=captured[0];self.assertEqual(name,'04-final');self.assertEqual(inputs[0].name,'audit.json');self.assertNotIn('manifest.json',[p.name for p in inputs]);self.assertNotIn('agent-summary.md',[p.name for p in inputs]);self.assertIn('agent-summary.md',instructions);self.assertIn('passed:false',instructions)
  self.assertFalse((self.concept/'release/visual-review.json').exists());self.assertFalse((self.root/'gates/04-final/response.json').exists())

 def test_rebuilding_packet_after_supplying_evidence_does_not_stale_gate_but_real_input_changes_do(self):
  from orchestrator import sha
  controller=self.controller();controller.registration='gd-cli';controller.stage=lambda name,fn:fn() if name=='final_review' else True
  out=self.concept/'release';packet_dir=out/'review-packet'
  for relative in ('layer-audit/audit.json','spec.json','bound-assets.json','registered-assets.json'):
   write(out/relative,{'fixture':relative})
  (out/'editor-materials-bound.png').write_bytes(b'unit-test screenshot placeholder; not a visual approval')
  write(self.concept/'release-recipe.json',self.recipe)
  version=[1]
  def packet(_recipe):
   write(packet_dir/'manifest.json',{'version':version[0],'issues':['evidence pending'] if version[0]==1 else []});(packet_dir/'agent-summary.md').write_text('Advisory fixture version '+str(version[0]));return {'directory':str(packet_dir)}
  with patch.dict('sys.modules',{'review_packet':types.SimpleNamespace(build_packet=packet)}):
   with self.assertRaises(AgentGatePending):controller.finish_design(self.concept)
   request=read(self.root/'gates/04-final/request.json');self.assertFalse(any('review-packet' in path for path in request['input_sha256']))
   version[0]=2;packet(self.concept/'release-recipe.json')
   write(self.concept/'copyright-evidence.json',{'categories':{}})
   write(out/'visual-review.json',{'passed':True,'spec_sha256':sha(out/'spec.json'),'checks':['unit fixture only']})
   write(out/'material-review.json',{'passed':True,'bindings_sha256':sha(out/'bound-assets.json'),'evidence_sha256':sha(self.concept/'copyright-evidence.json'),'checks':['unit fixture only']})
   write(self.root/'gates/04-final/response.json',{'passed':True,'token':request['token'],'checks':['unit fixture: refreshed advisory index is not a changed source input']})
   with patch('builtins.print'):controller.finish_design(self.concept)
   self.assertEqual(read(self.root/'gates/04-final/request.json')['token'],request['token'])
   write(out/'spec.json',{'fixture':'real source input changed'})
   with self.assertRaisesRegex(ValueError,'Gate inputs changed'):controller.finish_design(self.concept)

if __name__=='__main__':unittest.main()
