"""Validate separately, then journal and commit one explicitly reviewed delivery.

Model tools cannot call these functions. The desktop's operator ingress invokes
them through CommitService. A prepared receipt allows interrupted deliveries to
be reconciled from actual destination bytes without replaying a completed write.
"""
from __future__ import annotations

import copy
import hashlib
import os
from pathlib import Path
import tempfile

from .sources import read_checked, reject_reparse
from .work_store import digest, now
from .work_tools import execute_tool, _relative, _root
from .work_documents import artifact_bytes, artifact_name, ENCODING, MAX_ARTIFACT_BYTES


def _payload(proposal):
    if proposal.get('encoding') == ENCODING and proposal.get('kind') == 'artifact':
        return artifact_bytes(proposal)
    if 'encoding' in proposal:
        raise ValueError('Unsupported artifact encoding')
    return proposal['content'].encode('utf-8')


def _selected(store, mission_id, artifact_id):
    mission = store.get_work(mission_id)
    if mission['status'] not in {'completed', 'failed', 'cancelled'}:
        raise ValueError('Stop or finish the mission before delivering its artifacts')
    artifact = next((item for item in mission['artifacts'] if item['id'] == artifact_id), None)
    if artifact is None:
        raise ValueError('Work artifact not found')
    return mission, artifact


def _plan(store, mission, artifact):
    proposal = artifact['proposal']
    if proposal['kind'] == 'edit':
        root = _root(mission['request']['root'])
        relative = _relative(proposal['path'])
        before = proposal['expected_sha256']
        expected = proposal['new_sha256']
    else:
        root = store.root / 'work-artifacts' / mission['id']
        relative = (artifact_name(proposal['name'], Path(proposal['name']).suffix[1:])
                    if proposal.get('encoding') == ENCODING else _relative(proposal['name']))
        before, expected = None, proposal['sha256']
    reject_reparse(root)
    target = root / relative
    reject_reparse(target)
    content = _payload(proposal)
    if hashlib.sha256(content).hexdigest() != expected:
        raise ValueError('Artifact content hash is inconsistent')
    return {'root': str(root), 'relative': relative, 'path': str(target),
            'before_sha256': before, 'after_sha256': expected, 'bytes': len(content),
            'kind': proposal['kind']}


def _current(plan):
    target = Path(plan['path'])
    reject_reparse(target)
    if not target.exists():
        return None
    raw = read_checked(Path(plan['root']), plan['relative'], min(MAX_ARTIFACT_BYTES, max(64 * 1024, plan['bytes'])))
    return hashlib.sha256(raw).hexdigest()


def validate_delivery(store, mission_id, artifact_id):
    mission, artifact = _selected(store, mission_id, artifact_id)
    plan = _plan(store, mission, artifact)
    current = _current(plan)
    delivery = artifact.get('delivery')
    if delivery and delivery.get('plan') != plan:
        raise ValueError('Recorded delivery no longer matches this artifact')
    recovery = bool(delivery and current == plan['after_sha256'])
    if not recovery:
        if current != plan['before_sha256']:
            raise ValueError('Destination changed since the proposal; review a fresh proposal')
        if plan['kind'] == 'edit':
            proposal = artifact['proposal']
            checked = execute_tool('propose_edit', {key: proposal[key] for key in ('path', 'content', 'expected_sha256')}, mission['request']['root'])
            if checked['proposal'] != proposal:
                raise ValueError('Independent edit validation differs from the committed proposal')
            if not Path(plan['path']).parent.is_dir():
                raise ValueError('The destination parent folder must already exist')
        else:
            proposal = artifact['proposal']
            if proposal.get('encoding') == ENCODING:
                artifact_bytes(proposal)  # Full recipe/metadata/byte regeneration.
            else:
                checked = execute_tool('create_artifact', {key: proposal[key] for key in ('name', 'media_type', 'content')})
                if checked['proposal'] != proposal:
                    raise ValueError('Independent artifact validation failed')
    result = {'mission_id': mission_id, 'artifact_id': artifact_id, 'revision': mission['revision'],
              'plan': plan, 'recovery': recovery, 'already_applied': bool(delivery and delivery.get('status') == 'applied' and recovery)}
    result['validation_token'] = digest(result)
    return result


def _record(store, mission, artifact_id, delivery, event_type, authority):
    document = {key: copy.deepcopy(value) for key, value in mission.items() if key not in {'revision', 'receipt'}}
    selected = next(item for item in document['artifacts'] if item['id'] == artifact_id)
    selected['delivery'] = delivery
    document['updated_at'] = now()
    return store.commit_work(document, mission['revision'], event_type, {'artifact_id': artifact_id, 'authority': authority, 'delivery': delivery})


def commit_delivery(store, mission_id, artifact_id, validation_token, authority):
    expected_authority = {'issuer': 'local-user', 'scope': 'reviewed-work-artifact', 'actions': ['commit'],
                          'mission_id': mission_id, 'artifact_id': artifact_id}
    if authority != expected_authority:
        raise ValueError('Delivery requires explicit operator approval for this exact artifact')
    with store.acquire_worker():
        validation = validate_delivery(store, mission_id, artifact_id)
        if validation['validation_token'] != validation_token:
            raise ValueError('Review is stale; reload the artifact and validate again')
        mission, artifact = _selected(store, mission_id, artifact_id)
        if validation['already_applied']:
            return {'mission': mission, 'delivery': artifact['delivery'], 'replayed': True}
        plan = validation['plan']
        delivery = {'status': 'prepared', 'plan': plan, 'prepared_at': now(), 'validation_token': validation_token}
        mission = _record(store, mission, artifact_id, delivery, 'work.artifact.prepared', authority)
        temporary = None
        try:
            if not validation['recovery']:
                target = Path(plan['path'])
                if plan['kind'] == 'artifact':
                    # Directory creation and destination write are both owned by
                    # this CommitService operation, after its prepared receipt.
                    reject_reparse(target.parent)
                    target.parent.mkdir(parents=True, exist_ok=True)
                reject_reparse(target)
                content = _payload(artifact['proposal'])
                with tempfile.NamedTemporaryFile(prefix='.yur-delivery-', suffix='.tmp', dir=target.parent, delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(content); stream.flush(); os.fsync(stream.fileno())
                if _current(plan) != plan['before_sha256']:
                    raise ValueError('Destination changed during delivery; no replacement was made')
                reject_reparse(target.parent)
                if plan['before_sha256'] is None:
                    os.link(temporary, target)  # create only, never overwrite
                else:
                    os.replace(temporary, target)
                    temporary = None
            if _current(plan) != plan['after_sha256']:
                raise ValueError('Destination bytes do not match the committed artifact')
            delivery = {**delivery, 'status': 'applied', 'applied_at': now(), 'verified_sha256': plan['after_sha256']}
            mission = _record(store, mission, artifact_id, delivery, 'work.artifact.applied', authority)
            return {'mission': mission, 'delivery': delivery, 'replayed': False}
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
