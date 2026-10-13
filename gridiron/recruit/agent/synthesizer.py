"""Synthesis (Trinity synthesizer.py) + the domain rollups.

synthesize_response : the original text summary of a run (step / engine / confidence / latency / citations).
film_rollup         : season view across plays -> strengths, fix-first, drills, reel order, per-game, markdown.
outreach_report     : what was drafted, what was held back and why."""
from __future__ import annotations
import datetime
from collections import Counter, defaultdict
from typing import Any, Dict, List

from .models import PlanStep, SubtaskResult, SECTION_KEYS


def synthesize_response(prompt: str, steps: List[PlanStep], results: Dict[str, SubtaskResult]) -> str:
    lines = ["Gridiron agent run", "------------------", f"Task: {prompt.strip()}\n"]
    for step in steps:
        res = results.get(step.id)
        if not res:
            continue
        lines.append(f"Step: {step.intent.upper()} ({step.description})")
        lines.append(f"Engine: {res.engine} | Confidence: {res.confidence:.2f} | Latency: {res.latency:.2f}s" + (f" | Error: {res.error}" if res.error else ""))
        if res.citations:
            lines.append("Citations: " + "; ".join(res.citations))
        lines.append("")
    lines.append("Advisory output: every note carries the frames / facts it was derived from; a coach or parent checks the call.")
    return "\n".join(lines).strip()


def film_rollup(athlete: Dict[str, Any], notes: List[Dict[str, Any]]) -> Dict[str, Any]:
    good = [n for n in notes if n.get("scores") and n.get("graded", True)]
    ungraded = [n for n in notes if n not in good]
    strengths: Counter = Counter()
    fixes: Counter = Counter()
    fix_detail: Dict[str, str] = {}
    drills: Dict[str, Dict[str, Any]] = {}
    drill_votes: Counter = Counter()
    by_game: Dict[str, List[float]] = defaultdict(list)
    label: Dict[str, str] = {}          # case-insensitive key -> first-seen display label
    def key(s: str) -> str:
        s = (s or "").strip(); k = " ".join(s.lower().split())
        if k: label.setdefault(k, s)
        return k
    for n in good:
        for pp in n.get("prime_points", []) or []:
            if float(pp.get("score", 0) or 0) >= 0.8 and pp.get("severity") == "low":
                k = key(pp.get("metric")); strengths[k] += 1 if k else 0
        for ki in n.get("key_issues", []) or []:
            k = key(ki.get("name"))
            if k:
                fixes[k] += 1
                fix_detail.setdefault(k, ki.get("description", ""))
        for d in n.get("drills", []) or []:
            k = key(d.get("name"))
            if k:
                drill_votes[k] += 1
                drills.setdefault(k, d)
        by_game[n.get("game", "")].append(float(n["scores"].get("overall", 0) or 0))
    strengths.pop("", None); fixes.pop("", None)
    openers = sorted([n for n in good if (n.get("show_coaches") or {}).get("reel_opener")], key=lambda n: -float(n["scores"].get("overall", 0) or 0))
    avg = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    rollup = {
        "athleteId": athlete["id"], "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "plays": len(notes), "evaluated": len(good),
        "ungraded": [{"playId": n["playId"], "why": (n.get("error") or (n.get("visibility") or {}).get("limits") or "no scores")[:160]} for n in ungraded],
        "overall": avg([float(n["scores"].get("overall", 0) or 0) for n in good]),
        "scores": {k: avg([float((n["scores"] or {}).get(k) or 0) for n in good if (n["scores"] or {}).get(k) is not None]) for k in ("decision", "accuracy", "mechanics", "mobility")},
        "strengths": [{"metric": label.get(m, m), "plays": c} for m, c in strengths.most_common(3)],
        "fixFirst": [{"name": label.get(k, k), "plays": c, "description": fix_detail.get(k, "")} for k, c in fixes.most_common(3)],
        "drills": [dict(drills[k], name=label.get(k, k), votes=c) for k, c in drill_votes.most_common(5)],
        "reelOrder": [{"playId": n["playId"], "desc": n.get("desc", ""), "overall": n["scores"].get("overall")} for n in openers[:6]],
        "byGame": {g: {"plays": len(v), "overall": avg(v)} for g, v in by_game.items()},
        "engines": sorted({e for n in good for e in (n.get("engines") or [])}),
        "confidence": avg([float(n.get("confidence") or 0) for n in good]),
        "advisory": True,
    }
    rollup["markdown"] = film_markdown(athlete, rollup, good)
    return rollup


def film_markdown(athlete: Dict[str, Any], r: Dict[str, Any], notes: List[Dict[str, Any]]) -> str:
    L = [f"# AI film notes (advisory) — {athlete.get('name')} #{athlete.get('jersey')} {athlete.get('position')} {athlete.get('gradYear')}",
         f"_Generated {r['generatedAt'][:16]}Z · {r['evaluated']}/{r['plays']} plays · engines {', '.join(r['engines']) or 'none'} · confidence {r['confidence']}_", "",
         f"**Overall {r['overall']}** · decision {r['scores'].get('decision')} · accuracy {r['scores'].get('accuracy')} · mechanics {r['scores'].get('mechanics')} · mobility {r['scores'].get('mobility')}", "",
         "## Strengths (what to show coaches first)"]
    L += [f"- {s['metric']} — strong on {s['plays']} play(s)" for s in r["strengths"]] or ["- (none scored ≥0.8 yet)"]
    L += ["", "## Fix first"]
    L += [f"- **{f['name']}** ({f['plays']} play(s)) — {f['description']}" for f in r["fixFirst"]] or ["- (no recurring issue)"]
    L += ["", "## Drills"]
    L += [f"- **{d.get('name')}** — fixes: {d.get('fixes','')}. {d.get('instructions','')} ({d.get('reps','')})" for d in r["drills"]]
    L += ["", "## Suggested reel order (plays the evaluator flagged as openers)"]
    L += [f"{i}. {o['playId']} — {o['desc']} (overall {o['overall']})" for i, o in enumerate(r["reelOrder"], 1)] or ["- (none flagged)"]
    L += ["", "## Per play"]
    for n in sorted(notes, key=lambda n: -float(n["scores"].get("overall", 0) or 0)):
        L.append(f"### {n['playId']} · {n.get('game','')} · overall {n['scores'].get('overall')}")
        L.append(f"_{n.get('desc','')}_  ")
        for sk in SECTION_KEYS:
            sec = (n.get("sections") or {}).get(sk) or {}
            for it in sec.get("items", [])[:3]:
                L.append(f"- **{sec.get('title','')} · {it.get('item','')}**: {it.get('observation','')} → _{it.get('recommendation','')}_")
        for ki in n.get("key_issues", [])[:3]:
            L.append(f"- Issue {ki.get('priority')}: **{ki.get('name')}** — {ki.get('description','')}")
        sc = n.get("show_coaches") or {}
        if sc.get("note"):
            L.append(f"- Show coaches: {sc['note']}{' · reel opener' if sc.get('reel_opener') else ''}")
        vis = n.get("visibility") or {}
        if vis.get("limits"):
            L.append(f"- Visibility limits: {vis['limits']} (confidence {vis.get('confidence')})")
        L.append("")
    return "\n".join(L)


def outreach_report(athlete: Dict[str, Any], drafts: List[Dict[str, Any]], held: List[Dict[str, Any]], board_size: int) -> Dict[str, Any]:
    ok = [d for d in drafts if d.get("status") == "draft"]
    review = [d for d in drafts if d.get("status") == "needs_review"]
    md = [f"# Agent run — {athlete.get('name')} — outreach drafts", "",
          f"Board considered: {board_size} · drafted: {len(ok)} · needs review: {len(review)} · held back: {len(held)}", "",
          "Nothing was sent. Drafts wait for a batch approval and a sender mailbox.", "", "## Drafts"]
    md += [f"- {d['school']} ({d.get('division','')}) → {d.get('toName','')} <{d.get('to','')}> · {d.get('engine','')} · {d['subject']}" for d in ok]
    if review:
        md += ["", "## Needs review"] + [f"- {d['school']}: {', '.join(d.get('flags', []))}" for d in review]
    if held:
        md += ["", "## Held back"] + [f"- {h['school']}: {h['reason']}" for h in held]
    return {"drafted": len(ok), "needsReview": len(review), "held": len(held), "boardSize": board_size, "markdown": "\n".join(md)}
