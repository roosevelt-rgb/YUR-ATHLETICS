"""Plan builders (Trinity planner.py shape: context -> analysis -> quality -> synthesis, as staged PlanSteps).

film-evaluation : stage 0  one `evaluate` step per play (vision, consensus across engines)
                  stage 1  `synthesize` rollup (deterministic handler)
recruiting-outreach : stage 0 `context` facts (handler) -> stage 1 one `draft` step per program (model, JSON)
                  -> stage 2 `quality` guardrails (handler) -> stage 3 `synthesize` report (handler)"""
from __future__ import annotations
from typing import Any, Dict, List
from .models import PlanStep


def build_film_plan(plays: List[Dict[str, Any]], consensus: bool = True) -> List[PlanStep]:
    steps: List[PlanStep] = []
    for i, play in enumerate(plays):
        steps.append(PlanStep(
            description=f"Evaluate play {play['id']}: {play.get('desc', '')[:80]}",
            intent="evaluate", deliverable="per-play film note (JSON)", priority=i + 1, stage=0,
            engine_hint="vision image",
            payload={"kind": "film_play", "play": play, "images": play.get("sheets", []), "json": True, "consensus": consensus, "max_tokens": 4000, "timeout": 420},
        ))
    steps.append(PlanStep(
        description="Season rollup: strengths, fix-first, drills, reel order", intent="synthesize", deliverable="film report",
        priority=len(steps) + 1, stage=1, depends_on=[s.id for s in steps], payload={"kind": "film_rollup", "handler": "film_rollup"},
    ))
    return steps


def build_outreach_plan(targets: List[Dict[str, Any]], facts: Dict[str, Any]) -> List[PlanStep]:
    ctx = PlanStep(description="Collect verified athlete facts and program needs", intent="context", deliverable="facts", priority=1, stage=0,
                   payload={"kind": "facts", "handler": "facts", "facts": facts})
    drafts: List[PlanStep] = []
    for i, t in enumerate(targets):
        drafts.append(PlanStep(
            description=f"Draft outreach to {t['program']['name']}", intent="draft", deliverable="email + subject + DM (JSON)",
            priority=i + 2, stage=1, depends_on=[ctx.id], engine_hint="narrative email",
            payload={"kind": "draft", "target": t, "facts": facts, "json": True, "max_tokens": 16000, "timeout": 300},
        ))
    guard = PlanStep(description="Guardrails: recipient, claims, length, cadence", intent="quality", deliverable="checked drafts",
                     priority=len(drafts) + 2, stage=2, depends_on=[d.id for d in drafts], payload={"kind": "guard", "handler": "guardrails", "facts": facts})
    rep = PlanStep(description="Run report", intent="synthesize", deliverable="agent run report", priority=len(drafts) + 3, stage=3,
                   depends_on=[guard.id], payload={"kind": "report", "handler": "outreach_report"})
    return [ctx, *drafts, guard, rep]
