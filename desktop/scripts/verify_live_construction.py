"""Opt-in real-model specialist creation and later reuse on fresh quoted rows."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager
from foundry.work_provider import create_model_adapter, normalize_endpoint


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fingerprint():
    paths = [*sorted((ROOT / 'foundry').glob('*.py')), Path(__file__).resolve()]
    return {path.relative_to(ROOT).as_posix(): digest(path.read_bytes()) for path in paths}


def check_output(result, text, quantity, stated, calculated, difference):
    assert result['capability_id'] == 'construction.opc.inspect'
    output = result['output']
    assert output['source']['sha256'] == digest(text.encode())
    assert len(output['line_items']) == 1
    item = output['line_items'][0]
    assert item['quantity'] == quantity and item['unit_price'] == '19.95'
    assert item['stated_total'] == stated and item['calculated_total'] == calculated
    assert item['difference'] == difference
    assert item['arithmetic'] == ('consistent' if difference == '0.00' else 'mismatch')
    assert output['requires_review'] == (difference != '0.00')
    for source in item['sources'].values():
        assert text[source['start']:source['end']] == source['text']
    assert len(result['runtime_sha256']) == 64


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True, choices=['qwen3.5:9b'])
    parser.add_argument('--endpoint', default='http://127.0.0.1:11434')
    parser.add_argument('--receipt', required=True, type=Path)
    args = parser.parse_args()
    endpoint = normalize_endpoint(args.endpoint)
    assert ipaddress.ip_address(urlsplit(endpoint).hostname).is_loopback, 'Proof requires a literal loopback endpoint'
    assert args.receipt.is_absolute() and args.receipt.parent.is_dir(), 'Choose an existing absolute proof directory'
    assert not args.receipt.exists(), 'Use a new receipt path; existing proof is never overwritten'
    record = {'schema': 'yur.live-construction-proof.v1', 'passed': False, 'fixture_model': False,
              'model': args.model, 'endpoint': endpoint, 'source_before': fingerprint(),
              'started_at': datetime.now(timezone.utc).isoformat(), 'missions': [], 'events': [], 'model_calls': []}
    try:
        with tempfile.TemporaryDirectory(prefix='yur-live-construction-') as temporary:
            project = Path(temporary) / 'project'; project.mkdir()
            nonce = uuid.uuid4().hex[:10]
            name = f'Quoted cost specialist {nonce}'
            first_text = f'1.7 | FORM {nonce} | 3 | EA | $19.95 | $60.00'
            second_text = f'1.8 | FORM {nonce} | 4 | EA | $19.95 | $79.80'
            source = project / 'opc.txt'
            source.write_bytes(first_text.encode())
            conversation = str(uuid.uuid4())
            with CommitService(Path(temporary) / 'journal') as store:
                manager = OrchestrationManager(store)
                real_adapter = create_model_adapter('ollama', args.model, endpoint=endpoint)

                def run(goal):
                    request = {'request_id': str(uuid.uuid4()), 'conversation_id': conversation,
                               'mode': 'work', 'goal': goal, 'root': str(project), 'provider': 'ollama',
                               'model': args.model, 'messages': [{'role': 'user', 'content': goal}]}
                    def progress(event):
                        record['events'].append(event)
                        print(json.dumps(event), flush=True)
                    def adapter(messages, tools):
                        started = time.monotonic()
                        call = {'request_id': request['request_id']}
                        try:
                            output = real_adapter(messages, tools)
                            call.update(succeeded=True, content_chars=len(output['content']),
                                        tool_names=[item['function']['name'] for item in output['tool_calls']])
                            return output
                        except Exception as error:
                            call.update(succeeded=False, error=f'{type(error).__name__}: {error}')
                            if hasattr(error, 'diagnostics'):
                                call['diagnostics'] = error.diagnostics
                            raise
                        finally:
                            call['duration_ms'] = round((time.monotonic() - started) * 1000)
                            record['model_calls'].append(call)
                    try:
                        mission = manager.run_work(request, adapter, progress)
                    except Exception:
                        # Retain actual failed Work before the temporary journal
                        # closes; successful tool receipts still describe work done.
                        retained = store.get_work_by_request(request['request_id'])
                        if retained:
                            record['missions'].append(retained)
                        raise
                    record['missions'].append(mission)
                    assert mission['status'] == 'completed', 'The model did not finish Work'
                    return mission

                first = run(f'Read opc.txt using read_file. Build a specialist named "{name}" with '
                            'capabilities ["construction.opc.inspect"]. Use run_built_specialist with the '
                            'actual returned mission_id, capability_id "construction.opc.inspect" and input '
                            '{"text": the exact complete file content you read}. Do not change or summarize '
                            'the input. Report the actual arithmetic result and source evidence. Do not '
                            'export, apply changes, or claim a quote is approved.')
                builds = [step['result'] for step in first['steps'] if step['tool'] == 'build_specialist' and step['succeeded']]
                runs = [step['result'] for step in first['steps'] if step['tool'] == 'run_built_specialist' and step['succeeded']]
                assert len(builds) == 1 and len(runs) == 1, 'Expected one actual build and one run'
                assert any(step['tool'] == 'read_file' and step['succeeded'] and step['arguments']['path'] == 'opc.txt' for step in first['steps'])
                check_output(runs[0], first_text, '3', '60.00', '59.85', '0.15')
                child_id = builds[0]['mission_id']
                assert runs[0]['mission_id'] == child_id
                original_artifact = store.get_artifact(child_id)
                assert source.read_bytes() == first_text.encode()
                assert len(store.list_missions()) == 1

                # The operator fixture supplies fresh source for a separate mission.
                source.write_bytes(second_text.encode())
                second = run(f'Read the fresh opc.txt. Use list_built_specialists to find the previously '
                             f'committed specialist named "{name}". Reuse it with run_saved_specialist, '
                             'capability_id "construction.opc.inspect", and input {"text": the exact '
                             'complete file content}. Do not build another specialist, export, or edit files. '
                             'Finish with the actual arithmetic and mention that this reused the saved specialist.')
                reused = [step['result'] for step in second['steps'] if step['tool'] == 'run_saved_specialist' and step['succeeded']]
                assert len(reused) == 1
                assert any(step['tool'] == 'read_file' and step['succeeded'] and step['arguments']['path'] == 'opc.txt' for step in second['steps'])
                assert any(step['tool'] == 'list_built_specialists' and step['succeeded'] for step in second['steps'])
                check_output(reused[0], second_text, '4', '79.80', '79.80', '0.00')
                assert reused[0]['mission_id'] == child_id
                assert reused[0]['selection']['source_parent_work_id'] == first['id']
                assert reused[0]['run_id'] != runs[0]['run_id']
                assert reused[0]['runtime_sha256'] == runs[0]['runtime_sha256']
                assert store.get_artifact(child_id) == original_artifact
                assert len(store.list_missions()) == 1
                assert source.read_bytes() == second_text.encode()
                assert all(not mission['artifacts'] for mission in (first, second))
                events = store.events(child_id)
                assert len([event for event in events if event['event_type'] == 'execution.completed']) == 2
                assert not any(event['event_type'] == 'artifact.exported' for event in events)
                integrity = store.verify_integrity()
                assert integrity['passed']
                final_fingerprints = fingerprint()
                assert record['source_before'] == final_fingerprints, 'Source changed during validation'
                record.update(passed=True, child_id=child_id, artifact_digest=original_artifact['digest'],
                              runtime_sha256=runs[0]['runtime_sha256'], source_after=final_fingerprints,
                              actual_outputs=[runs[0]['output'], reused[0]['output']], integrity=integrity,
                              scope='Local quoted-row arithmetic, actual model tool use and saved-package reuse; no market certification')
    except Exception as error:
        record.update(error=f'{type(error).__name__}: {error}', source_after=fingerprint())
    record['completed_at'] = datetime.now(timezone.utc).isoformat()
    with args.receipt.open('x', encoding='utf-8') as output:
        json.dump(record, output, indent=2, ensure_ascii=False, allow_nan=False)
    print(json.dumps({'passed': record['passed'], 'receipt': str(args.receipt), 'error': record.get('error')}), flush=True)
    return 0 if record['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
