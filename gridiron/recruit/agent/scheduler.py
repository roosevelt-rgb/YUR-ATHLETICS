"""Scheduler (Trinity scheduler.py): runs a plan stage by stage, only steps whose dependencies are met, steps inside a stage
in parallel (threads; no asyncio on Windows), each step routed to engines by the skill registry, every result stored with
engine / latency / confidence / citations / error.

Differences from the original: steps may carry a deterministic `handler` instead of a model call; `consensus` steps fan out
to every available engine and keep all answers for consensus.merge_notes; JSON steps are parsed with a fenced-JSON parser and
fall back to the GolfSnapPro section extractor."""
from __future__ import annotations
import json
import pathlib
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import llm  # recruit/llm.py

from .models import ExecutionReport, PlanStep, SubtaskResult
from .result_store import ResultStore
from .skill_registry import pick_engines
from .synthesizer import synthesize_response

SECTION_NAMES = ["PRE-SNAP", "DROP", "POCKET", "RELEASE", "BALL PLACEMENT", "KEY ISSUES", "DRILLS", "SHOW COACHES"]


def parse_json_text(text: str) -> Optional[Dict[str, Any]]:
    """JSON object from a model reply: fenced ```json, bare object, or the largest {...} span."""
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    cands = [m.group(1)] if m else []
    s, e = text.find("{"), text.rfind("}")
    if s >= 0 and e > s:
        cands.append(text[s:e + 1])
    for c in cands:
        try:
            return json.loads(c)
        except Exception:
            continue
    return None


def extract_section(text: str, section_name: str, names: List[str] = SECTION_NAMES) -> str:
    """GolfSnapPro trinity_client._extract_section (unchanged logic)."""
    if section_name in text:
        start = text.find(section_name)
        end = len(text)
        for n in names:
            if n != section_name and n in text[start:]:
                end = min(end, text.find(n, start))
        return text[start:end].strip()
    return ""


class WorkloadOrchestrator:
    def __init__(self, handlers: Dict[str, Callable[[PlanStep, ResultStore, Dict[str, Any]], Dict[str, Any]]], workers: int = 3, log=print) -> None:
        self.handlers = handlers
        self.workers = workers
        self.log = log

    def run(self, prompt: str, steps: List[PlanStep], context: Optional[Dict[str, Any]] = None) -> ExecutionReport:
        store = ResultStore()
        timeline: List[Dict[str, Any]] = []
        context = context or {}
        for stage in sorted({s.stage for s in steps}):
            batch = [s for s in steps if s.stage == stage and self._dependencies_met(s, store)]
            if not batch:
                continue
            with ThreadPoolExecutor(max_workers=self.workers) as ex:
                results = list(ex.map(lambda s: self._run_step(s, prompt, store, context), batch))
            for result in results:
                store.add(result)
                timeline.append({"step_id": result.step_id, "engine": result.engine, "latency": result.latency, "confidence": result.confidence, "error": result.error})
                self.log(f"  [{result.engine}] {result.step_id} {result.latency:.1f}s conf={result.confidence:.2f}" + (f" ERROR {result.error[:80]}" if result.error else ""))
        final_output = synthesize_response(prompt, steps, store.as_dict())
        return ExecutionReport(prompt=prompt, steps=steps, results=store.as_dict(), final_output=final_output, timeline=timeline, artifacts=context.get("artifacts", {}))

    # ---- steps ----
    def _run_step(self, step: PlanStep, prompt: str, store: ResultStore, context: Dict[str, Any]) -> SubtaskResult:
        start = time.time()
        handler = step.payload.get("handler")
        if handler:
            try:
                data = self.handlers[handler](step, store, context)
                return SubtaskResult(step_id=step.id, engine="handler:" + handler, text=data.get("text", ""), latency=time.time() - start,
                                     confidence=float(data.get("confidence", 1.0)), citations=self._derive_citations(store, step), data=data)
            except Exception as exc:
                return SubtaskResult(step_id=step.id, engine="handler:" + handler, text="", latency=time.time() - start, confidence=0.0, error=f"{exc.__class__.__name__}: {exc}")
        engines = pick_engines(step.intent, step.engine_hint)
        if not engines:
            return SubtaskResult(step_id=step.id, engine="none", text="", latency=0.0, confidence=0.0, error="no engine key available")
        task_prompt, system = context["compose"](step, store)
        images = [pathlib.Path(p) for p in step.payload.get("images", [])]
        max_tokens = int(step.payload.get("max_tokens", 1500))
        if step.payload.get("consensus"):
            answers = [self._call(step, e, task_prompt, system, images, max_tokens, start) for e in engines]
            store.add_many(step.id, answers)
            good = [a for a in answers if not a.error] or answers
            best = good[0]
            best.data = {"answers": [a.data for a in answers], "engines": [a.engine for a in answers]}
            best.engine = "+".join(a.engine for a in answers if not a.error) or best.engine
            return best
        last: Optional[SubtaskResult] = None
        for e in engines:
            last = self._call(step, e, task_prompt, system, images, max_tokens, start)
            if not last.error:
                return last
        return last  # type: ignore[return-value]

    def _call(self, step: PlanStep, engine: str, task_prompt: str, system: str, images, max_tokens: int, start: float) -> SubtaskResult:
        t0 = time.time()
        try:
            text, provider = llm.complete_with(engine, task_prompt, system, images, max_tokens, timeout=int(step.payload.get("timeout", 420)))
            data: Dict[str, Any] = {}
            if step.payload.get("json"):
                parsed = parse_json_text(text)
                data = parsed if isinstance(parsed, dict) else {"_unparsed": True, "sections_text": {n: extract_section(text, n) for n in SECTION_NAMES}}
            conf = 0.85 if data and not data.get("_unparsed") else (0.5 if text else 0.0)
            return SubtaskResult(step_id=step.id, engine=provider, text=text, latency=time.time() - t0, confidence=conf, data=data,
                                 inputs={"images": [str(i) for i in images], "prompt_sha": _sha(task_prompt)})
        except Exception as exc:
            return SubtaskResult(step_id=step.id, engine=engine, text="", latency=time.time() - t0, confidence=0.0, error=f"{exc.__class__.__name__}: {str(exc)[:160]}")

    def _dependencies_met(self, step: PlanStep, store: ResultStore) -> bool:
        return all(store.get(d) is not None for d in step.depends_on)

    def _derive_citations(self, store: ResultStore, step: PlanStep) -> List[str]:
        cites = []
        for dep_id in step.depends_on:
            dep = store.get(dep_id)
            if dep:
                cites.append(f"{dep.engine}:{dep.step_id}")
        return cites[:5]


def _sha(s: str) -> str:
    import hashlib
    return hashlib.sha256(s.encode("utf-8", "ignore")).hexdigest()[:16]
