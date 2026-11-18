"""Conservative wall-time accounting over durable workflow events.

Stage attempts and child spans are inclusive views. Only the disjoint accounting
partition may be added: explicit gate waits, observed machine spans, remaining
stage time, and unobserved gaps. Legacy stage time is never assumed to be machine
work; gaps and gate waits are not estimates of Agent reasoning or debugging.
"""
import math
import time

NOTE = ('Actual wall time since the original run start, including Agent review, repairs, '
        'debugging and any suspension; not a controlled full-workflow A/B test or a '
        'stable production speed estimate.')


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def clipped(start, end, lower, upper):
    if not number(start) or not number(end):
        return None
    start, end = max(start, lower), min(end, upper)
    return (start, end) if end > start else None


def build_report(state, events, now=None):
    now = time.time() if now is None else now
    events = [row for row in events if isinstance(row, dict) and number(row.get('at'))]
    start = state.get('started_at')
    if not number(start):
        start = min((row['at'] for row in events), default=now)
    elapsed = state.get('elapsed_seconds')
    end = start + elapsed if state.get('status') == 'complete' and number(elapsed) and elapsed >= 0 else max(start, now)
    wall = end - start
    last_observed = min(end, max((row['at'] for row in events), default=start))
    attempts, open_stages, spans, waits = {}, {}, {}, {}
    warnings = []
    legacy = 0
    previous_at = start
    for event in events:
        kind, at = event.get('event'), event['at']
        if kind == 'controller_resume':
            for row in attempts.values():
                if row.get('ended_at') is None:
                    row.update(result='interrupted', ended_at=row.get('last_observed_at', row['started_at']))
            open_stages.clear()
            for row in spans.values():
                if 'ended_at' not in row:
                    row.setdefault('interrupted_at', previous_at)
        if kind == 'stage_start':
            stage = event.get('stage', 'unknown')
            key = event.get('attempt_id')
            if not key:
                legacy += 1
                key = 'legacy-' + str(legacy)
            previous = open_stages.get(stage)
            if previous and attempts[previous].get('ended_at') is None:
                # A restart is not evidence that the preceding stage ran throughout the gap.
                attempts[previous].update(result='interrupted', ended_at=attempts[previous]['last_observed_at'])
            attempts[key] = dict(attempt_id=key, stage=stage, started_at=at, ended_at=None,
                                 last_observed_at=at, result='incomplete',
                                 instrumentation='observed' if event.get('attempt_id') else 'legacy-unknown')
            open_stages[stage] = key
        elif kind in ('stage_done', 'stage_error', 'stage_pause'):
            key = event.get('attempt_id') or open_stages.get(event.get('stage'))
            if key in attempts:
                attempts[key].update(ended_at=at, last_observed_at=at, result=kind)
                if open_stages.get(event.get('stage')) == key:
                    open_stages.pop(event.get('stage'), None)
        elif kind in ('span_start', 'span_end') and event.get('span_id'):
            key = event['span_id']
            row = spans.setdefault(key, {'span_id': key})
            if kind == 'span_start':
                row.update(started_at=at, category=event.get('category', 'unknown'), name=event.get('name'),
                           stage=event.get('stage'), attempt_id=event.get('attempt_id'), parent_id=event.get('parent_id'))
            else:
                row.update(ended_at=at, outcome=event.get('outcome'))
        elif kind in ('gate_wait_start', 'gate_wait_resume', 'gate_wait_end') and event.get('wait_id'):
            key = event['wait_id']
            row = waits.setdefault(key, {'wait_id': key, 'name': event.get('name')})
            began = event.get('started_at', at)
            if number(began):
                row['started_at'] = min(row.get('started_at', began), began)
            if kind == 'gate_wait_end':
                row['ended_at'] = event.get('ended_at', at)
                row['end_basis'] = event.get('end_basis', 'observed-event')
        if kind not in ('controller_resume', 'controller_start'):
            for key in open_stages.values():
                attempts[key]['last_observed_at'] = max(attempts[key]['last_observed_at'], at)
        previous_at = at

    # Saved attempts survive a crash between state persistence and event append.
    for saved in state.get('stage_attempts', []):
        if not isinstance(saved, dict) or not saved.get('attempt_id') or not number(saved.get('started_at')):
            continue
        key = saved['attempt_id']
        row = attempts.setdefault(key, dict(saved, instrumentation='observed', result=saved.get('result', 'incomplete')))
        if row.get('ended_at') is None and number(saved.get('ended_at')):
            row.update(ended_at=saved['ended_at'], result=saved.get('result', row['result']))
    # An explicitly pending handoff remains a wait while the controller is paused.
    # This does not assert what the Agent or user did during that wall interval.
    for key, saved in state.get('gate_waits', {}).items():
        if not isinstance(saved, dict) or not number(saved.get('started_at')):
            continue
        row = waits.setdefault(key, dict(wait_id=key, name=saved.get('name')))
        row.setdefault('started_at', saved['started_at'])
        if number(saved.get('ended_at')):
            row['ended_at'] = saved['ended_at']
            row['end_basis'] = saved.get('end_basis', 'response-file-mtime-observed')

    stage_intervals, machine_intervals, gate_intervals = [], [], []
    stage_rows, stage_totals = [], {}
    for row in attempts.values():
        began = row.get('started_at')
        finished = row.get('ended_at')
        observed_end = finished if number(finished) else row.get('last_observed_at', began)
        interval = clipped(began, observed_end, start, end)
        seconds = interval[1] - interval[0] if interval else 0
        view = {key: value for key, value in row.items() if key != 'last_observed_at'}
        view.update(seconds=seconds, inclusive=True, end_observed=number(finished))
        stage_rows.append(view)
        stage_totals[row.get('stage', 'unknown')] = stage_totals.get(row.get('stage', 'unknown'), 0) + seconds
        if interval:
            stage_intervals.append(interval)
    for row in spans.values():
        finished = row.get('ended_at', row.get('interrupted_at', last_observed))
        interval = clipped(row.get('started_at'), finished, start, end)
        row['seconds'] = interval[1] - interval[0] if interval else 0
        row['inclusive'] = True
        row['end_observed'] = 'ended_at' in row
        if interval and row.get('category') in ('command', 'browser', 'local', 'provider'):
            machine_intervals.append(interval)
    for row in waits.values():
        interval = clipped(row.get('started_at'), row.get('ended_at', end), start, end)
        row['seconds'] = interval[1] - interval[0] if interval else 0
        row['pending'] = 'ended_at' not in row
        if interval:
            gate_intervals.append(interval)

    boundaries = sorted({start, end, *[v for pair in stage_intervals + machine_intervals + gate_intervals for v in pair]})
    partition = dict(gate_wait_seconds=0, observed_machine_seconds=0,
                     unknown_in_stage_seconds=0, unattributed_gap_seconds=0)
    gaps = []
    terminations = sorted((row['ended_at'], row.get('result')) for row in stage_rows if number(row.get('ended_at')))
    covers = lambda intervals, point: any(a <= point < b for a, b in intervals)
    for a, b in zip(boundaries, boundaries[1:]):
        mid = (a + b) / 2
        if covers(gate_intervals, mid):
            category = 'gate_wait_seconds'
        elif covers(machine_intervals, mid):
            category = 'observed_machine_seconds'
        elif covers(stage_intervals, mid):
            category = 'unknown_in_stage_seconds'
        else:
            category = 'unattributed_gap_seconds'
            previous = [result for at, result in terminations if at <= a]
            reason = 'after_failure_unattributed' if previous and previous[-1] == 'stage_error' else 'between_stages_or_unobserved'
            if gaps and gaps[-1]['end'] == a and gaps[-1]['reason'] == reason:
                gaps[-1].update(end=b, seconds=b - gaps[-1]['start'])
            else:
                gaps.append(dict(start=a, end=b, seconds=b-a, reason=reason, attribution='unknown'))
        partition[category] += b - a
    partition['accounted_wall_seconds'] = sum(partition.values())
    automated = {event.get('handoff_id') for event in events if event.get('event') == 'empty_asset_handoff_automated' and event.get('handoff_id')}
    requests = [event for event in events if event.get('event') == 'gate_request']
    return dict(timing_schema_version=2, stage_attempts=stage_rows, wall_seconds=wall,
                includes_agent_wait=True, stages=stage_totals,
                accounting=partition, machine_spans=list(spans.values()), gate_waits=list(waits.values()),
                unattributed_intervals=gaps,
                handoffs=dict(observed_gate_calls=len(requests), observed_gate_calls_requiring_agent=sum(event.get('requires_agent') is True for event in requests),
                              unique_empty_asset_gates_avoided=len(automated),
                              baseline='One 02-assets handoff per native concept before the empty-plan optimization; only explicitly recorded eligible handoffs count as avoided.'),
                jobs=[event for event in events if event.get('event') == 'job_done'],
                cache=state.get('stages', {}).get('research_collect', {}).get('result'),
                warnings=warnings, note=NOTE,
                definitions=dict(stage_attempts='Inclusive views across every recorded attempt; do not add to accounting or child spans.',
                                 accounting='Disjoint interval union: gate waits take precedence over machine spans, followed by unknown stage time and unobserved gaps. Nested and parallel spans are not added twice.',
                                 gate_wait='Observed handoff wall time until response-file observation, including possible tool work, review, user delay or suspension; not Agent reasoning/inference time.',
                                 unknown='Legacy stage work and unobserved gaps remain unknown; a gap after failure is not automatically debugging time.'))
