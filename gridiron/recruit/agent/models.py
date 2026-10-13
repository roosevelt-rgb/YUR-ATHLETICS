"""Data models. PlanStep / SubtaskResult / ExecutionReport are the Trinity orchestration models (ported as-is, plus `inputs`
for provenance). The film contract mirrors ProVision's SwingResults with football point codes."""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional
import uuid


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


@dataclass
class PlanStep:
    """A decomposed micro-task (Trinity)."""
    description: str
    intent: str
    deliverable: str
    priority: int = 1
    depends_on: List[str] = field(default_factory=list)
    engine_hint: Optional[str] = None
    id: str = field(default_factory=lambda: _gen_id("step"))
    stage: int = 0                       # stages allow batched execution
    payload: Dict[str, Any] = field(default_factory=dict)   # domain inputs (play, frames, program, facts)


@dataclass
class SubtaskResult:
    """Execution outcome for one step (Trinity) + provenance."""
    step_id: str
    engine: str
    text: str
    latency: float
    confidence: float
    citations: List[str] = field(default_factory=list)
    error: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)      # parsed JSON when the step produces structured output
    inputs: Dict[str, Any] = field(default_factory=dict)    # what the engine saw (frame files, fact keys, sha)


@dataclass
class ExecutionReport:
    prompt: str
    steps: List[PlanStep]
    results: Dict[str, SubtaskResult]
    final_output: str
    timeline: List[Dict[str, Any]] = field(default_factory=list)
    artifacts: Dict[str, Any] = field(default_factory=dict)  # domain outputs (film notes, drafts, rollup)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "prompt": self.prompt,
            "steps": [asdict(s) for s in self.steps],
            "results": {k: asdict(v) for k, v in self.results.items()},
            "final_output": self.final_output,
            "timeline": self.timeline,
            "artifacts": self.artifacts,
        }


# ---- film contract (ProVision types.ts, football) ----
# Point codes replace golf P1..P14 with the QB play phases we can actually see on a frame sheet.
POINT_CODES = [
    ("S1", "Pre-snap"), ("S2", "Snap / mesh"), ("S3", "Drop"), ("S4", "Set / hitch"),
    ("S5", "Release"), ("S6", "Ball in air"), ("S7", "Result / finish"),
]
SECTION_KEYS = ["pre_snap", "drop_footwork", "pocket_pressure", "release_arm", "ball_decision"]
SECTION_TITLES = {
    "pre_snap": "PRE-SNAP & SETUP",
    "drop_footwork": "DROP & FOOTWORK",
    "pocket_pressure": "POCKET & PRESSURE",
    "release_arm": "RELEASE & ARM",
    "ball_decision": "BALL PLACEMENT & DECISION",
}
SEVERITIES = ("low", "moderate", "high")


def empty_play_note(play: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "playId": play["id"], "reelOrder": play.get("reelOrder"), "game": play.get("game", ""), "desc": play.get("desc", ""),
        "td": bool(play.get("td")), "sourceWindow": play.get("window"),
        "frames": play.get("frames", []),           # [{point_code?, label, frame_url}]
        "sections": {k: {"title": SECTION_TITLES[k], "items": []} for k in SECTION_KEYS},
        "key_issues": [], "drills": [], "show_coaches": {"note": "", "reel_opener": False},
        "prime_points": [], "scores": {}, "visibility": {"limits": "", "confidence": 0.0},
        "engines": [], "confidence": 0.0, "advisory": True,
    }
