"""Model access for the agent scripts. Tries Anthropic → OpenAI → Google using env keys; returns None when no provider works,
so every caller must have a deterministic fallback (templates) and must record which provider (if any) produced an output.
"""
from __future__ import annotations
import os, base64, json, pathlib

def _anthropic():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: return None
    try:
        import anthropic
        return anthropic.Anthropic(api_key=key)
    except Exception: return None

ENGINES = ("anthropic", "openai", "xai", "ollama", "google")


def _mime(img: pathlib.Path) -> str:
    return "image/jpeg" if img.suffix.lower() in (".jpg", ".jpeg") else "image/png"


def _openai_compatible(url: str, key: str, model: str, prompt: str, system: str, images, max_tokens: int, timeout: int) -> str:
    import httpx
    msgs = [{"role": "system", "content": system or "You are a careful assistant."}]
    parts = [{"type": "text", "text": prompt}]
    for img in (images or []):
        parts.append({"type": "image_url", "image_url": {"url": f"data:{_mime(img)};base64," + base64.b64encode(img.read_bytes()).decode()}})
    msgs.append({"role": "user", "content": parts})
    r = httpx.post(url, headers={"Authorization": f"Bearer {key}"}, json={"model": model, "messages": msgs, "max_tokens": max_tokens}, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
    choice = r.json()["choices"][0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError(f"truncated at max_tokens={max_tokens} (finish_reason=length)")
    return choice["message"]["content"]


def complete_with(engine: str, prompt: str, system: str = "", images: list[pathlib.Path] | None = None, max_tokens: int = 1500, timeout: int = 180) -> tuple[str, str]:
    """One engine, no fallback. Returns (text, 'engine:model'). Raises on failure so callers can record the error."""
    if engine == "anthropic":
        cl = _anthropic()
        if not cl: raise RuntimeError("no ANTHROPIC_API_KEY")
        content = []
        for img in (images or []):
            content.append({"type": "image", "source": {"type": "base64", "media_type": _mime(img), "data": base64.b64encode(img.read_bytes()).decode()}})
        content.append({"type": "text", "text": prompt})
        model = os.environ.get("AGENT_MODEL", "claude-opus-5-5")
        r = cl.messages.create(model=model, max_tokens=max_tokens, system=system or "You are a careful assistant.", messages=[{"role": "user", "content": content}])
        return "".join(getattr(b, "text", "") for b in r.content), "anthropic:" + model
    if engine == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key: raise RuntimeError("no OPENAI_API_KEY")
        model = os.environ.get("OPENAI_MODEL", "gpt-4o")
        return _openai_compatible("https://api.openai.com/v1/chat/completions", key, model, prompt, system, images, max_tokens, timeout), "openai:" + model
    if engine == "xai":   # OpenAI-compatible; image input on grok-4.x (checked 2026-10-10 via /v1/language-models)
        key = os.environ.get("XAI_API_KEY")
        if not key: raise RuntimeError("no XAI_API_KEY")
        model = os.environ.get("XAI_MODEL", "grok-4.7")
        return _openai_compatible("https://api.x.ai/v1/chat/completions", key, model, prompt, system, images, max_tokens, timeout), "xai:" + model
    if engine == "ollama":   # Ollama Cloud (constant on this machine): OpenAI-compatible, cloud compute, OLLAMA_API_KEY
        key = os.environ.get("OLLAMA_API_KEY")
        if not key: raise RuntimeError("no OLLAMA_API_KEY")
        # AGENT_OLLAMA_MODEL, not OLLAMA_MODEL: the machine-wide OLLAMA_MODEL points at a local daemon model (llama3.1:8b) that the cloud lacks
        # text brain = DeepSeek V4 Pro (no image input, verified 2026-10-11); eyes = Gemma 4 31B for any call carrying frames
        model = (os.environ.get("AGENT_OLLAMA_VISION_MODEL", "gemma4:31b") if images
                 else os.environ.get("AGENT_OLLAMA_MODEL", "deepseek-v4-pro:0813"))
        base = os.environ.get("AGENT_OLLAMA_URL", "https://ollama.com")
        return _openai_compatible(base.rstrip("/") + "/v1/chat/completions", key, model, prompt, system, images, max_tokens, timeout), "ollama:" + model
    if engine == "google":
        key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
        if not key: raise RuntimeError("no GOOGLE_API_KEY")
        import httpx
        parts = [{"text": (system + "\n\n" if system else "") + prompt}]
        for img in (images or []):
            parts.append({"inline_data": {"mime_type": _mime(img), "data": base64.b64encode(img.read_bytes()).decode()}})
        model = os.environ.get("GEMINI_MODEL", "gemini-2.5-pro")
        r = httpx.post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}", json={"contents": [{"parts": parts}]}, timeout=timeout)
        if r.status_code != 200: raise RuntimeError(f"HTTP {r.status_code}: {r.text[:160]}")
        return r.json()["candidates"][0]["content"]["parts"][0]["text"], "google:" + model
    raise RuntimeError(f"unknown engine {engine}")


def complete(prompt: str, system: str = "", images: list[pathlib.Path] | None = None, max_tokens: int = 1500, engines=ENGINES) -> tuple[str, str]:
    """First engine that answers, in order. Returns (text, provider); provider == 'none' when no model answered."""
    for e in engines:
        try:
            return complete_with(e, prompt, system, images, max_tokens)
        except Exception as ex:
            print(f"{e} failed:", ex.__class__.__name__, str(ex)[:120])
    return "", "none"
