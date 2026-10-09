"""The Claude Code (command line) path, with the subprocess faked so no login or network is needed."""

import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from streetscope_agent import claude_agent as CA
from streetscope_agent import mcp_server as M
from streetscope_agent import tools as T

SITE_DIR = Path(__file__).resolve().parents[2] / "web" / "data" / "dupont"


@pytest.fixture(scope="module")
def site():
    return T.Site(SITE_DIR)


def test_mcp_server_lists_and_calls_tools(site, tmp_path):
    trace = tmp_path / "t.jsonl"
    init = M.handle(site, trace, {"id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
    assert init["protocolVersion"] == "2025-06-18" and "tools" in init["capabilities"]
    assert M.handle(site, trace, {"method": "notifications/initialized"}) is None
    names = {t["name"] for t in M.handle(site, trace, {"id": 2, "method": "tools/list"})["tools"]}
    assert names == set(T.TOOLS)
    res = M.handle(site, trace, {"id": 3, "method": "tools/call", "params": {"name": "traffic_areas", "arguments": {"top": 2}}})
    assert json.loads(res["content"][0]["text"])["available"]
    bad = M.handle(site, trace, {"id": 4, "method": "tools/call", "params": {"name": "nope", "arguments": {}}})
    assert bad["isError"]
    lines = trace.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["tool"] == "traffic_areas"


def test_cli_command_allows_only_our_tools():
    cmd = CA.cli_command("claude", "q", "claude-sonnet-5-5", Path("m.json"), Path("s.txt"))
    assert cmd[cmd.index("--tools") + 1] == ""
    assert cmd[cmd.index("--allowedTools") + 1] == "mcp__streetscope"
    assert "--strict-mcp-config" in cmd and "--no-session-persistence" in cmd


def test_run_cli_reads_trace_and_checks_numbers(site, monkeypatch):
    monkeypatch.setattr(CA, "claude_cli", lambda: "claude")

    def fake_run(cmd, cwd, env, **kw):
        assert "CLAUDECODE" not in env
        cfg = json.loads(Path(cmd[cmd.index("--mcp-config") + 1]).read_text(encoding="utf-8"))
        args = cfg["mcpServers"]["streetscope"]["args"]
        out = T.traffic_areas(site, 1)
        Path(args[-1]).write_text(json.dumps({"tool": "traffic_areas", "args": {"top": 1}, "result": out}) + "\n", encoding="utf-8")
        score = out["areas"][0]["score"]
        body = {"type": "result", "subtype": "success", "is_error": False, "result": f"Area 1 scores {score}, and 4242 cars.",
                "num_turns": 2, "total_cost_usd": 0.01, "session_id": "s"}
        return NS(stdout=json.dumps(body), stderr="", returncode=0)

    trace = []
    out = CA.run_cli(site, "Where is traffic worst?", trace, runner=fake_run)
    assert [t["tool"] for t in trace] == ["traffic_areas"]
    assert out["unverified_numbers"] == [4242.0] and out["llm"]["provider"] == "Claude Code (your login)"


def test_run_cli_raises_on_error(site, monkeypatch):
    monkeypatch.setattr(CA, "claude_cli", lambda: "claude")
    fake = lambda cmd, **kw: NS(stdout=json.dumps({"subtype": "error_max_turns", "is_error": True}), stderr="", returncode=1)
    with pytest.raises(RuntimeError):
        CA.run_cli(site, "x", [], runner=fake)


def test_auto_backend_prefers_key_then_cli(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LLM_BACKEND", "CLAUDE_CLI"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(CA.shutil, "which", lambda name: "C:/bin/claude.exe")
    assert CA.backend() == "cli" and CA.llm_status()["provider"] == "Claude Code (your login)"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    assert CA.backend() == "anthropic"
