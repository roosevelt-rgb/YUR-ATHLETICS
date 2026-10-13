r"""Per-athlete agent for Gridiron Scout: film evaluator + recruiting outreach.

Lineage (ported 2026-10-10 from earlier YUR projects, nothing invented):
- orchestration/{models,planner,scheduler,skill_registry,result_store,synthesizer}.py
  from the TrinityAI orchestration package (stage-batched, dependency-gated plan runner with provenance)
- the six-section structured analysis prompt + section parser from the GolfSnapPro swing-report service (trinity_client.py)
- consensus math (median score, 2+ engine agreement, variance -> confidence) from SWING-VISION-AI frontend/assets/js/analysis.js
- display contract (frames by point code, prime points with severity, top priorities, confidence) from the
  ProVision HUD swing-analysis types.ts

Engines come from recruit/llm.py (Anthropic -> OpenAI -> xAI -> Google, whichever key answers). Every output is stamped
with provider, inputs and an `advisory: true` flag; nothing here sends email.
"""
from .scheduler import WorkloadOrchestrator  # noqa: F401
