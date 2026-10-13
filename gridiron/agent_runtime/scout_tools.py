"""Scout toolbelt for the per-athlete agent, registered natively into the IntelliFlow `yur_harness` ToolRegistry.

Risk levels follow the harness gate (agent._authorize):
  read    -> always allowed (database lookups, public web reads, MaxPreps check, browser_open)
  write   -> auto-approved in autonomous mode; LOCAL and reversible (drafts, content, strategy, page sections; every
             page change keeps a history row)
  execute -> ALWAYS waits for a human approval in the console (browser_act on a live site, email_send)

Browser: one Playwright Chromium per runtime, persistent profile at agent_runtime/browser_profile (so a human can log in
once with `python agent_runtime/browser_login.py`; the agent never types passwords). Every navigation/action writes
agent_runtime/live/latest.png + latest.json, which the Gridiron Scout console shows as the agent's side browser.
No stealth / bot-detection evasion and no CAPTCHA solving: sites that block automation are reported, not worked around.
"""
from __future__ import annotations

import asyncio
import datetime
import json
import os
import pathlib
import re
import signal
import smtplib
import sys
import uuid
from email.message import EmailMessage
from typing import Any

import httpx
from pymongo import MongoClient

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
RECRUIT = REPO / "recruit"
LIVE = HERE / "live"
PROFILE = HERE / "browser_profile"
sys.path.insert(0, str(RECRUIT))

_db = None
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def db():
    global _db
    if _db is None:
        _db = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"), serverSelectionTimeoutMS=5000)[os.environ.get("MONGO_DB", "gridiron")]
    return _db


def now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def clean(value: Any) -> Any:
    """JSON-safe copy (ObjectId/datetime -> str, NaN -> None) so the harness 'data' result contract accepts it."""
    def fix(x):
        if isinstance(x, float) and x != x:
            return None
        if isinstance(x, dict):
            return {str(k): fix(v) for k, v in x.items() if k != "_id"}
        if isinstance(x, list):
            return [fix(v) for v in x]
        return x
    return fix(json.loads(json.dumps(value, default=str)))


def _athlete(aid: str) -> dict:
    a = db().athletes.find_one({"id": aid}, {"_id": 0})
    if not a:
        raise ValueError(f"unknown athlete {aid}")
    return a


# ------------------------------------------------------------------ URL guard (model-chosen URLs are untrusted)
import ipaddress
import socket
from urllib.parse import urlsplit


def _public_host(host: str) -> bool:
    """True only if every address the host resolves to is a public unicast address."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
                or ip.is_unspecified or (ip.version == 6 and ip.ipv4_mapped and not _public_ip(ip.ipv4_mapped))):
            return False
    return True


def _public_ip(ip) -> bool:
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified)


def check_url(url: str) -> str:
    """Allow only http(s) URLs whose host resolves to public addresses (no file:, data:, chrome:, localhost, LAN, metadata)."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("only public http(s) URLs are allowed")
    if parts.username or parts.password:
        raise ValueError("URLs with embedded credentials are not allowed")
    if not _public_host(parts.hostname):
        raise ValueError(f"host {parts.hostname} is not a public internet address")
    return url


async def _route_guard(route) -> None:
    """Re-check every request the page makes (redirects, frames, subresources) so a public page cannot pull from local hosts."""
    url = route.request.url
    parts = urlsplit(url)
    if parts.scheme in ("data", "blob", "about"):
        return await route.continue_()
    try:
        ok = parts.scheme in ("http", "https") and bool(parts.hostname) and await asyncio.to_thread(_public_host, parts.hostname)
    except Exception:
        ok = False
    await (route.continue_() if ok else route.abort("blockedbyclient"))


# ------------------------------------------------------------------ browser (shared, persistent profile)
class Browser:
    def __init__(self) -> None:
        self.pw = None
        self.ctx = None
        self.page = None
        self.lock = asyncio.Lock()

    async def ensure(self):
        if self.page and not self.page.is_closed():
            return self.page
        from playwright.async_api import async_playwright
        PROFILE.mkdir(parents=True, exist_ok=True)
        self.pw = await async_playwright().start()
        self.ctx = await self.pw.chromium.launch_persistent_context(str(PROFILE), headless=os.environ.get("SCOUT_BROWSER_HEADED") != "1",
                                                                    viewport={"width": 1280, "height": 860}, user_agent=UA)
        await self.ctx.route("**/*", _route_guard)
        self.page = self.ctx.pages[0] if self.ctx.pages else await self.ctx.new_page()
        return self.page

    async def snapshot(self, action: str, task_id: str) -> dict:
        page = self.page
        LIVE.mkdir(parents=True, exist_ok=True)
        shot = f"shot_{datetime.datetime.now().strftime('%H%M%S_%f')}.png"
        await page.screenshot(path=str(LIVE / shot), full_page=False)
        (LIVE / "latest.png").write_bytes((LIVE / shot).read_bytes())
        meta = {"url": page.url, "title": await page.title(), "action": action, "task_id": task_id, "at": now(), "shot": shot}
        (LIVE / "latest.json").write_text(json.dumps(meta), encoding="utf-8")
        with (LIVE / "history.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(meta) + "\n")
        shots = sorted(LIVE.glob("shot_*.png"))
        for old in shots[:-60]:
            old.unlink(missing_ok=True)
        return meta

    async def page_text(self, limit: int = 12000) -> dict:
        page = self.page
        text = await page.evaluate("() => document.body ? document.body.innerText : ''")
        links = await page.evaluate("""() => Array.from(document.querySelectorAll('a[href]')).slice(0, 400)
            .map(a => ({text: (a.innerText || '').trim().slice(0, 80), href: a.href})).filter(l => l.text && l.href.startsWith('http'))""")
        emails = sorted(set(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text)))
        return {"text": re.sub(r"\n{3,}", "\n\n", text)[:limit], "links": links[:150], "emails": emails[:60]}


BROWSER = Browser()


# ------------------------------------------------------------------ READ tools
async def scout_athlete(ctx, args):
    a = await asyncio.to_thread(_athlete, args["athlete_id"])
    a.pop("film", None) if args.get("brief") else None
    return clean({"athlete": a})


async def scout_board(ctx, args):
    def run():
        a = _athlete(args["athlete_id"]); pos = a.get("position", "QB"); cls = str(a.get("gradYear"))
        q: dict = {f"rosterProfile.byPosition.{pos}": {"$exists": True}}
        if args.get("division"): q["metadata.division"] = args["division"]
        if args.get("state"): q["metadata.state"] = args["state"]
        contacted = {t["school"] for t in db().touches.find({"athleteId": a["id"]}, {"school": 1})}
        rows = []
        for c in db().colleges.find(q, {"_id": 0}):
            prof = c["rosterProfile"]["byPosition"][pos]; fp = c["rosterProfile"].get("footprint") or {}
            opens = (prof.get("openingsByHsClass") or {}).get(cls, 0)
            known = (prof.get("commitsKnown") or {}).get(cls); com = (prof.get("committedByHsClass") or {}).get(cls, 0) if known else None
            rows.append({"program": c["metadata"]["name"], "division": c["metadata"].get("division"), "state": c["metadata"].get("state"),
                         "conference": c["metadata"].get("conference"), "roomSize": prof.get("count"), "projectedOpen": opens,
                         "knownCommits": com, "netOpen": max(0, opens - (com or 0)), "heightBand": prof.get("heightIn"),
                         "texasPlayers": fp.get("texas"), "dfwPlayers": fp.get("dfw"), "contacted": c["metadata"]["name"] in contacted,
                         "camps": [k.get("name") or k.get("url") for k in (c.get("camps") or [])[:3]]})
        rows.sort(key=lambda r: (-(r["state"] == "TX"), -r["netOpen"], -(r["dfwPlayers"] or 0)))
        return {"position": pos, "class": cls, "total": len(rows), "rows": rows[: int(args.get("limit", 25))],
                "note": "netOpen is projected from roster class years, not a school statement; knownCommits null = no commit data"}
    return clean(await asyncio.to_thread(run))


async def scout_program(ctx, args):
    def run():
        name = args["name"]
        c = db().colleges.find_one({"metadata.name": {"$regex": "^" + re.escape(name), "$options": "i"}}, {"_id": 0})
        if not c:
            raise ValueError(f"no program matching {name}")
        staff = list(db().coaches.find({"college": c["metadata"]["name"]}, {"_id": 0, "name": 1, "title": 1, "role": 1, "email": 1, "emailStatus": 1, "phone": 1, "sourceUrl": 1}).limit(60))
        return {"program": c["metadata"], "rosterProfile": {k: v for k, v in (c.get("rosterProfile") or {}).items() if k in ("byPosition", "footprint", "rosterCount", "sourceUrl", "scrapedAt")},
                "camps": c.get("camps"), "policy": c.get("policy"), "staff": staff}
    return clean(await asyncio.to_thread(run))


async def scout_coaches(ctx, args):
    def run():
        q: dict = {}
        if args.get("query"):
            rx = {"$regex": re.escape(args["query"]), "$options": "i"}
            q["$or"] = [{"name": rx}, {"college": rx}, {"title": rx}]
        for k in ("state", "division", "role"):
            if args.get(k): q[k] = args[k]
        rows = list(db().coaches.find(q, {"_id": 0, "name": 1, "title": 1, "role": 1, "college": 1, "division": 1, "state": 1, "email": 1, "emailStatus": 1, "touches": 1}).limit(int(args.get("limit", 40))))
        return {"rows": rows}
    return clean(await asyncio.to_thread(run))


async def scout_outreach_log(ctx, args):
    def run():
        q = {"athleteId": args["athlete_id"]}
        if args.get("school"): q["school"] = {"$regex": re.escape(args["school"]), "$options": "i"}
        rows = list(db().touches.find(q, {"_id": 0}).sort("at", -1).limit(int(args.get("limit", 50))))
        return {"rows": rows, "total": db().touches.count_documents(q)}
    return clean(await asyncio.to_thread(run))


async def scout_film_notes(ctx, args):
    def run():
        rep = db().film_reports.find_one({"athleteId": args["athlete_id"]}, {"_id": 0, "markdown": 0}, sort=[("generatedAt", -1)])
        notes = list(db().film_notes.find({"athleteId": args["athlete_id"]}, {"_id": 0, "playId": 1, "desc": 1, "game": 1, "scores": 1, "key_issues": 1, "show_coaches": 1, "confidence": 1}).sort("reelOrder", 1))
        return {"report": rep, "notes": notes, "advisory": "film notes are model opinions from 1-s broadcast frames; never quote as a grade to a coach"}
    return clean(await asyncio.to_thread(run))


async def scout_drafts(ctx, args):
    def run():
        q = {"athleteId": args["athlete_id"]}
        if args.get("status"): q["status"] = args["status"]
        return {"rows": list(db().drafts.find(q, {"_id": 0, "programFacts": 0}).sort("createdAt", -1).limit(int(args.get("limit", 40))))}
    return clean(await asyncio.to_thread(run))


async def web_search(ctx, args):
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://html.duckduckgo.com/html/", params={"q": args["query"]})
    out = []
    for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', r.text, re.S):
        href = m.group(1)
        u = re.search(r"uddg=([^&]+)", href)
        href = httpx.URL("http://x/?u=" + u.group(1)).params.get("u") if u else href
        out.append({"url": href, "title": re.sub("<[^>]+>", "", m.group(2)).strip(), "snippet": re.sub("<[^>]+>", "", m.group(3)).strip()})
        if len(out) >= int(args.get("limit", 8)):
            break
    return {"query": args["query"], "results": out, "status": r.status_code}


async def browser_open(ctx, args):
    url = await asyncio.to_thread(check_url, args["url"])
    async with BROWSER.lock:
        page = await BROWSER.ensure()
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        try:
            await page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        meta = await BROWSER.snapshot("open " + args["url"], ctx.task_id)
        body = await BROWSER.page_text(int(args.get("max_chars", 12000)))
    return clean({**meta, "status": resp.status if resp else None, **body})


async def browser_read(ctx, args):
    """Re-read the page the browser is on now (after scrolling/actions) without navigating."""
    async with BROWSER.lock:
        if not BROWSER.page:
            raise ValueError("browser has no page open; call browser_open first")
        meta = await BROWSER.snapshot("read", ctx.task_id)
        body = await BROWSER.page_text(int(args.get("max_chars", 12000)))
    return clean({**meta, **body})


async def maxpreps_check(ctx, args):
    """Compare MaxPreps (stats page + team roster listing) with the athlete card; returns discrepancies to fix."""
    import maxpreps_sync as mp  # recruit/maxpreps_sync.py

    def run():
        a = _athlete(args["athlete_id"])
        url = (a.get("media") or {}).get("maxPrepsUrl")
        if not url:
            return {"ok": False, "issue": "no MaxPreps URL on the card"}
        stats_url = mp.stats_url(url)
        rows = mp.parse_stats(mp.fetch(stats_url))
        card = {s["season"]: s for s in (a.get("stats") or [])}
        diffs = []
        for r in rows:
            c = card.get(r["season"])
            if not c:
                diffs.append({"season": r["season"], "issue": "season on MaxPreps but not on the card"}); continue
            for cat in ("passing", "rushing"):
                for k, v in (r.get(cat) or {}).items():
                    if (c.get(cat) or {}).get(k) != v:
                        diffs.append({"season": r["season"], "field": f"{cat}.{k}", "maxpreps": v, "card": (c.get(cat) or {}).get(k)})
        seasons = {r["season"] for r in rows}
        gaps = [f"20{y:02d}-{y+1:02d}" for y in range(24, 27) if f"20{y:02d}-{y+1:02d}" not in seasons]
        return {"ok": True, "statsUrl": stats_url, "maxprepsSeasons": sorted(seasons), "cardSeasons": sorted(card),
                "differences": diffs, "seasonsMissingOnMaxPreps": gaps, "listed": a.get("listed"),
                "advice": "card lags MaxPreps -> run maxpreps_sync; MaxPreps wrong/missing -> stats are entered by the team's coach/statistician on MaxPreps; the family can request corrections through the athlete profile"}
    return clean(await asyncio.to_thread(run))


# ------------------------------------------------------------------ WRITE tools (local, reversible)
MAXPREPS_SYNC_TIMEOUT = 120  # seconds; the desktop waits 180 s for a Gridiron tool, so this answer still reaches it


async def _end_tree(proc) -> str:
    """Stop a child that ran past its time together with anything it started, and say how. Windows ends only the process
    it is handed, so taskkill /T ends the tree there; elsewhere the child leads its own session (start_new_session)."""
    if proc.returncode is not None:
        return "the sync process itself had already exited"
    how = ""
    if os.name == "nt":
        root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
        taskkill = pathlib.Path(root) / "System32" / "taskkill.exe"
        try:
            tk = await asyncio.create_subprocess_exec(str(taskkill), "/PID", str(proc.pid), "/T", "/F",
                                                      stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            if await asyncio.wait_for(tk.wait(), timeout=15) == 0:
                how = "it was stopped together with everything it started (taskkill /T)"
        except (OSError, asyncio.TimeoutError):
            pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            how = "it was stopped together with everything it started (its process group)"
        except OSError:
            pass
    if not how:
        try:
            proc.kill()
            how = "the sync process was stopped, but not its process tree, so anything it started may still be running"
        except (ProcessLookupError, OSError):
            how = "the sync process itself had already exited"
    try:
        await asyncio.wait_for(proc.wait(), timeout=10)
    except asyncio.TimeoutError:
        how = "it was told to stop but was still running 10 s later"
    return how


async def maxpreps_sync_now(ctx, args):
    proc = await asyncio.create_subprocess_exec(sys.executable, "-P", str(RECRUIT / "maxpreps_sync.py"), "--athlete", args["athlete_id"],
                                                cwd=str(RECRUIT), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                start_new_session=os.name != "nt")
    out = bytearray()

    async def pump():
        while chunk := await proc.stdout.read(4096):
            out.extend(chunk)
            del out[:-4000]  # only the tail is returned

    reader = asyncio.ensure_future(pump())
    try:
        await asyncio.wait_for(asyncio.gather(reader, proc.wait()), timeout=MAXPREPS_SYNC_TIMEOUT)
    except asyncio.TimeoutError:
        how = await _end_tree(proc)
        reader.cancel()
        return {"returncode": proc.returncode, "timed_out": True, "still_running": proc.returncode is None,
                "output": out.decode("utf-8", "replace")[-2000:],
                "error": f"The MaxPreps sync did not finish within {MAXPREPS_SYNC_TIMEOUT} s; {how}. Anything it saved "
                         "before then stays; run maxpreps_check to compare the card with MaxPreps before trying again."}
    return {"returncode": proc.returncode, "output": out.decode("utf-8", "replace")[-2000:]}


async def draft_save(ctx, args):
    def run():
        a = _athlete(args["athlete_id"])
        bounced = db().coaches.find_one({"email": args["to"], "emailStatus": "bounced"})
        if bounced:
            raise ValueError("that address bounced before; pick another contact")
        d = {"id": "draft_" + uuid.uuid4().hex[:10], "athleteId": a["id"], "runId": ctx.task_id, "school": args["school"],
             "division": args.get("division", ""), "to": args["to"], "toName": args.get("to_name", ""), "toTitle": args.get("to_title", ""),
             "mode": args.get("mode", "first"), "subject": args["subject"], "body": args["body"], "dm": args.get("dm", ""),
             "engine": "scout-agent", "flags": [], "status": "draft", "createdAt": now(), "approvedAt": None, "sentAt": None, "advisory": True}
        db().drafts.insert_one(dict(d))
        return {"saved": d["id"], "status": "draft", "note": "visible in the Agent tab; sending needs email_send + approval"}
    return clean(await asyncio.to_thread(run))


async def content_save(ctx, args):
    def run():
        doc = {"id": "content_" + uuid.uuid4().hex[:10], "athleteId": args["athlete_id"], "kind": args["kind"], "title": args["title"],
               "body": args["body"], "channel": args.get("channel", ""), "status": "draft", "taskId": ctx.task_id, "createdAt": now()}
        db().agent_content.insert_one(dict(doc))
        return {"saved": doc["id"], "kind": doc["kind"], "status": "draft"}
    return clean(await asyncio.to_thread(run))


PAGE_SECTIONS = {"headline", "bio", "strengths", "season_summary", "strategy", "announcement", "highlight_post"}


async def page_publish(ctx, args):
    """Push agent-written content onto the athlete's Gridiron Scout page (local app). Keeps the previous value in history."""
    def run():
        sec = args["section"]
        if sec not in PAGE_SECTIONS:
            raise ValueError(f"section must be one of {sorted(PAGE_SECTIONS)}")
        a = _athlete(args["athlete_id"])
        prev = (a.get("profile") or {}).get(sec)
        db().athlete_page_history.insert_one({"athleteId": a["id"], "section": sec, "previous": prev, "new": args["content"], "taskId": ctx.task_id, "at": now()})
        db().athletes.update_one({"id": a["id"]}, {"$set": {f"profile.{sec}": {"content": args["content"], "updatedAt": now(), "by": "scout-agent", "taskId": ctx.task_id}}})
        return {"published": sec, "previousKept": prev is not None, "page": f"/player/{a['id']}"}
    return clean(await asyncio.to_thread(run))


# ------------------------------------------------------------------ EXECUTE tools (always need a human yes)
async def browser_act(ctx, args):
    act = args["action"]
    async with BROWSER.lock:
        page = await BROWSER.ensure()
        loc = page.get_by_text(args["text"], exact=False).first if args.get("text") and not args.get("selector") else (page.locator(args["selector"]).first if args.get("selector") else None)
        if act == "click":
            await loc.click(timeout=15000)
        elif act == "fill":
            await loc.fill(args.get("value", ""), timeout=15000)
        elif act == "press":
            await page.keyboard.press(args.get("value", "Enter"))
        elif act == "scroll":
            await page.mouse.wheel(0, int(args.get("value", "900")))
        elif act == "back":
            await page.go_back()
        else:
            raise ValueError("action must be click | fill | press | scroll | back")
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:
            pass
        meta = await BROWSER.snapshot(f"{act} {args.get('selector') or args.get('text') or args.get('value', '')}", ctx.task_id)
        body = await BROWSER.page_text(6000)
    return clean({**meta, **body})


async def email_send(ctx, args):
    host, user, pw = os.environ.get("GRIDIRON_SMTP_HOST"), os.environ.get("GRIDIRON_SMTP_USER"), os.environ.get("GRIDIRON_SMTP_PASSWORD")
    if not (host and user and pw):
        raise ValueError("no sender mailbox configured (set GRIDIRON_SMTP_HOST / _USER / _PASSWORD / _FROM in the runtime environment)")

    def run():
        d = db().drafts.find_one({"id": args["draft_id"]})
        if not d:
            raise ValueError("unknown draft")
        if d.get("sentAt"):
            raise ValueError("draft already sent")
        if db().coaches.find_one({"email": d["to"], "emailStatus": "bounced"}):
            raise ValueError("recipient bounced before")
        msg = EmailMessage()
        msg["From"] = os.environ.get("GRIDIRON_SMTP_FROM", user); msg["To"] = d["to"]; msg["Subject"] = d["subject"]
        msg.set_content(d["body"])
        with smtplib.SMTP(host, int(os.environ.get("GRIDIRON_SMTP_PORT", "587")), timeout=30) as s:
            s.starttls(); s.login(user, pw); s.send_message(msg)
        t = now()
        db().drafts.update_one({"id": d["id"]}, {"$set": {"status": "sent", "sentAt": t}})
        db().touches.insert_one({"id": "t_agent_" + uuid.uuid4().hex[:8], "athleteId": d["athleteId"], "school": d["school"], "channel": "email",
                                 "direction": "out", "at": t[:10], "contact_name": d.get("toName"), "contact_email": d["to"], "subject": d["subject"], "source": "scout-agent"})
        return {"sent": d["id"], "to": d["to"], "at": t}
    return clean(await asyncio.to_thread(run))


# ------------------------------------------------------------------ season film study + recruiting package
# Read the verified outputs of the season film study (recruit/film_study/RUNBOOK.md) and rebuild the package from them.
# The season files belong to the athlete whose film study ran; other athletes get theirs once the study runs for them.
PKG = RECRUIT / "data" / "packages"
GAMES_DIR = RECRUIT / "data" / "games"


ATHLETE_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){0,7}$")


def _aid(args) -> str:
    """Athlete ids become file paths and script arguments: lowercase slug only, and the athlete must exist."""
    aid = str(args.get("athlete_id") or "")
    if len(aid) > 64 or not ATHLETE_ID_RE.fullmatch(aid):
        raise ValueError("athlete_id must be a lowercase slug like 'quinn-placeholder'")
    if not (RECRUIT / "data" / "athletes" / f"{aid}.json").is_file():
        raise ValueError(f"unknown athlete {aid}")
    return aid


def _json(path: pathlib.Path):
    if not path.exists():
        raise ValueError(f"not built yet: {path.relative_to(REPO)}")
    return json.loads(path.read_text(encoding="utf-8"))


async def scout_season_study(ctx, args):
    aid = _aid(args)
    def run():
        card = _json(PKG / aid / "card.json")
        scores = _json(GAMES_DIR / "season_2026_scores.json")
        games = [{"opponent": s["opponent"], "date": s["date"], "result": s["result"], "official_line": s["line"], "score_0_10": s["score"],
                  "reads": s["verdict"], "costly_misses": s["costly_misses"]} for s in scores.values()]
        audit = _json(GAMES_DIR / "season_2026_blind_audit.json")
        missed = [{"game": x["opponent"], "play": f"{x['id_kind']} {x['id']}", "blind_verdict": x["verdict"], "why": x["why"][:300]}
                  for x in audit if x["prior"] == "missed read"]
        return {"season": card["season"], "film": card["film"], "games": games, "missed_reads_blind_check": missed,
                "reports": {"family": "recruit/data/games/season_2026_full_report.html", "coach": "recruit/data/games/season_2026_coach_report.html",
                            "summary": "recruit/data/games/season_2026_film_report.md"},
                "rules": f"Stat lines are official box scores; play-level counts come from team tags; {card['film'].get('cantTell', 0)} of "
                         f"{card['film'].get('dropbacks', 0)} dropbacks are 'can't tell' until the film is recaptured."}
    return clean(await asyncio.to_thread(run))


async def scout_card(ctx, args):
    aid = _aid(args)
    return clean(await asyncio.to_thread(lambda: _json(PKG / aid / "card.json")))


async def scout_highlights(ctx, args):
    aid = _aid(args)
    def run():
        h = _json(PKG / aid / "highlight_midseason_2026.json")
        return {"matrix": h["matrix"], "reel": h["reel"][: int(args.get("limit", 22))], "eligible": len(h["eligible"])}
    return clean(await asyncio.to_thread(run))


PACKAGE_REBUILD_TIMEOUT = 480  # seconds for every step together; the desktop waits 540 s for package_rebuild


def _end_tree_sync(proc) -> str:
    """package_rebuild's twin of _end_tree for a subprocess.Popen step (it runs in a worker thread). A step that ran
    past the rebuild's time is stopped together with anything it started (the resume's headless Chrome included)."""
    import subprocess
    if proc.poll() is not None:
        return "the step had already exited"
    how = ""
    if os.name == "nt":
        root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
        taskkill = pathlib.Path(root) / "System32" / "taskkill.exe"
        try:
            if subprocess.run([str(taskkill), "/PID", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=15).returncode == 0:
                how = "it was stopped together with everything it started (taskkill /T)"
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
            how = "it was stopped together with everything it started (its process group)"
        except OSError:
            pass
    if not how:
        try:
            proc.kill()
            how = "the step was stopped, but not its process tree, so anything it started may still be running"
        except OSError:
            how = "the step had already exited"
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        how = "it was told to stop but was still running 10 s later"
    return how


async def package_rebuild(ctx, args):
    aid = _aid(args)
    def run():
        import subprocess
        import time
        audit = str(GAMES_DIR / "season_2026_blind_audit.json")
        steps = [["season_report.py"], ["season_report_full.py", "--audit", audit],
                 ["season_report_full.py", "--audit", audit, "--audience", "coach"],
                 ["athletic_resume.py", "--athlete", aid], ["highlight_order.py", "--athlete", aid], ["card_data.py", "--athlete", aid]]
        out, timed_out = [], False
        deadline = time.monotonic() + PACKAGE_REBUILD_TIMEOUT
        for s in steps:
            if not (RECRUIT / s[0]).is_file():
                # The season film-study scripts read a team's private game data and are not in the public repository.
                out.append({"step": " ".join(s), "ok": False, "skipped": True, "tail": "not in this checkout"})
                continue
            left = deadline - time.monotonic()
            if left <= 0:
                out.append({"step": " ".join(s), "ok": False, "tail": "not started: the rebuild ran out of time"})
                timed_out = True
                break
            p = subprocess.Popen([sys.executable, "-P", str(RECRUIT / s[0]), *s[1:]], cwd=str(REPO), stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                                 start_new_session=os.name != "nt")
            try:
                stdout, stderr = p.communicate(timeout=left)
            except subprocess.TimeoutExpired:
                how = _end_tree_sync(p)
                try:
                    p.communicate(timeout=5)
                except (subprocess.TimeoutExpired, OSError, ValueError):
                    pass
                out.append({"step": " ".join(s), "ok": False, "timed_out": True,
                            "tail": f"did not finish within the rebuild's {PACKAGE_REBUILD_TIMEOUT} s; {how}."})
                timed_out = True
                break
            out.append({"step": " ".join(s), "ok": p.returncode == 0, "tail": (stdout or stderr or "").strip()[-300:]})
            if p.returncode != 0:
                break
        result = {"athlete_id": aid, "steps": out, "package_dir": f"recruit/data/packages/{aid}"}
        if timed_out:
            result["timed_out"] = True
            result["error"] = (f"The rebuild did not finish within {PACKAGE_REBUILD_TIMEOUT} s and was stopped. Steps that finished "
                               "kept their files; run package_rebuild again to finish the rest.")
        return result
    return clean(await asyncio.to_thread(run))


# ------------------------------------------------------------------ registration
S = lambda props, req=(): {"type": "object", "additionalProperties": False, "required": list(req), "properties": props}
AID = {"athlete_id": {"type": "string", "minLength": 1}}
STR = {"type": "string"}
INT = {"type": "integer", "minimum": 1, "maximum": 200}

SPECS = [
    ("scout_athlete", "Read an athlete's card: identity, measurables (verified vs listed), MaxPreps stats, film list, agent config, page sections.", S({**AID, "brief": {"type": "boolean"}}, ["athlete_id"]), "read", scout_athlete),
    ("scout_board", "Rank college programs for this athlete by projected open spots at his position/class, Texas and DFW footprint; filter by division/state.", S({**AID, "division": STR, "state": STR, "limit": INT}, ["athlete_id"]), "read", scout_board),
    ("scout_program", "One program: division/conference, roster needs by position, footprint, camps, and every staff member with title/role/email.", S({"name": {"type": "string", "minLength": 2}}, ["name"]), "read", scout_program),
    ("scout_coaches", "Search the national staff directory by name/school/title, state, division, role (recruiting_coordinator, qb_coach, head_coach...).", S({"query": STR, "state": STR, "division": STR, "role": STR, "limit": INT}), "read", scout_coaches),
    ("scout_outreach_log", "Every email/DM already sent to programs for this athlete, newest first; filter by school.", S({**AID, "school": STR, "limit": INT}, ["athlete_id"]), "read", scout_outreach_log),
    ("scout_film_notes", "Film evaluator rollup and per-play notes (advisory model opinions).", S(AID, ["athlete_id"]), "read", scout_film_notes),
    ("scout_drafts", "Outreach drafts for this athlete, filter by status (draft, needs_review, approved, sent, rejected).", S({**AID, "status": STR, "limit": INT}, ["athlete_id"]), "read", scout_drafts),
    ("web_search", "Search the public web (DuckDuckGo) for camps, showcases, coach pages, news, media outlets.", S({"query": {"type": "string", "minLength": 2}, "limit": INT}, ["query"]), "read", web_search),
    ("browser_open", "Open a URL in the agent's browser (shown live to the athlete); returns page text, links and emails found.", S({"url": {"type": "string", "minLength": 8}, "max_chars": {"type": "integer", "minimum": 500, "maximum": 30000}}, ["url"]), "read", browser_open),
    ("browser_read", "Re-read the current browser page after scrolling or an action.", S({"max_chars": {"type": "integer", "minimum": 500, "maximum": 30000}}), "read", browser_read),
    ("maxpreps_check", "Check the athlete's MaxPreps stats and listing against the card; returns differences and missing seasons.", S(AID, ["athlete_id"]), "read", maxpreps_check),
    ("maxpreps_sync_now", "Pull the latest MaxPreps stats onto the athlete card (local write, history kept in stats_history).", S(AID, ["athlete_id"]), "write", maxpreps_sync_now),
    ("draft_save", "Save a one-to-one outreach email draft (and optional DM text) for review in the Agent tab. Never sends.", S({**AID, "school": STR, "division": STR, "to": {"type": "string", "minLength": 5}, "to_name": STR, "to_title": STR, "mode": STR, "subject": {"type": "string", "minLength": 3}, "body": {"type": "string", "minLength": 40}, "dm": STR}, ["athlete_id", "school", "to", "subject", "body"]), "write", draft_save),
    ("content_save", "Save content for the athlete to review: kind = post | caption | bio | strategy | plan | outreach_plan | event_list.", S({**AID, "kind": {"type": "string", "minLength": 2}, "title": {"type": "string", "minLength": 2}, "body": {"type": "string", "minLength": 10}, "channel": STR}, ["athlete_id", "kind", "title", "body"]), "write", content_save),
    ("page_publish", "Push content onto the athlete's Gridiron Scout page section (headline, bio, strengths, season_summary, strategy, announcement, highlight_post). Previous value is kept.", S({**AID, "section": {"type": "string", "minLength": 3}, "content": {"type": "string", "minLength": 3}}, ["athlete_id", "section", "content"]), "write", page_publish),
    ("scout_season_study", "The season film study: official season line, film-checked numbers (reads, clean pocket, 3rd/4th down, red zone), every game's line and 0-10 score, missed reads with the blind re-check, and where the family/coach reports are.", S(AID, ["athlete_id"]), "read", scout_season_study),
    ("scout_card", "The athlete's trading-card payload (what the page card shows), rebuilt from verified data.", S(AID, ["athlete_id"]), "read", scout_card),
    ("scout_highlights", "Highlight reel order from the published scoring matrix, best play first, with the Hudl video and clip for each play.", S({**AID, "limit": INT}, ["athlete_id"]), "read", scout_highlights),
    ("package_rebuild", "Rebuild the athlete's reports, athletic resume, highlight order and trading card from the verified data (local files only; nothing is sent).", S(AID, ["athlete_id"]), "write", package_rebuild),
    ("browser_act", "Act in the live browser: click | fill | press | scroll | back, by visible text or CSS selector. Needs a human approval every time.", S({"action": {"type": "string", "minLength": 4}, "text": STR, "selector": STR, "value": STR}, ["action"]), "execute", browser_act),
    ("email_send", "Send an approved draft from the configured sender mailbox and log the touch. Needs a human approval every time.", S({"draft_id": {"type": "string", "minLength": 6}}, ["draft_id"]), "execute", email_send),
]

# coding/mutation tools the scout agent must not have (it would otherwise auto-write repo files in autonomous mode)
REMOVE_CORE = ("write_file", "apply_patch", "restore_checkpoint", "shell", "generate_component", "git_status", "git_diff", "scan_graph")


def register(registry) -> list[str]:
    from yur_harness.tools import ToolSpec
    for name in REMOVE_CORE:
        registry._tools.pop(name, None)
    registry.register_many([ToolSpec(n, d, schema, risk, h, source="scout") for n, d, schema, risk, h in SPECS])
    return [s[0] for s in SPECS]
