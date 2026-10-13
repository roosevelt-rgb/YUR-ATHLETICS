"""In-memory result store with provenance (Trinity result_store.py)."""
from __future__ import annotations
from typing import Dict, List, Optional
from .models import SubtaskResult


class ResultStore:
    def __init__(self) -> None:
        self._store: Dict[str, SubtaskResult] = {}
        self._multi: Dict[str, List[SubtaskResult]] = {}   # consensus steps keep every engine's answer

    def add(self, result: SubtaskResult) -> None:
        self._store[result.step_id] = result

    def add_many(self, step_id: str, results: List[SubtaskResult]) -> None:
        self._multi[step_id] = results

    def get(self, step_id: str) -> Optional[SubtaskResult]:
        return self._store.get(step_id)

    def get_many(self, step_id: str) -> List[SubtaskResult]:
        return list(self._multi.get(step_id, []))

    def as_dict(self) -> Dict[str, SubtaskResult]:
        return dict(self._store)
