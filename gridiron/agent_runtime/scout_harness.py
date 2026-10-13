"""Boot the IntelliFlow yur_harness (agent-marketplace engine, unmodified) as the Gridiron scout-agent runtime.

    python agent_runtime/scout_harness.py            -> http://127.0.0.1:8079  (harness console + API)

- engine: the agent-marketplace engine folder (SCOUT_ENGINE_DIR; default ../agent-marketplace/engine beside this repo)
- brain: DeepSeek V4 Pro on Ollama Cloud via the local Ollama daemon (deepseek-v4-pro:cloud); override SCOUT_MODEL
- tools: agent_runtime/scout_tools.py (coding/shell tools removed); approvals for every execute-risk tool
- state: agent_runtime/.harness_data (git-ignored): sqlite missions/ledger/approvals + scout-admin.secret
Gridiron Scout's Express server logs in with the secret file and proxies /api/scout/* to this runtime.
"""
from __future__ import annotations

import os
import pathlib
import secrets
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
ENGINE = pathlib.Path(os.environ.get("SCOUT_ENGINE_DIR") or REPO.parent.parent / "agent-marketplace" / "engine")
DATA = HERE / ".harness_data"
DATA.mkdir(parents=True, exist_ok=True)
SECRET = DATA / "scout-admin.secret"
if not SECRET.exists():
    SECRET.write_text(secrets.token_urlsafe(24), encoding="utf-8")

MODEL = os.environ.get("SCOUT_MODEL", "deepseek-v4-pro:cloud")
env = {
    "YUR_HOST": "127.0.0.1", "YUR_PORT": os.environ.get("SCOUT_PORT", "8079"), "YUR_GRPC_ENABLED": "0",
    "YUR_DATA_DIR": str(DATA), "YUR_ALLOWED_ROOTS": str(REPO), "YUR_ADMIN_USER": "scout-admin",
    "YUR_ADMIN_PASSWORD": SECRET.read_text(encoding="utf-8").strip(),
    "YUR_DEFAULT_PROVIDER": "ollama", "YUR_DEFAULT_MODEL": MODEL,
    "OLLAMA_BASE_URL": os.environ.get("SCOUT_OLLAMA_URL", "http://127.0.0.1:11434"), "OLLAMA_MODEL": MODEL,
    "YUR_MAX_TASK_STEPS": "40", "YUR_MCP_CONFIG": str(HERE / "mcp_servers.json"),
}
os.environ.update(env)
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(HERE))

import uvicorn  # noqa: E402
from yur_harness.tools import registry  # noqa: E402
import scout_tools  # noqa: E402

names = scout_tools.register(registry)
from yur_harness.app import app  # noqa: E402

if __name__ == "__main__":
    print(f"[scout] engine={ENGINE} model={MODEL} tools={len(registry.list())} scout={len(names)} port={env['YUR_PORT']}", flush=True)
    uvicorn.run(app, host=env["YUR_HOST"], port=int(env["YUR_PORT"]), log_level="warning")
