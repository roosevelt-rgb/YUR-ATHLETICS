"""Concept identity, immutable versions and evidence under CommitService.

This is a projection and transaction mixin, never an orchestrator. Every stage
decision is delegated to the pure concept policy; source facts are reconstructed
from existing committed records, never accepted as caller-supplied pass flags.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import re
import uuid

from .repository_context import SECRET_CONTENT

CONCEPT_AUTHORITY = {"issuer": "local-user", "scope": "concept-development", "actions": ["commit"]}
MAX_CONCEPTS, MAX_VERSIONS, MAX_EVIDENCE, MAX_HISTORY = 100, 16, 32, 128
MAX_DOCUMENT_BYTES = 64 * 1024
ZERO = "0" * 64
_MID = re.compile(r"^[a-f0-9]{32}$")
_SHA = re.compile(r"^[a-f0-9]{64}$")
_FIELDS = {"id", "name", "domain_tags", "thesis_statement", "stage", "parent_id", "lineage",
           "created_at", "updated_at", "versions", "evidence"}
_SEED = {"name", "domain_tags", "thesis_statement"}
_VERSION = {"id", "ordinal", "parent_version_id", "build_mission_id", "artifact_sha256", "runtime_sha256",
            "validation_receipt_hash", "artifact_receipt_hash", "created_at"}
_GENERATED_VERSION = {"kind", "id", "ordinal", "parent_version_id", "created_at", "source_work_id",
                      "build_step_index", "artifact_sha256", "source_sha256", "contract_sha256", "driver_sha256",
                      "runtime_sha256", "acceptance_cohort_sha256", "evidence_verifier",
                      "validation_receipt_hash", "artifact_receipt_hash"}
_GENERATED_VERIFIERS = {"yur.generated-evidence.v1": 20, "yur.generated-evidence.v2": 128}
_EVIDENCE = {"id", "requirement", "source", "artifact_id", "artifact_sha256", "receipt_hash", "created_at"}
_INTENT = {"name", "domain_tags", "thesis_statement"}
_PLANS = {"charter", "success_criteria", "constraint_set"}
_BUILD = {"artifact", "build_log"}


class ConceptConflictError(ValueError):
    """The concept changed after this operation was prepared."""


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _digest(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _clock():
    return datetime.now(timezone.utc).isoformat()


def _uuid(value):
    if not isinstance(value, str):
        raise ValueError("Concept identifiers must be canonical UUIDs")
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError("Noncanonical UUID")
    except (ValueError, AttributeError) as exc:
        raise ValueError("Concept identifiers must be canonical UUIDs") from exc


def _hash(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError("Concept evidence requires exact SHA-256 hashes")


def _mid(value):
    if not isinstance(value, str) or not _MID.fullmatch(value):
        raise ValueError("Source mission/artifact requires an exact 32-hex identifier")


def _step(value):
    if type(value) is not int or not 0 <= value < 128:
        raise ValueError("Generated evidence requires a bounded exact Work step index")


def _time(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("Concept timestamp must be timezone-aware ISO text")
    result = datetime.fromisoformat(value)
    if result.tzinfo is None:
        raise ValueError("Concept timestamp must be timezone-aware ISO text")
    return result


def _text(value, field, maximum):
    if (not isinstance(value, str) or not value.strip() or len(value) > maximum
            or any(ord(c) < 32 and c not in "\n\r\t" for c in value)):
        raise ValueError(f"Concept {field} must contain bounded nonempty text")


def _seed(document):
    if not isinstance(document, dict) or set(document) != _SEED:
        raise ValueError("Concept seed accepts only name, domain_tags and thesis_statement")
    _text(document["name"], "name", 160)
    _text(document["thesis_statement"], "thesis_statement", 8000)
    tags = document["domain_tags"]
    if not isinstance(tags, list) or not 1 <= len(tags) <= 8:
        raise ValueError("Concept domain_tags contains 1..8 tags")
    for tag in tags:
        _text(tag, "domain tag", 40)
    if len(set(tags)) != len(tags):
        raise ValueError("Concept domain tags must be unique")
    return _safe(document)


def _safe(value):
    try:
        encoded = _json(value)
        if len(encoded.encode("utf-8")) > MAX_DOCUMENT_BYTES or SECRET_CONTENT.search(encoded):
            raise ValueError("Concept exceeds its 64 KiB limit or contains potential credentials")
        return json.loads(encoded)
    except (TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError("Concept requires bounded finite UTF-8 JSON") from exc


def _source(value):
    if not isinstance(value, dict):
        raise ValueError("Evidence source must be a typed reference")
    fields = {"concept_intent": {"kind"}, "work_artifact": {"kind", "mission_id", "artifact_id"},
              "specialist_build": {"kind", "version_id"}, "specialist_execution": {"kind", "version_id", "run_id"},
              "generated_build": {"kind", "version_id"},
              "generated_execution": {"kind", "version_id", "execution_work_id", "execution_step_index"}}
    if not isinstance(value.get("kind"), str) or value["kind"] not in fields or set(value) != fields[value["kind"]]:
        raise ValueError("Unsupported concept evidence source fields")
    for key in ("mission_id", "artifact_id", "run_id", "execution_work_id"):
        if key in value:
            _mid(value[key])
    if "version_id" in value:
        _uuid(value["version_id"])
    if "execution_step_index" in value:
        _step(value["execution_step_index"])


def _document(document):
    from .concept_policy import stage_catalog
    if not isinstance(document, dict) or set(document) != _FIELDS:
        raise ValueError("Concept document has missing or unsupported fields")
    _uuid(document["id"])
    _seed({key: document[key] for key in _SEED})
    # Successor gates are intentionally unavailable in this first projection.
    if document["parent_id"] is not None or document["lineage"] != []:
        raise ValueError("Concept succession requires an admitted successor gate")
    stages = {entry["stage"] for entry in stage_catalog()}
    if document["stage"] not in stages:
        raise ValueError("Unknown concept stage")
    if _time(document["updated_at"]) < _time(document["created_at"]):
        raise ValueError("Concept timestamps cannot run backwards")
    versions = document["versions"]
    if not isinstance(versions, list) or len(versions) > MAX_VERSIONS:
        raise ValueError("Concept has at most 16 immutable versions")
    seen, builds, digests = set(), set(), set()
    for ordinal, version in enumerate(versions, 1):
        generated = isinstance(version, dict) and version.get("kind") == "generated_python"
        if not isinstance(version, dict) or set(version) != (_GENERATED_VERSION if generated else _VERSION):
            raise ValueError("Invalid concept version fields")
        _uuid(version["id"])
        if generated:
            _mid(version["source_work_id"])
            _step(version["build_step_index"])
            if (type(version["evidence_verifier"]) is not str or version["evidence_verifier"] not in _GENERATED_VERIFIERS
                    or version["build_step_index"] >= _GENERATED_VERIFIERS[version["evidence_verifier"]]):
                raise ValueError("Unknown immutable generated evidence verifier")
            for key in ("source_sha256", "contract_sha256", "driver_sha256", "acceptance_cohort_sha256"):
                _hash(version[key])
            build_identity = ("generated_python", version["source_work_id"], version["build_step_index"])
        else:
            _mid(version["build_mission_id"])
            build_identity = ("specialist", version["build_mission_id"])
        if version["ordinal"] != ordinal or type(version["ordinal"]) is not int:
            raise ValueError("Concept version ordinal mismatch")
        if version["id"] in seen or build_identity in builds or version["artifact_sha256"] in digests:
            raise ValueError("Duplicate concept version identity or artifact")
        if ordinal == 1 and version["parent_version_id"] is not None:
            raise ValueError("First version cannot invent a parent")
        if ordinal > 1 and version["parent_version_id"] not in seen:
            raise ValueError("Version parent must be an earlier version of this concept")
        for key in ("artifact_sha256", "runtime_sha256", "validation_receipt_hash", "artifact_receipt_hash"):
            _hash(version[key])
        _time(version["created_at"])
        seen.add(version["id"])
        builds.add(build_identity)
        digests.add(version["artifact_sha256"])
    evidence = document["evidence"]
    if not isinstance(evidence, list) or len(evidence) > MAX_EVIDENCE:
        raise ValueError("Concept has at most 32 immutable evidence references")
    seen = set()
    for entry in evidence:
        if not isinstance(entry, dict) or set(entry) != _EVIDENCE:
            raise ValueError("Invalid concept evidence fields")
        _uuid(entry["id"])
        if entry["id"] in seen:
            raise ValueError("Duplicate concept evidence identity")
        seen.add(entry["id"])
        _text(entry["requirement"], "evidence requirement", 80)
        _source(entry["source"])
        _text(entry["artifact_id"], "evidence artifact identity", 200)
        _hash(entry["artifact_sha256"])
        _hash(entry["receipt_hash"])
        _time(entry["created_at"])
    return _safe(document)


def _receipt(event):
    return {key: event[key] for key in ("id", "concept_id", "revision", "event_type", "hash", "previous_hash", "created_at")}


def _response(event):
    concept = {**deepcopy(event["data"]["document"]), "revision": event["revision"],
               "history_hash": event["hash"], "receipt": _receipt(event)}
    if event["event_type"] in {"concept.transitioned", "concept.transition.denied"}:
        return {"concept": concept, "decision": deepcopy(event["data"]["change"]["decision"])}
    return concept


class ConceptCommitMixin:
    def _initialize_concept_schema(self):
        self._db.execute("""CREATE TABLE concept_documents (
            id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0))""")
        self._db.execute("""CREATE TABLE concept_events (
            id INTEGER PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concept_documents(id),
            revision INTEGER NOT NULL, operation_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
            state_digest TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL,
            UNIQUE(concept_id,revision))""")
        self._db.execute("CREATE INDEX concept_history ON concept_events(concept_id,revision)")

    def _concept_event(self, row):
        event = dict(row)
        event["data"] = json.loads(event["data"])
        return event

    def _concept_last(self, concept_id):
        row = self._db.execute("SELECT * FROM concept_events WHERE concept_id=? ORDER BY revision DESC LIMIT 1", (concept_id,)).fetchone()
        if row is None:
            raise ValueError("Concept not found")
        return self._concept_event(row)

    def get_concept(self, concept_id):
        _uuid(concept_id)
        with self._read_transaction():
            last = self._concept_last(concept_id)
            result = _response(last)
            return result["concept"] if "concept" in result else result

    def get_concept_operation(self, operation_id, authority):
        """Recover the exact committed response without retrying a mutation.

        A later Work receipt may identify the same owner, including after that
        Work concludes. Another Work owner cannot acquire its operation result.
        None means the operation is absent from this verified read snapshot;
        integrity or authority failures remain errors, never apparent absence.
        """
        _uuid(operation_id)
        with self._read_transaction():
            identity = self._concept_authority(authority)
            row = self._db.execute("SELECT * FROM concept_events WHERE operation_id=?", (operation_id,)).fetchone()
            if row is None:
                return None
            event = self._concept_event(row)
            original_identity = self._concept_authority(event["data"]["change"]["authority"])
            if identity != original_identity:
                raise ValueError("Concept operation belongs to different authority")
            return _response(event)

    def list_concepts(self, limit=20, cursor=None):
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("Concept list limit must be 1..20")
        if cursor is not None:
            _uuid(cursor)
        with self._read_transaction():
            if cursor is not None and not self._db.execute("SELECT 1 FROM concept_documents WHERE id=?", (cursor,)).fetchone():
                raise ValueError("Concept cursor not found")
            rows = self._db.execute("SELECT * FROM concept_documents WHERE (? IS NULL OR id>?) ORDER BY id LIMIT ?",
                                    (cursor, cursor, limit + 1)).fetchall()
            items = []
            for row in rows[:limit]:
                doc = json.loads(row["document"])
                items.append({key: doc[key] for key in ("id", "name", "domain_tags", "stage", "parent_id", "created_at", "updated_at")}
                             | {"revision": row["revision"], "version_count": len(doc["versions"]), "evidence_count": len(doc["evidence"])})
            return {"concepts": items, "next_cursor": items[-1]["id"] if len(rows) > limit else None,
                    "total": self._db.execute("SELECT COUNT(*) FROM concept_documents").fetchone()[0]}

    def concept_events(self, concept_id, after_revision=0, limit=20):
        _uuid(concept_id)
        if type(after_revision) is not int or not 0 <= after_revision <= MAX_HISTORY or type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("Concept history requires bounded revision and limit")
        with self._read_transaction():
            self._concept_last(concept_id)
            rows = self._db.execute("SELECT * FROM concept_events WHERE concept_id=? AND revision>? ORDER BY revision LIMIT ?",
                                    (concept_id, after_revision, limit + 1)).fetchall()
            entries = []
            for row in rows[:limit]:
                event = self._concept_event(row)
                change = event["data"]["change"]
                entries.append({**_receipt(event), "operation_id": event["operation_id"],
                                "stage": event["data"]["document"]["stage"], "request_hash": change["request_hash"],
                                "decision": change.get("decision")})
            return {"events": entries, "next_revision": entries[-1]["revision"] if len(rows) > limit else None}

    def concept_authority_for_work(self, mission_id):
        if self._lock_file is None:
            raise ValueError("Delegated concept authority requires the existing worker lock")
        with self._read_transaction():
            work = self.get_work(mission_id)
            if work["status"] != "running":
                raise ValueError("Delegated concept authority requires running Work")
            event = self.work_events(mission_id)[-1]
            authority = {**CONCEPT_AUTHORITY, "work_mission_id": work["id"], "work_request_id": work["request_id"],
                         "work_receipt_hash": event["hash"]}
            self._concept_authority(authority, active=True)
            return authority

    def _concept_authority(self, authority, active=False):
        if authority == CONCEPT_AUTHORITY:
            return deepcopy(authority)
        extra = {"work_mission_id", "work_request_id", "work_receipt_hash"}
        if (not isinstance(authority, dict) or set(authority) != set(CONCEPT_AUTHORITY) | extra
                or {key: authority[key] for key in CONCEPT_AUTHORITY} != CONCEPT_AUTHORITY):
            raise ValueError("Concept changes require exact local-user concept authority")
        _mid(authority["work_mission_id"])
        _uuid(authority["work_request_id"])
        _hash(authority["work_receipt_hash"])
        row = self._db.execute("SELECT * FROM work_events WHERE mission_id=? AND hash=?",
                               (authority["work_mission_id"], authority["work_receipt_hash"])).fetchone()
        if row is None:
            raise ValueError("Concept delegation has no committed Work receipt")
        source = json.loads(row["data"])["document"]
        if (source["request_id"] != authority["work_request_id"] or source["status"] != "running"
                or source["authority"]["issuer"] != "local-user"
                or not {"compute", "commit-artifact"}.issubset(source["authority"]["actions"])):
            raise ValueError("Concept delegation differs from its actual Work authority")
        if active and (self._lock_file is None or self.get_work(source["id"])["status"] != "running"):
            raise ValueError("New delegated concept changes require a running Work owner and worker lock")
        return {key: value for key, value in authority.items() if key != "work_receipt_hash"}

    def _concept_operation(self, operation_id, request, authority):
        _uuid(operation_id)
        identity = self._concept_authority(authority)
        request_hash = _digest({"request": request, "authority_identity": identity})
        row = self._db.execute("SELECT * FROM concept_events WHERE operation_id=?", (operation_id,)).fetchone()
        if row is not None:
            event = self._concept_event(row)
            if event["data"]["change"]["request_hash"] != request_hash:
                raise ValueError("Concept operation ID already belongs to different arguments or authority")
            return request_hash, _response(event)
        self._concept_authority(authority, active=True)
        return request_hash, None

    def _concept_expected(self, concept_id, expected_revision):
        _uuid(concept_id)
        if type(expected_revision) is not int or not 1 <= expected_revision < MAX_HISTORY:
            raise ValueError("Concept expected_revision must be a bounded positive integer")
        concept = self.get_concept(concept_id)
        if concept["revision"] != expected_revision:
            raise ConceptConflictError("Concept changed; reload its current revision")
        return concept

    def _concept_append(self, document, revision, event_type, change):
        if revision > MAX_HISTORY:
            raise ValueError("Concept history reached its 128-event limit")
        prior = self._db.execute("SELECT id,hash FROM concept_events ORDER BY id DESC LIMIT 1").fetchone()
        event = {"id": prior["id"] + 1 if prior else 1, "concept_id": document["id"], "revision": revision,
                 "operation_id": change["operation_id"], "event_type": event_type,
                 "data": {"document": document, "change": change}, "created_at": document["updated_at"],
                 "state_digest": _digest(document), "previous_hash": prior["hash"] if prior else ZERO}
        event["hash"] = _digest(event)
        self._db.execute("INSERT INTO concept_events VALUES (?,?,?,?,?,?,?,?,?,?)", (
            event["id"], event["concept_id"], revision, event["operation_id"], event_type, _json(event["data"]),
            event["created_at"], event["state_digest"], event["previous_hash"], event["hash"]))
        return event

    def _concept_write(self, document, previous_revision, event_type, change):
        checked = _document(document)
        revision = previous_revision + 1
        if previous_revision == 0:
            self._db.execute("INSERT INTO concept_documents VALUES (?,?,?)", (checked["id"], _json(checked), revision))
        else:
            changed = self._db.execute("UPDATE concept_documents SET document=?,revision=? WHERE id=? AND revision=?",
                                       (_json(checked), revision, checked["id"], previous_revision))
            if changed.rowcount != 1:
                raise ConceptConflictError("Concept changed during commit")
        return _response(self._concept_append(checked, revision, event_type, change))

    def create_concept(self, document, authority, idempotency_key):
        seed = _seed(document)
        request = {"command": "create", "document": seed}
        with self._transaction():
            request_hash, replay = self._concept_operation(idempotency_key, request, authority)
            if replay is not None:
                return replay
            if self._db.execute("SELECT COUNT(*) FROM concept_documents").fetchone()[0] >= MAX_CONCEPTS:
                raise ValueError("Concept registry is limited to 100 identities")
            timestamp = _clock()
            concept = {"id": str(uuid.uuid4()), **seed, "stage": "genesis", "parent_id": None, "lineage": [],
                       "versions": [], "evidence": [], "created_at": timestamp, "updated_at": timestamp}
            change = {"operation_id": idempotency_key, "request": request, "request_hash": request_hash, "authority": deepcopy(authority)}
            return self._concept_write(concept, 0, "concept.created", change)

    def _concept_build(self, mission_id, admit=False):
        _mid(mission_id)
        mission = self.get_mission(mission_id)
        artifact = self.get_artifact(mission_id)
        if not mission or mission["status"] != "completed" or not artifact:
            raise ValueError("Concept version requires an actual completed specialist build")
        validation = artifact["validation"]
        if validation.get("passed") is not True or validation.get("independent_validation", {}).get("passed") is not True:
            raise ValueError("Concept version lacks independent package validation")
        events = self.events(mission_id)
        committed = [event for event in events if event["event_type"] == "artifact.committed" and event["data"].get("artifact_digest") == artifact["digest"]]
        evaluated = [event for event in events if event["event_type"] == "cell.validated" and event["data"].get("digest") == artifact["digest"]
                     and event["data"].get("passed") is True]
        if len(committed) != 1 or len(evaluated) != 1:
            raise ValueError("Concept version requires exact artifact and independently evaluated build events")
        cell = evaluated[0]["data"]
        started = [event for event in events if event["event_type"] == "cell.started"
                   and event["data"].get("cell_id") == cell.get("cell_id")
                   and event["data"].get("blind_generation") is True and event["id"] < evaluated[0]["id"]]
        if (len(started) != 1 or evaluated[0]["id"] >= committed[0]["id"]
                or cell.get("validation", {}).get("artifact_digest") != artifact["digest"]
                or cell.get("validation", {}).get("passed") is not True):
            raise ValueError("Concept version has inconsistent build cell and validation ordering")
        runtime_sha = hashlib.sha256(artifact["files"]["runtime.py"].encode("utf-8")).hexdigest()
        if admit:
            from .pack_compiler import validate_pack
            current = validate_pack(artifact["files"])
            if current["passed"] is not True or current["runtime"]["sha256"] != runtime_sha:
                raise ValueError("Concept version runtime is not currently admitted")
        return {"build_mission_id": mission_id, "artifact_digest": artifact["digest"], "runtime_digest": runtime_sha,
                "validation_receipt_hash": evaluated[0]["hash"], "artifact_receipt_hash": committed[0]["hash"]}

    def bind_concept_version(self, concept_id, expected_revision, build_mission_id, parent_version_id, operation_id, authority):
        _mid(build_mission_id)
        if parent_version_id is not None:
            _uuid(parent_version_id)
        request = {"command": "bind_version", "concept_id": concept_id, "expected_revision": expected_revision,
                   "build_mission_id": build_mission_id, "parent_version_id": parent_version_id}
        with self._transaction():
            request_hash, replay = self._concept_operation(operation_id, request, authority)
            if replay is not None:
                return replay
            previous = self._concept_expected(concept_id, expected_revision)
            facts = self._concept_build(build_mission_id, admit=True)
            timestamp = _clock()
            version = {"id": str(uuid.uuid4()), "ordinal": len(previous["versions"]) + 1, "parent_version_id": parent_version_id,
                       "build_mission_id": build_mission_id, "artifact_sha256": facts["artifact_digest"],
                       "runtime_sha256": facts["runtime_digest"], "validation_receipt_hash": facts["validation_receipt_hash"],
                       "artifact_receipt_hash": facts["artifact_receipt_hash"], "created_at": timestamp}
            document = {key: deepcopy(previous[key]) for key in _FIELDS}
            document.update(versions=[*document["versions"], version], updated_at=timestamp)
            return self._concept_write(document, expected_revision, "concept.version.bound", {
                "operation_id": operation_id, "request": request, "request_hash": request_hash, "authority": deepcopy(authority), "version": version})

    def _concept_generated_build(self, source_work_id, build_step_index, artifact_sha256, admit=False, verifier=None):
        from .generated_evidence import resolve_publication
        _mid(source_work_id)
        _step(build_step_index)
        _hash(artifact_sha256)
        historical = resolve_publication(self, source_work_id, build_step_index, artifact_sha256, verifier=verifier)
        if admit:
            # Admission applies to a NEW binding only. Historical projection must
            # never depend on replaceable live runtime modules or current pins.
            from types import SimpleNamespace
            from .work_generated import _resolve
            _resolve(SimpleNamespace(store=self), source_work_id, build_step_index, artifact_sha256)
        return {"source_kind": "generated_python", "source_work_id": source_work_id,
                "build_step_index": build_step_index, "artifact_digest": historical["artifact_sha256"],
                "source_sha256": historical["source_sha256"], "contract_sha256": historical["contract_sha256"],
                "driver_sha256": historical["driver_sha256"], "runtime_digest": historical["runtime_sha256"],
                "acceptance_cohort_sha256": historical["validation_cohort_sha256"],
                "evidence_verifier": historical["verifier"],
                "validation_receipt_hash": historical["validation_receipt_hash"],
                "artifact_receipt_hash": historical["publication_receipt_hash"]}

    def _concept_version_facts(self, version):
        if version.get("kind") == "generated_python":
            facts = self._concept_generated_build(version["source_work_id"], version["build_step_index"], version["artifact_sha256"],
                                                   verifier=version["evidence_verifier"])
            extra = ("source_sha256", "contract_sha256", "driver_sha256", "acceptance_cohort_sha256", "evidence_verifier")
        else:
            facts = self._concept_build(version["build_mission_id"])
            extra = ()
        pairs = (("artifact_sha256", "artifact_digest"), ("runtime_sha256", "runtime_digest"),
                 ("validation_receipt_hash", "validation_receipt_hash"), ("artifact_receipt_hash", "artifact_receipt_hash"))
        if any(version[left] != facts[right] for left, right in pairs) or any(version[key] != facts[key] for key in extra):
            raise ValueError("Concept version source mismatch")
        return facts

    def bind_generated_concept_version(self, concept_id, expected_revision, source_work_id, build_step_index,
                                       artifact_sha256, parent_version_id, operation_id, authority):
        _mid(source_work_id)
        _step(build_step_index)
        _hash(artifact_sha256)
        if parent_version_id is not None:
            _uuid(parent_version_id)
        request = {"command": "bind_generated_version", "concept_id": concept_id, "expected_revision": expected_revision,
                   "source_work_id": source_work_id, "build_step_index": build_step_index,
                   "artifact_sha256": artifact_sha256, "parent_version_id": parent_version_id}
        with self._transaction():
            request_hash, replay = self._concept_operation(operation_id, request, authority)
            if replay is not None:
                return replay
            previous = self._concept_expected(concept_id, expected_revision)
            facts = self._concept_generated_build(source_work_id, build_step_index, artifact_sha256, admit=True)
            timestamp = _clock()
            version = {"kind": "generated_python", "id": str(uuid.uuid4()), "ordinal": len(previous["versions"]) + 1,
                       "parent_version_id": parent_version_id, "created_at": timestamp, "source_work_id": source_work_id,
                       "build_step_index": build_step_index, "artifact_sha256": artifact_sha256,
                       "runtime_sha256": facts["runtime_digest"],
                       **{key: facts[key] for key in ("source_sha256", "contract_sha256", "driver_sha256",
                          "acceptance_cohort_sha256", "evidence_verifier", "validation_receipt_hash", "artifact_receipt_hash")}}
            document = {key: deepcopy(previous[key]) for key in _FIELDS}
            document.update(versions=[*document["versions"], version], updated_at=timestamp)
            return self._concept_write(document, expected_revision, "concept.version.bound", {
                "operation_id": operation_id, "request": request, "request_hash": request_hash,
                "authority": deepcopy(authority), "version": version})

    def _concept_source_facts(self, concept, requirement, source):
        _source(source)
        kind = source["kind"]
        base = {"requirement": requirement, "concept_id": concept["id"]}
        if kind == "concept_intent":
            if requirement not in _INTENT:
                raise ValueError("Concept intent proves only the original Genesis plan fields")
            row = self._db.execute("SELECT * FROM concept_events WHERE concept_id=? AND revision=1", (concept["id"],)).fetchone()
            event = self._concept_event(row)
            content = event["data"]["document"][requirement]
            return {**base, "artifact_id": concept["id"], "artifact_sha256": _digest(content), "receipt_hash": event["hash"],
                    "evidence_type": "committed-plan", "facts": {"content": content}}
        if kind == "work_artifact":
            if requirement not in _PLANS:
                raise ValueError("Work plans cannot establish measured stability, deployment, billing or health")
            work = self.get_work(source["mission_id"])
            artifact = next((item for item in work["artifacts"] if item["id"] == source["artifact_id"]), None)
            step = next((item for item in work["steps"] if item["id"] == source["artifact_id"]), None)
            if (not artifact or not step or artifact["status"] != "committed" or step.get("succeeded") is not True
                    or step["tool"] != "create_artifact" or step["result"].get("proposal") != artifact["proposal"]):
                raise ValueError("Concept plan requires a successfully committed Work artifact")
            proposal = artifact["proposal"]
            if proposal.get("kind") != "artifact" or proposal.get("media_type") != "application/json" or proposal.get("encoding", "utf-8") != "utf-8":
                raise ValueError("Concept plans require a bounded JSON artifact")
            raw = proposal["content"].encode("utf-8")
            if len(raw) > 16000 or hashlib.sha256(raw).hexdigest() != proposal["sha256"] or len(raw) != proposal["bytes"]:
                raise ValueError("Concept plan content differs from its committed bytes")
            from .pack_compiler import _strict_json
            plan = _strict_json(proposal["content"])
            if (not isinstance(plan, dict) or set(plan) != {"schema", "concept_id", "requirement", "content"}
                    or plan["schema"] != "yur.concept-plan.v1" or plan["concept_id"] != concept["id"] or plan["requirement"] != requirement):
                raise ValueError("Concept plan schema, concept identity or requirement differs")
            rows = [event for event in self.work_events(work["id"]) if event["event_type"] == "work.tool.completed"
                    and event["data"]["change"].get("step_id") == source["artifact_id"]
                    and any(item == step for item in event["data"]["document"]["steps"])]
            if len(rows) != 1:
                raise ValueError("Concept plan has no unique matching Work commit receipt")
            return {**base, "artifact_id": source["artifact_id"], "artifact_sha256": proposal["sha256"], "receipt_hash": rows[0]["hash"],
                    "evidence_type": "committed-plan", "facts": {"content": plan["content"]}}
        version = next((item for item in concept["versions"] if item["id"] == source["version_id"]), None)
        if version is None:
            raise ValueError("Concept evidence version belongs to another concept or is absent")
        generated = version.get("kind") == "generated_python"
        if generated != (kind in {"generated_build", "generated_execution"}):
            raise ValueError("Concept evidence source kind differs from its immutable version")
        facts = self._concept_version_facts(version)
        if generated:
            if kind == "generated_build":
                if requirement not in _BUILD:
                    raise ValueError("Generated acceptance cases establish artifact/build logs, not independent stability or market quality")
                receipt = facts["artifact_receipt_hash" if requirement == "artifact" else "validation_receipt_hash"]
                return {**base, "artifact_id": version["id"], "artifact_sha256": facts["artifact_digest"],
                        "receipt_hash": receipt, "evidence_type": "validated-build", "facts": facts}
            if requirement != "instrumentation":
                raise ValueError("A generated execution receipt establishes instrumentation only")
            from .generated_evidence import resolve_publication, resolve_execution
            publication = resolve_publication(self, version["source_work_id"], version["build_step_index"], version["artifact_sha256"],
                                              verifier=version["evidence_verifier"])
            observed = resolve_execution(self, publication, source["execution_work_id"], source["execution_step_index"])
            execution = {key: value for key, value in facts.items() if key not in {"validation_receipt_hash", "artifact_receipt_hash"}}
            execution.update({key: observed[key] for key in ("execution_work_id", "execution_step_index", "capability_id",
                "input_hash", "output_hash", "accepted_receipt_hash", "snapshot_receipt_hash", "execution_receipt_hash", "result_receipt_hash")})
            if "execution_verifier" in observed:
                execution["execution_verifier"] = observed["execution_verifier"]
            return {**base, "artifact_id": version["id"], "artifact_sha256": facts["artifact_digest"],
                    "receipt_hash": observed["result_receipt_hash"], "evidence_type": "execution-receipt", "facts": execution}
        if kind == "specialist_build":
            if requirement not in _BUILD:
                raise ValueError("Fixed build fixtures establish artifact/build logs, not stability or market quality")
            receipt = facts["artifact_receipt_hash" if requirement == "artifact" else "validation_receipt_hash"]
            return {**base, "artifact_id": version["id"], "artifact_sha256": facts["artifact_digest"], "receipt_hash": receipt,
                    "evidence_type": "validated-build", "facts": facts}
        if requirement != "instrumentation":
            raise ValueError("An execution receipt establishes instrumentation only")
        events = [event for event in self.events(version["build_mission_id"]) if event["event_type"] == "execution.completed"
                  and event["data"].get("run_id") == source["run_id"]]
        if len(events) != 1:
            raise ValueError("Concept instrumentation requires an actual completed execution")
        event, data = events[0], events[0]["data"]
        if data.get("artifact_digest") != facts["artifact_digest"] or data.get("runtime_sha256") != facts["runtime_digest"]:
            raise ValueError("Execution is not bound to the exact concept artifact and runtime")
        if "output" not in data or _digest(data["output"]) != data["output_hash"]:
            raise ValueError("Execution evidence requires a retained output matching its hash")
        started = [item for item in self.events(version["build_mission_id"]) if item["event_type"] == "execution.started"
                   and item["data"].get("run_id") == source["run_id"]]
        if (len(started) != 1 or started[0]["id"] >= event["id"]
                or any(started[0]["data"].get(key) != data.get(key) for key in ("capability_id", "input_hash", "runtime_sha256"))):
            raise ValueError("Execution instrumentation has no matching accepted execution input/runtime")
        _hash(data["input_hash"])
        _hash(data["output_hash"])
        execution = {key: facts[key] for key in ("build_mission_id", "artifact_digest", "runtime_digest")}
        execution.update({key: data[key] for key in ("capability_id", "input_hash", "output_hash")})
        return {**base, "artifact_id": version["id"], "artifact_sha256": facts["artifact_digest"], "receipt_hash": event["hash"],
                "evidence_type": "execution-receipt", "facts": execution}

    def submit_concept_evidence(self, concept_id, expected_revision, evidence, operation_id, authority):
        if not isinstance(evidence, dict) or set(evidence) != {"requirement", "source"}:
            raise ValueError("Concept evidence accepts only requirement and source")
        _text(evidence["requirement"], "requirement", 80)
        _source(evidence["source"])
        request = {"command": "add_evidence", "concept_id": concept_id, "expected_revision": expected_revision, "evidence": _safe(evidence)}
        with self._transaction():
            request_hash, replay = self._concept_operation(operation_id, request, authority)
            if replay is not None:
                return replay
            previous = self._concept_expected(concept_id, expected_revision)
            facts = self._concept_source_facts(previous, evidence["requirement"], evidence["source"])
            if any(item["requirement"] == evidence["requirement"] and item["source"] == evidence["source"] for item in previous["evidence"]):
                raise ValueError("This concept evidence source is already recorded")
            timestamp = _clock()
            entry = {"id": str(uuid.uuid4()), **deepcopy(evidence),
                     **{key: facts[key] for key in ("artifact_id", "artifact_sha256", "receipt_hash")}, "created_at": timestamp}
            document = {key: deepcopy(previous[key]) for key in _FIELDS}
            document.update(evidence=[*document["evidence"], entry], updated_at=timestamp)
            return self._concept_write(document, expected_revision, "concept.evidence.added", {
                "operation_id": operation_id, "request": request, "request_hash": request_hash, "authority": deepcopy(authority), "evidence": entry})

    def _concept_decision(self, concept, target_stage, evidence_ids, operation_id, reason=None):
        from .concept_policy import validate_transition
        if not isinstance(evidence_ids, list) or len(evidence_ids) > 12:
            raise ValueError("Transition evidence must be a bounded unique ID list")
        for evidence_id in evidence_ids:
            _uuid(evidence_id)
        if len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("Transition evidence IDs must be unique")
        entries = []
        for evidence_id in evidence_ids:
            _uuid(evidence_id)
            entry = next((item for item in concept["evidence"] if item["id"] == evidence_id), None)
            if entry is None:
                raise ValueError("Transition evidence belongs to another concept or is absent")
            entries.append(entry)
        refs = [{key: entry[key] for key in ("requirement", "artifact_id", "artifact_sha256", "receipt_hash")} for entry in entries]
        def resolve(reference):
            match = next((entry for entry in entries if all(entry[key] == value for key, value in reference.items())), None)
            if match is None:
                raise ValueError("Evidence reference is not a selected immutable concept record")
            fresh = self._concept_source_facts(concept, match["requirement"], match["source"])
            if any(fresh[key] != match[key] for key in ("artifact_id", "artifact_sha256", "receipt_hash")):
                raise ValueError("Concept evidence differs from its committed source")
            return fresh
        request = {"transition_id": operation_id, "to_stage": target_stage, "evidence": refs}
        if reason is not None:
            request["reason"] = reason
        view = {key: concept[key] for key in ("id", "stage", "parent_id", "lineage", "revision", "history_hash")}
        return validate_transition(view, request, resolve_evidence=resolve)

    def transition_concept(self, concept_id, expected_revision, target_stage, evidence_ids, operation_id, authority, reason=None):
        request = {"command": "transition", "concept_id": concept_id, "expected_revision": expected_revision,
                   "target_stage": target_stage, "evidence_ids": evidence_ids, "reason": reason}
        request = _safe(request)
        with self._transaction():
            request_hash, replay = self._concept_operation(operation_id, request, authority)
            if replay is not None:
                return replay
            previous = self._concept_expected(concept_id, expected_revision)
            decision = self._concept_decision(previous, target_stage, evidence_ids, operation_id, reason)
            document = {key: deepcopy(previous[key]) for key in _FIELDS}
            document.update(stage=target_stage if decision["allowed"] else previous["stage"], updated_at=_clock())
            return self._concept_write(document, expected_revision, "concept.transitioned" if decision["allowed"] else "concept.transition.denied", {
                "operation_id": operation_id, "request": request, "request_hash": request_hash,
                "authority": deepcopy(authority), "decision": decision})

    def _verify_concepts(self):
        previous_hash, count, latest = ZERO, 0, {}
        for row in self._db.execute("SELECT * FROM concept_events ORDER BY id"):
            event = self._concept_event(row)
            stored_hash = event.pop("hash")
            count += 1
            if event["id"] != count or event["previous_hash"] != previous_hash or _digest(event) != stored_hash:
                raise ValueError("Concept event hash chain mismatch")
            event["hash"] = stored_hash
            document = _document(event["data"]["document"])
            change = event["data"]["change"]
            change_fields = {"operation_id", "request", "request_hash", "authority"}
            extra = {"concept.created": set(), "concept.version.bound": {"version"}, "concept.evidence.added": {"evidence"},
                     "concept.transitioned": {"decision"}, "concept.transition.denied": {"decision"}}
            if event["event_type"] not in extra or not isinstance(change, dict) or set(change) != change_fields | extra[event["event_type"]]:
                raise ValueError("Unknown concept event type or change fields")
            _uuid(event["operation_id"])
            if event["operation_id"] != change["operation_id"] or event["concept_id"] != document["id"] or event["state_digest"] != _digest(document):
                raise ValueError("Concept event identity or state digest mismatch")
            identity = self._concept_authority(change["authority"])
            if _digest({"request": change["request"], "authority_identity": identity}) != change["request_hash"]:
                raise ValueError("Concept request binding mismatch")
            prior = latest.get(document["id"])
            if event["revision"] != (prior["revision"] + 1 if prior else 1) or event["revision"] > MAX_HISTORY:
                raise ValueError("Concept revision continuity mismatch")
            request = change["request"]
            if prior is None:
                if event["event_type"] != "concept.created" or request != {"command": "create", "document": {key: document[key] for key in _SEED}}:
                    raise ValueError("Concept must begin with its exact seed commitment")
                if document["stage"] != "genesis" or document["versions"] or document["evidence"] or document["created_at"] != document["updated_at"]:
                    raise ValueError("Concept creation cannot invent progress or evidence")
            else:
                old = prior["document"]
                if request.get("concept_id") != document["id"] or request.get("expected_revision") != prior["revision"]:
                    raise ValueError("Concept mutation lost its original CAS binding")
                expected = deepcopy(old)
                expected["updated_at"] = document["updated_at"]
                if _time(document["updated_at"]) < _time(old["updated_at"]):
                    raise ValueError("Concept event time moved backwards")
                if event["event_type"] == "concept.version.bound":
                    version = change["version"]
                    if version["created_at"] != document["updated_at"]:
                        raise ValueError("Concept version creation time differs from its commit")
                    if version.get("kind") == "generated_python":
                        expected_request = {"command": "bind_generated_version", "concept_id": document["id"], "expected_revision": prior["revision"],
                                            **{key: version[key] for key in ("source_work_id", "build_step_index", "artifact_sha256", "parent_version_id")}}
                    else:
                        expected_request = {"command": "bind_version", "concept_id": document["id"], "expected_revision": prior["revision"],
                                            "build_mission_id": version["build_mission_id"], "parent_version_id": version["parent_version_id"]}
                    if request != expected_request:
                        raise ValueError("Concept version differs from its accepted request")
                    self._concept_version_facts(version)
                    expected["versions"].append(version)
                elif event["event_type"] == "concept.evidence.added":
                    entry = change["evidence"]
                    if entry["created_at"] != document["updated_at"]:
                        raise ValueError("Concept evidence creation time differs from its commit")
                    if request != {"command": "add_evidence", "concept_id": document["id"], "expected_revision": prior["revision"],
                                   "evidence": {key: entry[key] for key in ("requirement", "source")}}:
                        raise ValueError("Concept evidence differs from its accepted request")
                    fresh = self._concept_source_facts(old, entry["requirement"], entry["source"])
                    if any(entry[key] != fresh[key] for key in ("artifact_id", "artifact_sha256", "receipt_hash")):
                        raise ValueError("Concept evidence source hash mismatch")
                    expected["evidence"].append(entry)
                elif event["event_type"] in {"concept.transitioned", "concept.transition.denied"}:
                    if set(request) != {"command", "concept_id", "expected_revision", "target_stage", "evidence_ids", "reason"} or request["command"] != "transition":
                        raise ValueError("Concept transition request contract mismatch")
                    view = {**old, "revision": prior["revision"], "history_hash": prior["hash"]}
                    decision = self._concept_decision(view, request["target_stage"], request["evidence_ids"], event["operation_id"], request["reason"])
                    if decision != change["decision"] or decision["allowed"] != (event["event_type"] == "concept.transitioned"):
                        raise ValueError("Concept transition lacks matching policy evidence")
                    expected["stage"] = request["target_stage"] if decision["allowed"] else old["stage"]
                else:
                    raise ValueError("Unknown concept event type")
                if document != expected:
                    raise ValueError("Concept projection changed outside its accepted operation")
            if event["created_at"] != document["updated_at"]:
                raise ValueError("Concept event timestamp mismatch")
            latest[document["id"]] = {"document": document, "revision": event["revision"], "hash": stored_hash}
            previous_hash = stored_hash
        rows = list(self._db.execute("SELECT * FROM concept_documents"))
        if len(rows) > MAX_CONCEPTS or {row["id"] for row in rows} != set(latest):
            raise ValueError("Concept registry/event coverage mismatch")
        for row in rows:
            state = latest[row["id"]]
            if row["revision"] != state["revision"] or json.loads(row["document"]) != state["document"]:
                raise ValueError("Concept document differs from its authoritative event projection")
        return {"concepts": len(rows), "concept_events": count, "concept_head_hash": previous_hash}
