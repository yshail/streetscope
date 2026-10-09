"""The doctor, powered by Claude Sonnet 5.5.

Claude never sees raw data. It can call the measuring tools in tools.py, and a checker (verify.py) flags every number
in its answer that no tool produced. Which Claude answers (LLM_BACKEND, default "auto"):

- bedrock    Claude on Amazon Bedrock through the Mantle client (what the AWS deployment uses)
- anthropic  the Anthropic API (auto picks it when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set)
- cli        the `claude` command line (Claude Code) with your own login, no API key. The tools reach it through a
             small MCP server (mcp_server.py). Auto picks it when no key is set and `claude` is on the PATH.
- nothing available: the caller falls back to the labelled offline answer
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import tools as T
from .verify import unverified_numbers

CLAUDE_MODEL = "claude-sonnet-5-5"            # Anthropic API and Claude Code id
BEDROCK_MODEL = "anthropic.claude-sonnet-5-5"  # Amazon Bedrock (Mantle) id
MAX_TURNS = 8
CLI_TIMEOUT_S = 240

SYSTEM = """You are the Streetscope doctor. You help a city engineer understand one street junction using measuring tools.

Rules:
1. Learn facts only by calling tools. Never use outside knowledge about the place, and never guess a number.
2. Every number you write must be copied exactly as a tool returned it: do not round, convert units, change "1,200,000" into "1.2 million" or shorten coordinates. A checker compares every number with the tool results. If no tool gave a number, say you do not know it.
3. Say plainly when a tool marks something as a default, assumed, estimated, simulated or under-counted.
4. Traffic results come from a screening model with assumed demand and no traffic counts. Call them simulated, quote the relative change, and never present them as measured vehicle counts.
5. When you propose a fix, call list_scenarios, traffic_areas or propose_solutions first so the numbers come from the maths. Prefer fixes the tools marked recommended, and mention the assumption behind each.
6. Be brief and plain. Use short sentences and bullets, no numbered lists, no tables, and explain any jargon in a few words.
7. Never claim an engineering design is complete. This is screening to decide what to study next."""

BRIEF_PROMPT = """Write the engineer's brief for this site in under 220 words. Call the tools you need first, in this order of
importance: site_summary, traffic_areas, propose_solutions for the top area, shade_profile, list_scenarios.
Use these headings and short bullets under each: Where it hurts, What we would try, How sure we are.
Under "How sure we are", list the data gaps and the assumptions behind any simulated or assumed number."""


def claude_cli() -> str | None:
    """Path of the Claude Code command line, if installed."""
    return os.environ.get("CLAUDE_CLI") or shutil.which("claude")


def backend() -> str | None:
    """Which model path to use: bedrock, anthropic, cli, strands, or None for offline."""
    b = os.environ.get("LLM_BACKEND", "auto")
    if b != "auto":
        return b
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    if claude_cli():
        return "cli"
    return None


def make_client() -> tuple[Any, str, str] | None:
    """Return (client, model id, provider name) for the SDK paths, or None."""
    b = backend()
    if b == "bedrock":
        from anthropic import AnthropicBedrockMantle

        return (AnthropicBedrockMantle(aws_region=os.environ.get("AWS_REGION", "us-east-1")),
                os.environ.get("CLAUDE_MODEL", BEDROCK_MODEL), "Amazon Bedrock")
    if b == "anthropic":
        import anthropic

        return anthropic.Anthropic(), os.environ.get("CLAUDE_MODEL", CLAUDE_MODEL), "Anthropic API"
    return None


def llm_status() -> dict:
    """What the UI badge should say. Never makes a network call."""
    b = backend()
    if b == "bedrock":
        return {"mode": "claude", "model": os.environ.get("CLAUDE_MODEL", BEDROCK_MODEL), "provider": "Amazon Bedrock"}
    if b == "anthropic":
        return {"mode": "claude", "model": os.environ.get("CLAUDE_MODEL", CLAUDE_MODEL), "provider": "Anthropic API"}
    if b == "cli":
        return {"mode": "claude", "model": os.environ.get("CLAUDE_MODEL", CLAUDE_MODEL), "provider": "Claude Code (your login)"}
    return {"mode": "offline", "model": None, "provider": None}


def cli_command(exe: str, question: str, model: str, mcp_config: Path, system_file: Path) -> list[str]:
    """The `claude -p` call: only our tools (no files, no shell), no saved session."""
    return [exe, "-p", question, "--output-format", "json", "--model", model,
            "--system-prompt-file", str(system_file),
            "--tools", "",                                     # no built-in tools: no files, no shell, no web
            "--strict-mcp-config", "--mcp-config", str(mcp_config),
            "--allowedTools", "mcp__streetscope",
            "--no-session-persistence"]


def run_cli(site: T.Site, question: str, trace: list[dict], model: str | None = None, runner=subprocess.run) -> dict:
    """Ask Claude through the Claude Code command line, using the login already on this machine."""
    exe = claude_cli()
    if not exe:
        raise RuntimeError("the claude command line is not installed")
    model = model or os.environ.get("CLAUDE_MODEL", CLAUDE_MODEL)
    root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="streetscope-") as tmp:
        tmpd = Path(tmp)
        trace_file, cfg, sysf = tmpd / "trace.jsonl", tmpd / "mcp.json", tmpd / "system.txt"
        trace_file.touch()
        sysf.write_text(SYSTEM, encoding="utf-8")
        cfg.write_text(json.dumps({"mcpServers": {"streetscope": {
            "type": "stdio", "command": sys.executable,
            "args": ["-m", "streetscope_agent.mcp_server", str(Path(site.folder).resolve()), str(trace_file)],
            "env": {"PYTHONPATH": os.pathsep.join([str(root / "pipeline"), str(root / "agent")])}}}}), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")}
        proc = runner(cli_command(exe, question, model, cfg, sysf), cwd=tmp, env=env, capture_output=True,
                      text=True, encoding="utf-8", timeout=CLI_TIMEOUT_S)
        for line in trace_file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                trace.append(json.loads(line))
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        raise RuntimeError(f"claude returned no JSON (exit {proc.returncode}): {(proc.stderr or proc.stdout)[:200]}")
    if out.get("is_error") or out.get("subtype") != "success":
        raise RuntimeError(f"claude failed: {out.get('subtype')} {str(out.get('result', ''))[:200]}")
    answer = str(out.get("result", "")).strip()
    bad = unverified_numbers(answer, [t["result"] for t in trace], question)
    meta = {"provider": "Claude Code (your login)", "model": model, "turns": out.get("num_turns", 0),
            "cost_usd_equiv": out.get("total_cost_usd"), "session": out.get("session_id")}
    return {"answer": answer, "unverified_numbers": bad, "verified": not bad, "llm": meta}


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
