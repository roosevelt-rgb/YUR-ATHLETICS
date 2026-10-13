"""Route committed generated evidence to its exact immutable interpretation.

This read-only adapter owns neither admission nor persistence. New bindings
select from the complete committed authority envelope. Retained versions must
match their pinned reader; exceptions never trigger fallback or an upgrade.
"""
from . import generated_evidence_v1 as v1
from . import generated_evidence_v2 as v2

_READERS = {v1.VERIFIER: v1, v2.VERIFIER: v2}


def _reader(store, work_id, verifier=None):
    authority = store.get_work(work_id)['authority']
    matches = [reader for reader in _READERS.values()
               if v1._canonical(authority) == v1._canonical(reader._AUTHORITY)]
    if len(matches) != 1:
        raise ValueError('Generated evidence requires an exact supported committed authority')
    selected = matches[0]
    if verifier is not None and (type(verifier) is not str or verifier != selected.VERIFIER):
        raise ValueError('Pinned generated evidence verifier differs from committed authority')
    return selected


def resolve_publication(store, source_work_id, build_step_index, expected_sha256=None, *, verifier=None):
    """Select a new binding by recorded facts, or enforce a retained reader."""
    with store._read_transaction():
        reader = _reader(store, source_work_id, verifier)
        return reader.resolve_publication(store, source_work_id, build_step_index, expected_sha256)


def resolve_execution(store, publication_facts, execution_work_id, execution_step_index):
    """Verify publication and execution under their own recorded envelopes."""
    with store._read_transaction():
        if type(publication_facts) is not dict:
            raise ValueError('Select bounded historical publication facts')
        publication_reader = _reader(store, publication_facts.get('source_work_id'),
                                     publication_facts.get('verifier'))
        if publication_facts.get('verifier') != publication_reader.VERIFIER:
            raise ValueError('Publication facts require their pinned evidence verifier')
        execution_reader = _reader(store, execution_work_id)
        if publication_reader is v1 and execution_reader is v1:
            return v1.resolve_execution(store, publication_facts, execution_work_id, execution_step_index)
        return v2._resolve_execution(store, publication_facts, execution_work_id, execution_step_index,
                                     execution_reader.VERIFIER)
