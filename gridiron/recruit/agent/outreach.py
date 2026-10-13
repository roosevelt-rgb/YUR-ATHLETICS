"""Recruiting outreach drafter: board -> per-program email/subject/DM from verified facts only -> guardrails -> drafts + run report.

Nothing is sent. Drafts land in Mongo `drafts` (status draft | needs_review) and show on the player card's Agent tab; sending
needs a sender mailbox on the athlete record and a per-batch yes from the family.

usage: python -P agent/outreach.py --athlete <athlete-id> [--limit 25] [--follow-up] [--engines xai] [--dry]
"""
from __future__ import annotations
import argparse
import datetime
import json
import pathlib
import re
import sys
import uuid
from typing import Any, Dict, List

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from agent.planner import build_outreach_plan
from agent.scheduler import WorkloadOrchestrator
from agent.synthesizer import outreach_report
from agent import store

FOLLOW_UP_DAYS = (10, 24)
ROLE_PREF = ["recruiting_coordinator", "player_personnel", "qb_coach", "offensive_coordinator", "head_coach"]

SYSTEM = ("You write recruiting emails for a high-school quarterback, in his own voice: first person, respectful, specific, no hype "
          "words (elite, best, star). Use ONLY the facts in the JSON you are given. Never state a stat, height, weight, GPA, time, "
          "award or offer that is not in the facts. One recipient. Plain text, no markdown, no placeholders. Return JSON only.")

PROMPT = """ATHLETE FACTS (verified): {facts}
PROGRAM FACTS: {program}
CONTACT: {contact}
MODE: {mode}

Write the email: 120-160 words. Open with who I am and my class. Include ONE personalised line drawn from the program facts
(quarterback spots that may be opening for my class, Texas / DFW roster footprint, a listed camp, or the contact's role) in plain
words - say "it looks like you may have quarterback spots opening up for the <my class year> class" with my class year from the facts, never "net openings". The main film is
the FIRST entry in facts.film (the full highlight reel): give its title and length with the Hudl link, and do not list the other
cuts. Do not say whether this is a first email. Ask for a film review and a camp or visit opportunity, and close with name,
school, class, position, jersey.
{mode_note}
Return JSON: {{"subject": "<= 60 chars", "body": "...", "dm": "<= 280 chars, same facts, for an X/Twitter DM"}}"""


def athlete_facts(a: Dict[str, Any]) -> Dict[str, Any]:
    f = {"name": a.get("name"), "jersey": a.get("jersey"), "position": a.get("position"), "throws": a.get("throws"), "gradYear": a.get("gradYear"),
         "highSchool": a.get("highSchool"), "city": a.get("city"), "state": a.get("state"), "uil": a.get("uil"),
         "hudlUrl": (a.get("media") or {}).get("hudlUrl"), "teamSite": (a.get("media") or {}).get("teamSite"),
         "film": [{k: v for k, v in x.items() if k in ("title", "length", "plays", "touchdowns", "games", "hostedUrl")} for x in (a.get("film") or []) if not (x.get("notes") or "").startswith("song")],
         "stats": a.get("stats") or []}
    for k in ("heightInches", "weightLbs", "gpa"):
        if a.get(k):
            f[k] = a[k]
    fs = a.get("filmSummary") or {}
    if fs.get("strengths"):
        f["filmStrengths"] = [s["metric"] for s in fs["strengths"][:3]]   # from the evaluator, advisory; only metric names
    return f


def program_facts(c: Dict[str, Any], pos: str, hs_class: str) -> Dict[str, Any]:
    prof = ((c.get("rosterProfile") or {}).get("byPosition") or {}).get(pos) or {}
    openings = (prof.get("openingsByHsClass") or {}).get(hs_class, 0)
    known = (prof.get("commitsKnown") or {}).get(hs_class)
    committed = (prof.get("committedByHsClass") or {}).get(hs_class, 0) if known else None
    fp = (c.get("rosterProfile") or {}).get("footprint") or {}
    camps = [{"name": k.get("name") or k.get("title"), "date": k.get("date"), "url": k.get("url")} for k in (c.get("camps") or [])[:3]]
    return {"name": c["metadata"]["name"], "division": c["metadata"].get("division"), "conference": c["metadata"].get("conference"), "state": c["metadata"].get("state"),
            "qbRoom": prof.get("count"), "projectedOpenings": openings, "knownCommits": committed, "netOpenings": max(0, openings - (committed or 0)),
            "texasPlayers": fp.get("texas"), "dfwPlayers": fp.get("dfw"), "camps": camps}


def build_board(a: Dict[str, Any], limit: int, follow_up: bool) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    d = store.db()
    pos, hs_class = a.get("position", "QB"), str(a.get("gradYear"))
    divs = set((a.get("preferences") or {}).get("divisions") or [])
    touches = list(d.touches.find({"athleteId": a["id"]}, {"_id": 0}))
    last_out: Dict[str, str] = {}; replied = set(); bounced_schools = set()
    for t in touches:
        if t.get("direction") == "out" and t.get("at"):
            last_out[t["school"]] = max(last_out.get(t["school"], ""), t["at"])
        if t.get("direction") == "in":
            replied.add(t["school"])
    bounced = {c["email"].lower() for c in d.coaches.find({"emailStatus": "bounced", "email": {"$ne": ""}}, {"email": 1})}
    today = datetime.date.today()
    targets, held = [], []
    # QB Match v1 board (recruit/agent/qb_match.py --score --write): order by fit, hold run-first offenses and closed classes
    matches = {m["school"]: m for m in d.matches.find({"athleteId": a["id"]}, {"_id": 0, "school": 1, "match": 1, "tier": 1, "hold": 1, "reasons": 1})}
    q = {f"rosterProfile.byPosition.{pos}": {"$exists": True}}
    for c in d.colleges.find(q, {"_id": 0}):
        name = c["metadata"]["name"]; div = c["metadata"].get("division")
        if divs and div not in divs:
            continue
        m = matches.get(name)
        if m and m.get("hold"):
            held.append({"school": name, "reason": f"match hold: {m['hold']} (MATCH {m['match']})"}); continue
        pf = program_facts(c, pos, hs_class)
        staff = list(d.coaches.find({"college": name, "email": {"$exists": True, "$nin": ["", None]}}, {"_id": 0}))
        staff = [s for s in staff if "@" in str(s.get("email", "")) and s["email"].lower() not in bounced and s.get("emailStatus") != "bounced"]
        contact = next((s for r in ROLE_PREF for s in staff if s.get("role") == r), None) \
            or next((s for s in staff if s.get("role") not in ("other", "", None)), None) or (staff[0] if staff else None)
        mode = "first"
        if name in last_out:
            if name in replied:
                held.append({"school": name, "reason": "replied already; human follow-up"}); continue
            days = (today - datetime.date.fromisoformat(last_out[name][:10])).days if re.match(r"\d{4}-\d{2}-\d{2}", last_out[name]) else 0
            if not follow_up:
                held.append({"school": name, "reason": f"already emailed {last_out[name][:10]} ({days}d ago); run with --follow-up"}); continue
            if days < FOLLOW_UP_DAYS[0]:
                held.append({"school": name, "reason": f"emailed {last_out[name][:10]} ({days}d ago); follow-up window opens at day {FOLLOW_UP_DAYS[0]}"}); continue
            mode = "follow-up"
        if not contact:
            held.append({"school": name, "reason": "no verified staff email"}); continue
        tx = 1 if c["metadata"].get("state") == "TX" else 0
        targets.append({"program": pf, "contact": {"name": contact["name"], "title": contact.get("title", ""), "email": contact["email"], "role": contact.get("role", "")},
                        "mode": mode, "lastOut": last_out.get(name), "rank": (tx, pf["netOpenings"], pf.get("dfwPlayers") or 0),
                        "match": (m or {}).get("match"), "tier": (m or {}).get("tier"), "matchReason": ((m or {}).get("reasons") or [None])[0]})
    if not matches:      # no board yet: the old Texas / openings / DFW order
        targets.sort(key=lambda t: (-t["rank"][0], -t["rank"][1], -t["rank"][2]))
        return targets[:limit], held
    # weekly mix from the design: about 20% Reach, 48% Target, 32% Likely; never-contacted first, then highest MATCH
    by_tier = {k: sorted([t for t in targets if t["tier"] == k], key=lambda t: (t["mode"] != "first", -(t["match"] or 0)))
               for k in ("Likely", "Target", "Reach", "Fallback")}
    quota = {"Reach": round(limit * 0.20), "Likely": round(limit * 0.32)}
    quota["Target"] = limit - quota["Reach"] - quota["Likely"]
    picked = [t for k in ("Likely", "Target", "Reach") for t in by_tier[k][:quota[k]]]
    rest = sorted([t for t in targets if t not in picked], key=lambda t: (t["mode"] != "first", -(t["match"] or -1)))
    return (picked + rest)[:limit], held


def compose(step, _store):
    t = step.payload["target"]; facts = step.payload["facts"]
    mode_note = (f"This is a FOLLOW-UP to an email sent on {t.get('lastOut')} that got no reply: shorter (80-120 words), reference the earlier note once, add the newest film."
                 if t["mode"] == "follow-up" else "This is a FIRST contact.")
    return PROMPT.format(facts=json.dumps(facts), program=json.dumps(t["program"]), contact=json.dumps(t["contact"]), mode=t["mode"], mode_note=mode_note), SYSTEM


def template_draft(t: Dict[str, Any], f: Dict[str, Any]) -> Dict[str, str]:
    """Deterministic fallback when no engine answers (same facts, no claims)."""
    p, c = t["program"], t["contact"]
    film = next((x for x in f.get("film", []) if x.get("plays")), {})
    line = (f"I noticed {p['name']} projects {p['netOpenings']} open quarterback spot(s) for the {f['gradYear']} class" if p.get("netOpenings")
            else f"{p['name']} has {p.get('texasPlayers') or 0} Texas players on the roster, {p.get('dfwPlayers') or 0} from DFW")
    body = (f"Coach {c['name'].split()[-1]},\n\nMy name is {f['name']}, a {f['gradYear']} {'left-handed ' if f.get('throws') == 'left' else ''}quarterback at {f['highSchool']} in {f['city']}, {f['state']} (UIL {f['uil']['conference']}, District {f['uil']['footballDistrict']}). "
            f"{line}, and I would like to be considered for your program.\n\nMy film: {film.get('title', 'highlights')}{' (' + film['length'] + ')' if film.get('length') else ''} is on Hudl: {f.get('hudlUrl')}\n\n"
            f"I would appreciate any feedback on the film and information on your camps or a visit. Thank you for your time.\n\n{f['name']}\n{f['highSchool']} · Class of {f['gradYear']} · {f['position']} · #{f['jersey']}")
    return {"subject": f"{f['gradYear']} QB {f['name']} - {f['highSchool']} ({f['state']})"[:60], "body": body,
            "dm": f"Coach {c['name'].split()[-1]} - {f['name']}, {f['gradYear']} {'LH ' if f.get('throws') == 'left' else ''}QB, {f['highSchool']} ({f['state']}). Film: {f.get('hudlUrl')}"[:280]}


NUM_RX = re.compile(r"\d[\d,.'\"-]*")


def check_draft(body: str, mode: str, to_email: str, fact_blob: str, fact_nums: set, titles: List[str]) -> List[str]:
    """Deterministic guardrails. Film titles from the athlete's own record are exempt from the hype check ("2026 Best-of")."""
    flags = []
    words = len(body.split())
    lo, hi = (70, 140) if mode == "follow-up" else (100, 185)
    if not lo <= words <= hi: flags.append(f"length {words} words")
    if not to_email: flags.append("no recipient")
    for n in NUM_RX.findall(body):
        tok = n.strip(".,'\"-")
        if tok and tok not in fact_nums and not re.fullmatch(r"\d{4}", tok) and tok not in fact_blob:
            flags.append(f"unverified number {tok}")
    scrub = body
    for t in titles:
        scrub = scrub.replace(t, " ")
    scrub = re.sub(r"\bbest-of\b", " ", scrub, flags=re.I)
    if re.search(r"\b(elite|best|star|offer(ed)?|committed)\b", scrub, re.I): flags.append("hype/claim word")
    if body.count("@") > 1 or re.search(r"\bcc\b", body, re.I): flags.append("multiple recipients")
    if "[" in body or "{" in body: flags.append("placeholder")
    return flags


def guardrails(step, rstore, context):
    facts = step.payload["facts"]
    fact_blob = json.dumps(facts) + json.dumps(context["targets"])
    fact_nums = {n.strip(".,'\"-") for n in NUM_RX.findall(fact_blob)}
    titles = [f.get("title", "") for f in facts.get("film", []) if f.get("title")]
    drafts = []
    for s in context["draft_steps"]:
        r = rstore.get(s.id); t = s.payload["target"]
        data = (r.data if r and r.data and not r.data.get("_unparsed") else None) or {}
        engine = r.engine if r and not r.error and data else "template"
        if not data.get("body"):
            data = template_draft(t, facts)
        body = str(data.get("body", "")); subject = str(data.get("subject", ""))[:80]; dm = str(data.get("dm", ""))[:300]
        flags = check_draft(body, t["mode"], t["contact"].get("email", ""), fact_blob, fact_nums, titles)
        drafts.append({"id": "draft_" + uuid.uuid4().hex[:10], "athleteId": context["athlete"]["id"], "runId": context["run_id"], "school": t["program"]["name"],
                       "division": t["program"].get("division"), "to": t["contact"]["email"], "toName": t["contact"]["name"], "toTitle": t["contact"].get("title", ""),
                       "mode": t["mode"], "subject": subject, "body": body, "dm": dm, "engine": engine, "flags": flags,
                       "status": "needs_review" if flags else "draft", "factsUsed": sorted(k for k in facts if facts[k]), "programFacts": t["program"],
                       "createdAt": store.now_iso(), "approvedAt": None, "sentAt": None, "advisory": True})
    context["artifacts"]["drafts"] = drafts
    return {"text": f"{sum(1 for d in drafts if d['status']=='draft')} clean, {sum(1 for d in drafts if d['status']!='draft')} need review", "confidence": 1.0}


def report_handler(step, _store, context):
    rep = outreach_report(context["athlete"], context["artifacts"]["drafts"], context["held"], context["board_size"])
    context["artifacts"]["report"] = rep
    return {"text": rep["markdown"][:400], "confidence": 1.0}


def facts_handler(step, _store, context):
    return {"text": json.dumps(step.payload["facts"])[:300], "confidence": 1.0}


def draft(athlete_id: str, limit: int, follow_up: bool, engines: str | None, dry: bool, log=print) -> Dict[str, Any]:
    import os
    if engines:
        os.environ["AGENT_ENGINES"] = engines
    a = store.load_athlete(athlete_id)
    limit = limit or int((a.get("agent") or {}).get("maxSendsPerWeek") or 25)
    targets, held = build_board(a, limit, follow_up)
    facts = athlete_facts(a)
    run = {"id": "dry"} if dry else store.start_run(athlete_id, "recruiting-outreach", {"limit": limit, "followUp": follow_up, "engines": engines})
    steps = build_outreach_plan(targets, facts)
    context = {"athlete": a, "compose": compose, "artifacts": {}, "targets": targets, "held": held, "board_size": len(targets) + len(held),
               "draft_steps": [s for s in steps if s.payload.get("kind") == "draft"], "run_id": run["id"]}
    orch = WorkloadOrchestrator(handlers={"facts": facts_handler, "guardrails": guardrails, "outreach_report": report_handler}, workers=3, log=log)
    report = orch.run("recruiting-outreach " + athlete_id, steps, context)
    drafts = context["artifacts"].get("drafts", []); rep = context["artifacts"].get("report", {})
    outdir = HERE.parent / "data" / "drafts" / athlete_id; outdir.mkdir(parents=True, exist_ok=True)
    stamp = store.now_iso()[:10]
    (outdir / f"drafts_{stamp}.json").write_text(json.dumps(drafts, indent=1), encoding="utf-8")
    (outdir / f"run_{stamp}.md").write_text(rep.get("markdown", ""), encoding="utf-8")
    if not dry:
        store.save_drafts(drafts)
        store.finish_run(run, "done", {"board": len(targets), "held": len(held), "drafted": rep.get("drafted"), "needsReview": rep.get("needsReview")}, rep.get("markdown", ""), report.timeline)
    log(f"{len(targets)} targets, {rep.get('drafted')} drafts, {rep.get('needsReview')} need review, {len(held)} held; files in {outdir}")
    return {"drafts": drafts, "report": rep, "run": run, "held": held}


def recheck(athlete_id: str, log=print) -> None:
    """Re-run the guardrails over the athlete's unapproved drafts in Mongo (no model calls); updates flags + status in place."""
    a = store.load_athlete(athlete_id); facts = athlete_facts(a)
    titles = [f.get("title", "") for f in facts.get("film", []) if f.get("title")]
    d = store.db(); n_ok = n_rev = 0
    for x in d.drafts.find({"athleteId": athlete_id, "status": {"$in": ["draft", "needs_review"]}}):
        fact_blob = json.dumps(facts) + json.dumps(x.get("programFacts") or {})
        fact_nums = {n.strip(".,'\"-") for n in NUM_RX.findall(fact_blob)}
        flags = check_draft(x.get("body", ""), x.get("mode", "first"), x.get("to", ""), fact_blob, fact_nums, titles)
        status = "needs_review" if flags else "draft"
        d.drafts.update_one({"_id": x["_id"]}, {"$set": {"flags": flags, "status": status}})
        n_ok += status == "draft"; n_rev += status != "draft"
    log(f"rechecked: {n_ok} draft, {n_rev} need review")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--athlete", default="quinn-placeholder"); ap.add_argument("--limit", type=int, default=0); ap.add_argument("--follow-up", action="store_true")
    ap.add_argument("--engines", default=""); ap.add_argument("--dry", action="store_true"); ap.add_argument("--board", action="store_true"); ap.add_argument("--recheck", action="store_true")
    a = ap.parse_args()
    if a.recheck:
        return recheck(a.athlete)
    if a.board:
        ath = store.load_athlete(a.athlete); t, h = build_board(ath, a.limit or 25, a.follow_up)
        for x in t: print(x["mode"], "|", x["program"]["name"], x["program"]["division"], x["program"]["state"], "net", x["program"]["netOpenings"], "TX/DFW", x["program"]["texasPlayers"], x["program"]["dfwPlayers"], "->", x["contact"]["name"], x["contact"]["role"])
        print(len(h), "held; e.g.", h[:5]); return
    draft(a.athlete, a.limit, a.follow_up, a.engines or None, a.dry)


if __name__ == "__main__":
    main()
