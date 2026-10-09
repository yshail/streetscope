"""The doctor, powered by Claude Sonnet 5.5.

Claude never sees raw data. It can call the measuring tools in tools.py, and a checker (verify.py) flags every number
in its answer that no tool produced. Provider order:

1. LLM_BACKEND=bedrock  -> Claude on Amazon Bedrock through the Mantle client (what the AWS deployment uses)
2. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN set (or an `ant auth login` profile via LLM_BACKEND=anthropic) -> Anthropic API
3. nothing available -> the caller falls back to the labelled offline answer
"""

from __future__ import annotations

import json
import os
from typing import Any

from . import tools as T
from .verify import unverified_numbers

CLAUDE_MODEL = "claude-sonnet-5-5"            # Anthropic API id
BEDROCK_MODEL = "anthropic.claude-sonnet-5-5"  # Amazon Bedrock (Mantle) id
MAX_TURNS = 8

SYSTEM = """You are the Streetscope doctor. You help a city engineer understand one street junction using measuring tools.

Rules:
1. Learn facts only by calling tools. Never use outside knowledge about the place, and never guess a number.
2. Every number you write must be copied from a tool result. If no tool gave a number, say you do not know it.
3. Say plainly when a tool marks something as a default, assumed, estimated, simulated or under-counted.
4. Traffic results come from a screening model with assumed demand and no traffic counts. Call them simulated, quote the relative change, and never present them as measured vehicle counts.
5. When you propose a fix, call list_scenarios, traffic_areas or propose_solutions first so the numbers come from the maths. Prefer fixes the tools marked recommended, and mention the assumption behind each.
6. Be brief and plain. Use short sentences and bullets, no numbered lists, no tables, and explain any jargon in a few words.
7. Never claim an engineering design is complete. This is screening to decide what to study next."""

BRIEF_PROMPT = """Write the engineer's brief for this site in under 220 words. Call the tools you need first, in this order of
importance: site_summary, traffic_areas, propose_solutions for the top area, shade_profile, list_scenarios.
Use these headings and short bullets under each: Where it hurts, What we would try, How sure we are.
Under "How sure we are", list the data gaps and the assumptions behind any simulated or assumed number."""


def make_client() -> tuple[Any, str, str] | None:
    """Return (client, model id, provider name) or None when no credentials are available."""
    backend = os.environ.get("LLM_BACKEND", "auto")
    if backend == "bedrock":
        from anthropic import AnthropicBedrockMantle

        return (AnthropicBedrockMantle(aws_region=os.environ.get("AWS_REGION", "us-east-1")),
                os.environ.get("CLAUDE_MODEL", BEDROCK_MODEL), "Amazon Bedrock")
    if backend == "anthropic" or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        import anthropic

        return anthropic.Anthropic(), os.environ.get("CLAUDE_MODEL", CLAUDE_MODEL), "Anthropic API"
    return None


def llm_status() -> dict:
    """What the UI badge should say. Never makes a network call."""
    backend = os.environ.get("LLM_BACKEND", "auto")
    if backend == "bedrock":
        return {"mode": "claude", "model": os.environ.get("CLAUDE_MODEL", BEDROCK_MODEL), "provider": "Amazon Bedrock"}
    if backend == "anthropic" or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return {"mode": "claude", "model": os.environ.get("CLAUDE_MODEL", CLAUDE_MODEL), "provider": "Anthropic API"}
    return {"mode": "offline", "model": None, "provider": None}


def _dispatch(site: T.Site, name: str, args: dict) -> Any:
    fn = T.TOOLS.get(name)
    if fn is None:
        raise ValueError(f"unknown tool {name}")
    return fn(site, **args)


def _create(client: Any, provider: str, **kwargs):
    """One model call. On the Anthropic API we also ask for the server-side refusal fallback."""
    if provider == "Anthropic API":
        try:
            return client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs)
        except Exception as exc:  # the fallback beta is not available to every account: retry plainly
            if type(exc).__name__ not in ("BadRequestError", "PermissionDeniedError", "TypeError", "NotFoundError"):
                raise
    return client.messages.create(**kwargs)


def run(site: T.Site, question: str, trace: list[dict], client: Any = None, model: str | None = None,
        provider: str = "Anthropic API", max_tokens: int = 4096, effort: str = "medium") -> dict:
    """Run one question through Claude with the tool loop. `trace` receives every tool call and result."""
    if client is None:
        made = make_client()
        if made is None:
            raise RuntimeError("no Claude credentials available")
        client, model, provider = made
    model = model or CLAUDE_MODEL
    messages: list[dict] = [{"role": "user", "content": question}]
    meta = {"provider": provider, "model": model, "turns": 0, "input_tokens": 0, "output_tokens": 0, "request_ids": []}
    answer = ""
    for _ in range(MAX_TURNS):
        resp = _create(client, provider, model=model, max_tokens=max_tokens, system=SYSTEM, tools=T.TOOL_SPECS,
                       messages=messages, output_config={"effort": effort})
        meta["turns"] += 1
        usage = getattr(resp, "usage", None)
        if usage is not None:
            meta["input_tokens"] += getattr(usage, "input_tokens", 0) or 0
            meta["output_tokens"] += getattr(usage, "output_tokens", 0) or 0
        rid = getattr(resp, "_request_id", None)
        if rid:
            meta["request_ids"].append(rid)
        if resp.stop_reason == "refusal":
            raise RuntimeError("Claude declined this request")
        messages.append({"role": "assistant", "content": resp.content})
        calls = [b for b in resp.content if getattr(b, "type", "") == "tool_use"]
        if resp.stop_reason != "tool_use" or not calls:
            answer = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text").strip()
            break
        results = []
        for b in calls:
            try:
                out = _dispatch(site, b.name, dict(b.input or {}))
                trace.append({"tool": b.name, "args": dict(b.input or {}), "result": out})
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out)})
            except Exception as exc:
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": f"error: {exc}", "is_error": True})
        messages.append({"role": "user", "content": results})
    if not answer:
        raise RuntimeError("Claude did not finish within the turn limit")
    bad = unverified_numbers(answer, [t["result"] for t in trace], question)
    return {"answer": answer, "unverified_numbers": bad, "verified": not bad, "llm": meta}
