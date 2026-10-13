"""Multi-engine consensus (SwingVision analysis.js: aggregateResults / calculateConsensusScore / findCommonRecommendations /
aggregateMetric / calculateConfidence), applied to per-play film notes.

With one engine the note passes through and confidence = engine visibility confidence * 0.9 (single-witness discount).
With 2+ engines: overall/section scores = median, key issues agreed by 2+ engines first, prime points merged by point code,
confidence = 100 - 10 * stdev(overall scores) (clamped), as in the original."""
from __future__ import annotations
import re
import statistics
from collections import Counter, defaultdict
from typing import Any, Dict, List

from .models import SECTION_KEYS, SECTION_TITLES, SEVERITIES


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", "", (s or "").lower()).strip()


def consensus_score(values: List[float]) -> float:
    vals = [float(v) for v in values if isinstance(v, (int, float))]
    if not vals:
        return 0.0
    return float(statistics.median(vals))


def confidence_from_agreement(overalls: List[float]) -> float:
    vals = [float(v) for v in overalls if isinstance(v, (int, float))]
    if len(vals) < 2:
        return 0.0
    sd = statistics.pstdev(vals)
    return max(0.0, min(1.0, (100.0 - sd * 10.0) / 100.0))


def _common(items: List[List[Dict[str, Any]]], key: str, min_votes: int) -> List[Dict[str, Any]]:
    """Items (dicts) whose normalized `key` text appears in >= min_votes engines; keeps the first phrasing, counts votes."""
    votes: Counter = Counter()
    first: Dict[str, Dict[str, Any]] = {}
    for engine_items in items:
        seen = set()
        for it in engine_items or []:
            k = _norm(str(it.get(key, "")))[:60]
            if not k or k in seen:
                continue
            seen.add(k)
            votes[k] += 1
            first.setdefault(k, dict(it))
    out = []
    for k, n in votes.most_common():
        if n >= min_votes:
            d = dict(first[k]); d["votes"] = n; out.append(d)
    return out


def merge_notes(play: Dict[str, Any], notes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """notes = one parsed note per engine (each already in the empty_play_note shape with `engine` set)."""
    good = [n for n in notes if n and n.get("scores")]
    base = dict(play)
    if not good:
        base.update({"engines": [n.get("engine", "?") for n in notes], "confidence": 0.0})
        return base
    if len(good) == 1:
        n = dict(good[0])
        n["engines"] = [n.get("engine", "?")]
        n["confidence"] = round(float((n.get("visibility") or {}).get("confidence") or 0.6) * 0.9, 2)
        return n

    merged = dict(good[0])
    merged["engines"] = [n.get("engine", "?") for n in good]
    # scores: median per key
    keys = set().union(*[set((n.get("scores") or {}).keys()) for n in good])
    merged["scores"] = {k: round(consensus_score([(n.get("scores") or {}).get(k) for n in good]), 1) for k in keys}
    # sections: union of items, ordered by how many engines raised the same item
    sections = {}
    for sk in SECTION_KEYS:
        items = _common([((n.get("sections") or {}).get(sk) or {}).get("items", []) for n in good], "item", 1)
        sections[sk] = {"title": SECTION_TITLES[sk], "items": items[:6]}
    merged["sections"] = sections
    # key issues: agreed by 2+ first, then singles, renumbered
    agreed = _common([n.get("key_issues", []) for n in good], "name", 2)
    singles = [i for i in _common([n.get("key_issues", []) for n in good], "name", 1) if i.get("votes", 0) < 2]
    issues = (agreed + singles)[:3]
    for i, it in enumerate(issues, 1):
        it["priority"] = i
    merged["key_issues"] = issues
    merged["drills"] = (_common([n.get("drills", []) for n in good], "name", 2) + [d for d in _common([n.get("drills", []) for n in good], "name", 1) if d.get("votes", 0) < 2])[:5]
    # prime points: per point code, worst severity wins, scores averaged
    by_code: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for n in good:
        for pp in n.get("prime_points", []) or []:
            by_code[pp.get("point_code", "")].append(pp)
    pps = []
    for code, lst in by_code.items():
        sev = max((p.get("severity", "low") for p in lst), key=lambda s: SEVERITIES.index(s) if s in SEVERITIES else 0)
        pps.append({"point_code": code, "metric": lst[0].get("metric", ""), "score": round(sum(float(p.get("score", 0) or 0) for p in lst) / len(lst), 2),
                    "severity": sev, "insight": " | ".join(dict.fromkeys(p.get("insight", "") for p in lst if p.get("insight"))), "frame_label": lst[0].get("frame_label", ""), "votes": len(lst)})
    merged["prime_points"] = sorted(pps, key=lambda p: p["point_code"])
    merged["show_coaches"] = {"note": " / ".join(dict.fromkeys((n.get("show_coaches") or {}).get("note", "") for n in good if (n.get("show_coaches") or {}).get("note"))),
                              "reel_opener": sum(1 for n in good if (n.get("show_coaches") or {}).get("reel_opener")) * 2 > len(good)}
    merged["visibility"] = {"limits": " / ".join(dict.fromkeys((n.get("visibility") or {}).get("limits", "") for n in good if (n.get("visibility") or {}).get("limits"))),
                            "confidence": round(sum(float((n.get("visibility") or {}).get("confidence") or 0) for n in good) / len(good), 2)}
    merged["confidence"] = round(confidence_from_agreement([(n.get("scores") or {}).get("overall") for n in good]), 2)
    return merged
