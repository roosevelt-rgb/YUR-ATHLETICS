"""Opt-in model plus restricted cell outcome proof in a disposable fixture."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_provider import create_model_adapter


def fingerprint():
    files = ['foundry/' + name for name in ('work_engine.py', 'work_cells.py', 'execution_cell.py', 'work_tools.py', 'work_store.py', 'commit_service.py', 'work_provider.py')]
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--endpoint', default='http://127.0.0.1:11434')
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    record = {'schema': 'yur.live-code-proof.v1', 'passed': False, 'model': args.model,
              'endpoint': args.endpoint, 'started_at': datetime.now(timezone.utc).isoformat(),
              'source_before': fingerprint(), 'events': [], 'fixture_model': False}
    with tempfile.TemporaryDirectory(prefix='yur-live-code-') as temporary:
        project = Path(temporary) / 'source'; project.mkdir()
        nonce = uuid.uuid4().hex[:12]
        (project / 'pricing.py').write_bytes(b'def area(length, width):\n    return length + width\n')
        (project / 'test_pricing.py').write_bytes((
            'import unittest\nfrom pricing import area\n\nclass AreaTests(unittest.TestCase):\n'
            f'    def test_{nonce}(self):\n        self.assertEqual(area(37, 9), 333)\n'
            '    def test_zero(self):\n        self.assertEqual(area(0, 9), 0)\n').encode())
        initial = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in project.iterdir()}
        goal = ('In this selected fixture folder, read pricing.py and test_pricing.py using read_file. '
                'Run run_python_checks with files ["pricing.py","test_pricing.py"], profile "python-unittest-serial", '
                'test_directory ".", and proposal_ids [] to record the actual baseline failure. '
                'Then propose_edit on pricing.py to fix the area function, using the current SHA256 returned by read_file. '
                'Run run_python_checks again with both files and the same profile, this time including the actual artifact_id '
                'of your committed edit proposal in proposal_ids. Do not apply the edit or modify the test. '
                'Finish only after the real staged check result. Report the actual before/after exit codes.')
        request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'code', 'goal': goal,
                   'root': str(project), 'provider': 'ollama', 'model': args.model, 'messages': [{'role': 'user', 'content': goal}]}
        try:
            with CommitService(Path(temporary) / 'journal') as store:
                def progress(event):
                    record['events'].append(event)
                    print(json.dumps(event), flush=True)
                mission = OrchestrationManager(store).run_work(request, create_model_adapter('ollama', args.model, endpoint=args.endpoint), progress)
                record.update(mission_id=mission['id'], status=mission['status'], steps=mission['steps'], artifacts=mission['artifacts'], answer=mission['answer'])
                checks = [step['result'] for step in mission['steps'] if step['tool'] == 'run_python_checks' and step['succeeded']]
                baseline = next((item for item in checks if item['execution']['status'] == 'failed' and item['execution']['exit_code'] != 0 and not any(source['overlay'] for source in item['snapshot']['sources'])), None)
                staged = next((item for item in checks if item['execution']['status'] == 'completed' and item['execution']['exit_code'] == 0 and any(source['path'] == 'pricing.py' and source['overlay'] for source in item['snapshot']['sources'])), None)
                final = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in project.iterdir()}
                assert mission['status'] == 'completed' and baseline and staged, 'Actual baseline failure and staged success were not both observed'
                assert baseline['snapshot']['id'] != staged['snapshot']['id'], 'Snapshots did not change'
                assert all(source['original_sha256'] == initial[source['path']] for source in staged['snapshot']['sources'])
                assert all(not source['overlay'] for source in staged['snapshot']['sources'] if source['path'] == 'test_pricing.py'), 'Model changed the test'
                assert initial == final, 'Source fixture changed before Apply'
                assert record['source_before'] == fingerprint(), 'Implementation changed during proof'
                record.update(passed=True, baseline=baseline, staged=staged, fixture_source_sha256=final, source_after=fingerprint(), integrity=store.verify_integrity())
        except Exception as error:
            record['error'] = f'{type(error).__name__}: {error}'
            record['source_after'] = fingerprint()
        record['completed_at'] = datetime.now(timezone.utc).isoformat()
        args.receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
        print(json.dumps({'passed': record['passed'], 'receipt': str(args.receipt), 'error': record.get('error')}), flush=True)
        return 0 if record['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
