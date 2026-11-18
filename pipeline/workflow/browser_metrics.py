"""Observed browser step measurements, separate from wall-time accounting."""
import json
import math
from pathlib import Path


def report(paths):
    attempts, warnings = [], []
    for filename in dict.fromkeys(map(str, paths)):
        path = Path(filename)
        if not path.exists():
            continue
        pending = {}
        for index, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
            try:
                event = json.loads(line)
                if not isinstance(event, dict):
                    raise ValueError()
                key = (event['attempt_id'], event['sequence'], event['step'])
                if not all(isinstance(value, str) and value for value in key):
                    raise ValueError()
                kind = event['event']
                if kind == 'step_start':
                    row = dict(attempt_id=key[0], sequence=key[1], step=key[2],
                               started_at=event.get('at'), status='incomplete', elapsed_ms=None)
                    attempts.append(row)
                    pending[key] = row
                elif kind in ('step_success', 'step_failure'):
                    duration = event.get('elapsed_ms')
                    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                        raise ValueError()
                    if key not in pending:
                        warnings.append(f'{path.name}:{index}: completion without observed start')
                        continue
                    row = pending.pop(key)
                    row.update(status='complete' if kind == 'step_success' else 'failed',
                               ended_at=event.get('at'), elapsed_ms=duration)
                    if event.get('recovery'):
                        row['recovery'] = event['recovery']
                else:
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                warnings.append(f'{path.name}:{index}: malformed browser event')
    by_step = {}
    for row in attempts:
        stats = by_step.setdefault(row['step'], dict(attempts=0, completed=0, failed=0, incomplete=0, observed_ms=0))
        stats['attempts'] += 1
        stats[{'complete': 'completed', 'failed': 'failed', 'incomplete': 'incomplete'}[row['status']]] += 1
        if row['elapsed_ms'] is not None:
            stats['observed_ms'] += row['elapsed_ms']
    return dict(steps=attempts, by_step=by_step, warnings=warnings,
                note='Observed inclusive browser steps, already contained in machine spans. Do not add these durations to wall-time accounting. Incomplete steps have unknown duration; no inference/network/debugging attribution is inferred.')
