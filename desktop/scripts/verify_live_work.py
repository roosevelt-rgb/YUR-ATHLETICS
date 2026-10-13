"""Opt-in local-model outcome check; never runs in the default test suite."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_provider import create_model_adapter


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--endpoint', default='http://127.0.0.1:11434')
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    record = {'started_at': datetime.now(timezone.utc).isoformat(), 'model': args.model, 'endpoint': args.endpoint,
              'type': 'live-local-model-outcome', 'passed': False, 'events': []}
    with tempfile.TemporaryDirectory(prefix='yur-live-work-') as temporary:
        root = Path(temporary); project = root / 'project'; project.mkdir()
        source = project / 'measures.txt'
        nonce = uuid.uuid4().hex[:10]
        source.write_text(f'Project reference: {nonce}\nMeasured wall length: 37 feet\nMeasured wall height: 9 feet\n', encoding='utf-8')
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        goal = ('Read measures.txt using read_file. Then use create_artifact to create measured-summary.md (text/markdown) '
                'with the actual project reference and the two exact measured dimensions you read. Do not guess the reference. '
                'Do not modify any source file. After the tool reports the artifact committed, give a short final answer.')
        request = {'request_id': str(uuid.uuid4()), 'conversation_id': str(uuid.uuid4()), 'mode': 'work', 'goal': goal,
                   'root': str(project), 'provider': 'ollama', 'model': args.model, 'messages': [{'role': 'user', 'content': goal}]}
        try:
            with CommitService(root / 'journal') as store:
                def progress(event):
                    record['events'].append(event)
                    print(json.dumps(event), flush=True)
                mission = OrchestrationManager(store).run_work(request, create_model_adapter('ollama', args.model, endpoint=args.endpoint), progress)
                record.update(mission_status=mission['status'], steps=mission['steps'], proposed_artifacts=mission['artifacts'], answer=mission['answer'])
                artifacts = [item for item in mission['artifacts'] if item['proposal']['kind'] == 'artifact']
                matches = [item for item in artifacts if all(marker in item['proposal']['content'] for marker in (nonce, '37', '9'))]
                if mission['status'] != 'completed' or not matches or not any(step['tool'] == 'read_file' and step['succeeded'] for step in mission['steps']):
                    raise AssertionError('The live model did not complete an actual source-grounded artifact')
                selected = matches[0]
                validation = store.validate_work_delivery(mission['id'], selected['id'])
                authority = {'issuer': 'local-user', 'scope': 'reviewed-work-artifact', 'actions': ['commit'], 'mission_id': mission['id'], 'artifact_id': selected['id']}
                delivered = store.commit_work_delivery(mission['id'], selected['id'], validation['validation_token'], authority)
                if hashlib.sha256(source.read_bytes()).hexdigest() != source_hash:
                    raise AssertionError('Live work modified its read-only fixture source')
                output = Path(delivered['delivery']['plan']['path']).read_bytes()
                record.update(passed=True, mission_id=mission['id'], tool_steps=[step['tool'] for step in mission['steps']],
                              answer=mission['answer'], artifact_name=selected['proposal']['name'], artifact_content=output.decode(),
                              artifact_sha256=hashlib.sha256(output).hexdigest(), source_sha256=source_hash,
                              integrity=store.verify_integrity(), delivery=delivered['delivery'])
        except Exception as error:
            record['error'] = f'{type(error).__name__}: {error}'
        record['completed_at'] = datetime.now(timezone.utc).isoformat()
        args.receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
        print(json.dumps({'passed': record['passed'], 'receipt': str(args.receipt), 'error': record.get('error')}), flush=True)
        return 0 if record['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
