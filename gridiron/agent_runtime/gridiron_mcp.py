"""Gridiron Scout tool server (MCP, stdio) for Franklin in the YUR AI Desktop (athletics profile).

The desktop's gateway loads tool servers from the `mcp_config_paths` in its shell config
(agent_runtime/yur_desktop/shell-config.json -> mcp_servers.json). This server hands Franklin the same scout tools
the Gridiron agent uses (scout_tools.SPECS), so there is one implementation of each tool.

Left out on purpose:
  browser_open / browser_read / browser_act  the desktop has its own Browser panel with approvals and human handoff
  email_send                                 sending stays with Gridiron's approval + vault path, never the desktop
  page_publish                               changes the athlete's public page; that needs a person's yes in Gridiron
  web_search                                 an outbound channel a prompt-injected model could put private data into;
                                             the desktop's own governed web tools are used instead
What remains is reads plus local, reviewable writes: drafts and content (status draft, nothing goes out),
a MaxPreps stat sync (history kept) and a package rebuild from verified data. Two tools go out to the internet:
maxpreps_check and maxpreps_sync_now (recruit/maxpreps_sync.py) fetch the athlete's public MaxPreps stats page, from the
MaxPreps URL stored on the card, through the Gridiron server's /api/proxy/maxpreps when it is running, else directly.
They send only that page request. Every other tool works on this computer only (the Gridiron MongoDB at MONGO_URL,
localhost by default, and files under recruit/).
Every athlete_id is checked (lowercase slug, existing athlete) before any tool runs, and the family's own
contact fields are removed from athlete reads.

Run by the desktop as:  python -P agent_runtime/gridiron_mcp.py
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import mcp.types as types  # noqa: E402
from mcp.server.lowlevel import Server  # noqa: E402
from mcp.server.stdio import stdio_server  # noqa: E402

import scout_tools as st  # noqa: E402

EXCLUDE = {"browser_open", "browser_read", "browser_act", "email_send", "page_publish", "web_search"}
PRIVATE_ATHLETE_FIELDS = ("contacts", "agent")  # family emails/phones, sender mailbox settings
SPECS = {n: (d, schema, risk, h) for n, d, schema, risk, h in st.SPECS if n not in EXCLUDE}
SESSION = "intelliflow-" + uuid.uuid4().hex[:8]

# YUR AI Athletics: Franklin puts a page in front of the user. The tool only names the page;
# the desktop watches Franklin's tool events and switches its main view (tabs and Gridiron
# paths are re-checked against the desktop's allowlist there). Nothing is read or written.
SHOW_TABS = ["franklin", "my-card", "film-study", "highlights", "stats-maxpreps", "camps-schedule",
             "resume-report", "college-board", "coaches", "outreach-drafts", "approvals", "settings"]


async def show_page(_ctx, args):
    tab = str(args.get("tab") or "")
    if tab not in SHOW_TABS:
        raise ValueError(f"tab must be one of {', '.join(SHOW_TABS)}")
    path = args.get("path")
    if path is not None:
        path = str(path)
        if not path.startswith("/") or path.startswith("//") or len(path) > 300 or any(ord(c) < 32 or c == chr(92) for c in path):
            raise ValueError("path must be a Gridiron path such as /player/<athlete-id>?tab=film")
    note = str(args.get("note") or "")[:200]
    shown = {"tab": tab, **({"path": path} if path else {})}
    return {"athletics_show": shown, "note": note,
            "told_user": "The page is now open in the YUR AI Athletics window. Walk them through it."}


SPECS["show_page"] = (
    "Show the user a page in the YUR AI Athletics window while you walk them through their work: one of the app's tabs "
    "(my-card, film-study, highlights, stats-maxpreps, camps-schedule, resume-report, college-board, coaches, outreach-drafts, "
    "approvals, settings, franklin) and optionally a Gridiron path for that tab, e.g. /player/<athlete-id>?tab=film. "
    "For outside sites (Hudl, MaxPreps, college pages) use the live browser tools instead.",
    {"type": "object", "additionalProperties": False, "required": ["tab"], "properties": {
        "tab": {"type": "string", "enum": SHOW_TABS},
        "path": {"type": "string", "maxLength": 300},
        "note": {"type": "string", "maxLength": 200}}},
    "ui",
    show_page,
)


class Ctx:
    """The scout tools record which run made a draft/content/page change; the desktop session id stands in."""
    task_id = SESSION


server = Server("gridiron-scout")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [types.Tool(name=n, description=f"{d} (risk: {risk})", inputSchema=schema) for n, (d, schema, risk, _h) in SPECS.items()]


@server.call_tool()
async def call_tool(name: str, arguments: dict | None) -> list[types.TextContent]:
    if name not in SPECS:
        raise ValueError(f"unknown tool: {name}")
    _d, _schema, _risk, handler = SPECS[name]
    args = dict(arguments or {})
    if "athlete_id" in args:
        args["athlete_id"] = st._aid(args)
    result = await handler(Ctx(), args)
    if name == "scout_athlete" and isinstance(result, dict) and isinstance(result.get("athlete"), dict):
        for k in PRIVATE_ATHLETE_FIELDS:
            result["athlete"].pop(k, None)
    text = json.dumps(result, default=str, ensure_ascii=False)
    if len(text) > 60000:
        text = text[:60000] + ' ... [truncated]'
    return [types.TextContent(type="text", text=text)]


async def main() -> None:
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
