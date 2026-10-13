"""Engine capability registry (Trinity skill_registry.py, keyed to the providers llm.py can reach).

pick_engines(intent) returns the ordered list of providers to try for a step; the scheduler uses the first that answers,
or all of them when a step asks for consensus (film evaluation)."""
from __future__ import annotations
import os
from typing import Dict, List

SKILL_REGISTRY: Dict[str, Dict[str, List[str]]] = {
    "anthropic": {"strengths": ["vision", "narrative", "tone", "longform", "policy", "email"], "intents": ["evaluate", "draft", "synthesize"]},
    "openai":    {"strengths": ["vision", "analyze", "summarize", "compare", "plan"],          "intents": ["evaluate", "analysis", "draft"]},
    "xai":       {"strengths": ["vision", "analyze", "reasoning", "image"],                    "intents": ["evaluate", "analysis"]},
    "ollama":    {"strengths": ["vision", "analyze", "narrative", "email", "image"],           "intents": ["evaluate", "draft", "analysis"]},
    "google":    {"strengths": ["vision", "image", "multimodal", "video"],                     "intents": ["evaluate", "extract visuals"]},
}
DEFAULT_ENGINE_ORDER = ["anthropic", "openai", "xai", "ollama", "google"]
KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "xai": "XAI_API_KEY", "ollama": "OLLAMA_API_KEY", "google": "GOOGLE_API_KEY"}


def available_engines() -> List[str]:
    """Engines whose key is present in this process (presence only; validity is learned when a call fails)."""
    out = [e for e in DEFAULT_ENGINE_ORDER if os.environ.get(KEY_ENV[e]) or (e == "google" and os.environ.get("GEMINI_API_KEY"))]
    forced = os.environ.get("AGENT_ENGINES")           # e.g. "xai,openai" to pin the order
    if forced:
        pinned = [x.strip() for x in forced.split(",") if x.strip() in SKILL_REGISTRY]
        out = [e for e in pinned if e in out] or out
    return out


def pick_engines(intent: str, hint: str | None = None) -> List[str]:
    """Order the available engines by fit for an intent/hint (Trinity pick_engine, returning the full ranked list)."""
    avail = available_engines()
    words = (intent + " " + (hint or "")).lower()
    def score(e: str) -> int:
        d = SKILL_REGISTRY[e]
        return sum(1 for w in d["strengths"] + d["intents"] if w in words)
    return sorted(avail, key=lambda e: (-score(e), DEFAULT_ENGINE_ORDER.index(e)))
