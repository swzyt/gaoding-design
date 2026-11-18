"""Timing attribution tests use synthetic clocks/events and temporary workflow state."""
import json,math,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from orchestrator import Controller,AgentGatePending,read,write
from timing import build_report


def event(at,kind,**fields):return dict(at=at,event=kind,**fields)


class TimingPartitionTests(unittest.TestCase):
 def state(self,end=100):return {'started_at':0,'status':'complete','elapsed_seconds':end,'stages':{}}
 def partition(self,events,end=100,state=None):
  result=build_report(state or self.state(end),events,now=end)
  account=result['accounting'];self.assertAlmostEqual(sum(account[key] for key in ('gate_wait_seconds','observed_machine_seconds','unknown_in_stage_seconds','unattributed_gap_seconds')),result['wall_seconds'])
  self.assertTrue(all(value>=0 and math.isfinite(value) for value in account.values()))
  return result
 def test_nested_browser_and_command_spans_are_not_double_counted(self):
  events=[event(10,'stage_start',stage='prepare',attempt_id='a'),event(20,'span_start',span_id='browser',category='browser',name='prepare'),event(22,'span_start',span_id='command',parent_id='browser',category='command',name='browser'),event(28,'span_end',span_id='command'),event(30,'span_end',span_id='browser'),event(40,'gate_wait_start',wait_id='gate',name='review'),event(60,'gate_wait_end',wait_id='gate'),event(90,'stage_done',stage='prepare',attempt_id='a')]
  report=self.partition(events);account=report['accounting']
  self.assertEqual(account['observed_machine_seconds'],10);self.assertEqual(account['gate_wait_seconds'],20);self.assertEqual(account['unknown_in_stage_seconds'],50);self.assertEqual(account['unattributed_gap_seconds'],20)
  self.assertEqual(report['stages']['prepare'],80);self.assertTrue(report['stage_attempts'][0]['inclusive'])
 def test_parallel_spans_and_gate_overlap_use_disjoint_union(self):
  events=[event(0,'stage_start',stage='parallel',attempt_id='a'),event(20,'span_start',span_id='one',category='command'),event(30,'span_start',span_id='two',category='command'),event(45,'gate_wait_start',wait_id='review'),event(50,'span_end',span_id='one'),event(55,'gate_wait_end',wait_id='review'),event(60,'span_end',span_id='two'),event(80,'stage_done',stage='parallel',attempt_id='a')]
  report=self.partition(events);self.assertEqual(report['accounting']['observed_machine_seconds'],30);self.assertEqual(report['accounting']['gate_wait_seconds'],10)
 def test_legacy_stage_events_are_unknown_not_machine_or_agent_inference(self):
  report=self.partition([event(10,'stage_start',stage='old'),event(15,'job_done',job='old-job',taskId='existing'),event(80,'stage_done',stage='old')])
  self.assertEqual(report['accounting']['observed_machine_seconds'],0);self.assertEqual(report['accounting']['unknown_in_stage_seconds'],70)
  self.assertEqual(report['stage_attempts'][0]['instrumentation'],'legacy-unknown');self.assertEqual(report['jobs'][0]['taskId'],'existing')
  self.assertIn('not Agent reasoning',report['definitions']['gate_wait']);self.assertIn('suspension',report['note'])
 def test_retries_accumulate_and_failure_gap_is_not_called_debugging(self):
  events=[event(10,'stage_start',stage='build',attempt_id='one'),event(20,'stage_error',stage='build',attempt_id='one'),event(40,'controller_resume'),event(40,'stage_start',stage='build',attempt_id='two'),event(50,'stage_done',stage='build',attempt_id='two')]
  report=self.partition(events,end=70);self.assertEqual(report['stages']['build'],20);self.assertEqual(len(report['stage_attempts']),2)
  gaps=report['unattributed_intervals'];self.assertEqual(next(row for row in gaps if row['start']==20)['reason'],'after_failure_unattributed');self.assertEqual(next(row for row in gaps if row['start']==50)['reason'],'between_stages_or_unobserved')
  self.assertTrue(all(row['attribution']=='unknown' for row in gaps))
 def test_crashed_open_span_does_not_turn_suspension_into_machine_work(self):
  events=[event(0,'stage_start',stage='build',attempt_id='one'),event(2,'span_start',span_id='crashed',category='command'),event(10,'observed-heartbeat'),event(50,'controller_resume'),event(50,'stage_start',stage='build',attempt_id='two'),event(51,'span_start',span_id='new',category='command'),event(55,'span_end',span_id='new'),event(60,'stage_done',stage='build',attempt_id='two')]
  report=self.partition(events,end=70);self.assertEqual(report['accounting']['observed_machine_seconds'],12)
  self.assertEqual(report['stage_attempts'][0]['result'],'interrupted');self.assertEqual(report['stage_attempts'][0]['seconds'],10)
 def test_saved_attempt_without_event_append_survives(self):
  state=self.state();state['stage_attempts']=[{'attempt_id':'saved','stage':'render','started_at':10,'ended_at':25,'result':'stage_done'}]
  report=self.partition([],state=state);self.assertEqual(report['stages']['render'],15);self.assertEqual(report['accounting']['observed_machine_seconds'],0)
 def test_pending_gate_remains_explicit_handoff_wait_across_pause(self):
  state={'started_at':0,'status':'waiting_agent','stages':{},'gate_waits':{'one':{'name':'qa','started_at':10,'status':'pending'}}}
  report=self.partition([event(10,'gate_wait_start',wait_id='one'),event(11,'controller_stop')],end=100,state=state)
  self.assertEqual(report['accounting']['gate_wait_seconds'],90);self.assertTrue(report['gate_waits'][0]['pending'])
 def test_response_observation_mtime_ends_wait_before_controller_resumes(self):
  events=[event(10,'gate_wait_start',wait_id='one'),event(80,'gate_wait_resume',wait_id='one',started_at=10),event(80,'gate_wait_end',wait_id='one',started_at=10,ended_at=35,end_basis='response-file-mtime-observed')]
  report=self.partition(events);self.assertEqual(report['accounting']['gate_wait_seconds'],25);self.assertEqual(report['gate_waits'][0]['end_basis'],'response-file-mtime-observed')
 def test_automated_gate_savings_are_counted_per_unique_frozen_handoff(self):
  events=[event(1,'empty_asset_handoff_automated',handoff_id='same'),event(2,'empty_asset_handoff_automated',handoff_id='same'),event(3,'gate_request',requires_agent=True),event(4,'gate_request',requires_agent=False)]
  report=self.partition(events);self.assertEqual(report['handoffs']['unique_empty_asset_gates_avoided'],1);self.assertEqual(report['handoffs']['observed_gate_calls'],2);self.assertEqual(report['handoffs']['observed_gate_calls_requiring_agent'],1)


class ControllerTimingTests(unittest.TestCase):
 def test_stage_attempts_remain_durable_across_failed_retry_and_resume(self):
  with tempfile.TemporaryDirectory() as directory:
   controller=Controller(directory,7,None,False,1,'tour')
   with self.assertRaisesRegex(RuntimeError,'failed'):
    controller.stage('render',lambda:(_ for _ in ()).throw(RuntimeError('failed')))
   resumed=Controller(directory,7,None,False,1,'tour');resumed.stage('render',lambda:resumed.local('fixture-render',lambda:'ok'));resumed.report()
   state=read(Path(directory)/'run.json');self.assertEqual([row['result'] for row in state['stage_attempts']],['stage_error','stage_done'])
   self.assertEqual(len({row['attempt_id'] for row in state['stage_attempts']}),2)
   report=read(Path(directory)/'timing-report.json');self.assertEqual(len(report['stage_attempts']),2);self.assertEqual(len(report['machine_spans']),1)
   resumed.stage('render',lambda:self.fail('completed stage must not repeat'));self.assertEqual(len(resumed.state['stage_attempts']),2)
 def test_gate_pause_resume_preserves_wait_and_does_not_count_post_response_gap_as_wait(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);source=root/'input.json';write(source,{'input':'frozen'})
   with patch('orchestrator.time.time',return_value=100):
    controller=Controller(root,7,None,False,1,'tour')
    with self.assertRaises(AgentGatePending):controller.stage('review',lambda:controller.gate('qa',[source],'Inspect real evidence'))
   request=read(root/'gates/qa/request.json');write(root/'gates/qa/response.json',{'passed':True,'token':request['token'],'checks':['observed fixture']});os.utime(root/'gates/qa/response.json',(130,130))
   with patch('orchestrator.time.time',return_value=200):
    resumed=Controller(root,7,None,False,1,'tour');resumed.stage('review',lambda:resumed.gate('qa',[source],'Inspect real evidence'))
   events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
   report=build_report(resumed.state,events,now=210);self.assertEqual(report['accounting']['gate_wait_seconds'],30)
   self.assertEqual(report['handoffs']['observed_gate_calls_requiring_agent'],1);self.assertEqual(len(resumed.state['gate_waits']),1);self.assertEqual(resumed.state['stage_attempts'][0]['result'],'stage_pause')
 def test_browser_and_command_instrumentation_remains_nested_without_real_processes(self):
  with tempfile.TemporaryDirectory() as directory:
   with patch('orchestrator.DATA',Path(directory)):
    controller=Controller(directory,7,None,False,1,'tour')
    with patch('orchestrator.subprocess.run') as invoke:controller.stage('editor',lambda:controller.browser('prepare',Path(directory)/'recipe.json'))
    self.assertEqual(invoke.call_count,1);controller.report();report=read(Path(directory)/'timing-report.json')
    spans=report['machine_spans'];browser=next(row for row in spans if row['category']=='browser');command=next(row for row in spans if row['category']=='command')
    self.assertEqual(command['parent_id'],browser['span_id']);self.assertLessEqual(report['accounting']['observed_machine_seconds'],sum(row['seconds'] for row in spans))
 def test_truncated_old_event_line_is_diagnostic_not_a_fabricated_measurement(self):
  with tempfile.TemporaryDirectory() as directory:
   controller=Controller(directory,7,None,False,1,'tour')
   with (Path(directory)/'events.jsonl').open('a') as stream:stream.write('{truncated\n')
   controller.report();report=read(Path(directory)/'timing-report.json');self.assertIn('malformed',report['warnings'][0]);self.assertEqual(report['accounting']['observed_machine_seconds'],0)

if __name__=='__main__':unittest.main()
