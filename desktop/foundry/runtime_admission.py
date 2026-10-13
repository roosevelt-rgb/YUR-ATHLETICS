"""Select only source-verified local specialist runtime revisions.

Package runtime.py is data: it is hashed and compared, never imported or executed.
The historical module is a fixed local source copy verified before its static
import. Its pin must not change when the current capability registry evolves.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from types import ModuleType

HISTORICAL_SHA256 = "d1bba1a6a94c8b0aad0441d3bd9a457b343ee514e464097e8923333787831e08"
_CURRENT_PATH = Path(__file__).with_name("specialists.py")
_HISTORICAL_PATH = Path(__file__).with_name("specialist_runtime_v1.py")


def _sha(source):
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def _read(path):
    try:
        return path.read_text(encoding="utf-8").replace("\r\n", "\n")
    except (OSError, UnicodeError) as exc:
        raise ValueError("trusted runtime source is unavailable; restart with a verified source release") from exc


_CURRENT_SOURCE = _read(_CURRENT_PATH)
_CURRENT_SHA256 = _sha(_CURRENT_SOURCE)
_HISTORICAL_SOURCE = _read(_HISTORICAL_PATH)
if _sha(_HISTORICAL_SOURCE) != HISTORICAL_SHA256:
    raise ValueError("historical specialist runtime differs from its fixed admission pin")

# Static canonical modules only, after verifying the historical source pin.
from . import specialists as _current_module
from . import specialist_runtime_v1 as _historical_module


def trusted_current_source():
    if _sha(_read(_CURRENT_PATH)) != _CURRENT_SHA256:
        raise ValueError("trusted runtime source changed during this process; restart with a verified source release")
    return _CURRENT_SOURCE


@dataclass(frozen=True)
class AdmittedRuntime:
    sha256: str
    source: str
    _module: ModuleType
    _path: Path

    @property
    def identifier(self):
        return "yur.specialists.sha256:" + self.sha256

    def verify(self):
        # Keep the existing process-release boundary even for historical work.
        trusted_current_source()
        if _sha(_read(self._path)) != self.sha256:
            raise ValueError("admitted specialist runtime source changed or differs from its fixed pin")

    @property
    def strategies(self):
        self.verify()
        return self._module.STRATEGIES

    def resolve(self, capability_ids):
        self.verify()
        return self._module.CapabilityResolver().resolve(capability_ids)

    def validate_schema(self, value, schema, path="input"):
        self.verify()
        return self._module.validate_schema(value, schema, path)

    def run(self, capability_id, payload, strategy="balanced"):
        self.verify()
        return self._module.run_capability(capability_id, payload, strategy)


_CURRENT = AdmittedRuntime(_CURRENT_SHA256, _CURRENT_SOURCE, _current_module, _CURRENT_PATH)
_HISTORICAL = AdmittedRuntime(HISTORICAL_SHA256, _HISTORICAL_SOURCE, _historical_module, _HISTORICAL_PATH)


def current_runtime():
    _CURRENT.verify()
    return _CURRENT


def runtime_by_hash(runtime_sha256):
    if not isinstance(runtime_sha256, str):
        raise ValueError("specialist runtime admission requires an exact source SHA-256")
    # When this release still has identical source, historical semantics remain
    # selected consistently; the identifier is content-addressed in either lane.
    for runtime in (_HISTORICAL, _CURRENT):
        if runtime_sha256 == runtime.sha256:
            runtime.verify()
            return runtime
    raise ValueError("specialist runtime source is not an admitted revision")


def admit_runtime(package_source):
    if not isinstance(package_source, str):
        raise ValueError("package runtime must be UTF-8 source text")
    runtime = runtime_by_hash(_sha(package_source))
    if package_source != runtime.source:
        raise ValueError("package runtime differs from its admitted source")
    return runtime


def run_admitted_capability(runtime_sha256, capability_id, payload, strategy="balanced"):
    return runtime_by_hash(runtime_sha256).run(capability_id, payload, strategy)
