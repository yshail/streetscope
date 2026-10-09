"""The Claude tool loop, driven by a fake client so no key or network is needed."""

import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from streetscope_agent import agent as A
from streetscope_agent import claude_agent as CA
from streetscope_agent import handler as H
from streetscope_agent import tools as T

SITE_DIR = Path(__file__).resolve().parents[2] / "web" / "data" / "dupont"


@pytest.fixture(scope="module")
def site():
    return T.Site(SITE_DIR)


class FakeClient:
    """Plays back scripted turns. A turn is a list of ("tool", name, input) or ("text", str)."""

    def __init__(self, turns, answer_from=None):
        self.turns, self.calls, self.answer_from = list(turns), [], answer_from
        self.messages = self
        self.beta = NS(messages=self)

    def create(self, **kw):
        self.calls.append(kw)
        turn = self.turns.pop(0)
        if callable(turn):
            turn = turn(kw)
        blocks = []
        for i, b in enumerate(turn):
            if b[0] == "tool":
                blocks.append(NS(type="tool_use", id=f"t{len(self.calls)}_{i}", name=b[1], input=b[2]))
            else:
                blocks.append(NS(type="text", text=b[1]))
        stop = "tool_use" if any(b.type == "tool_use" for b in blocks) else "end_turn"
        return NS(content=blocks, stop_reason=stop, usage=NS(input_tokens=10, output_tokens=5), _request_id="req_x")


def _tool_result(kw, name):
    """The JSON a tool returned, read back out of the conversation the loop sent."""
    for m in kw["messages"]:
        if m["role"] == "user" and isinstance(m["content"], list):
            for r in m["content"]:
                if r.get("type") == "tool_result" and not r.get("is_error"):
                    out = json.loads(r["content"])
                    if (name == "traffic_areas" and "areas" in out) or (name == "propose_solutions" and "solutions" in out):
                        return out
    raise AssertionError("tool result not found")


def test_tool_specs_cover_every_tool():
    names = {s["name"] for s in T.TOOL_SPECS}
    assert names == set(T.TOOLS)
    for s in T.TOOL_SPECS:
        assert s["input_schema"]["type"] == "object" and s["description"]


def test_traffic_tools_read_the_twin(site):
    a = T.traffic_areas(site, 3)
    assert a["available"] and len(a["areas"]) <= 3 and "simulated" in a["method"]
    p = T.propose_solutions(site)
    assert p["available"] and p["solutions"] and "ASSUMED" in p["cost_basis"]
    assert p["area"]["id"] == a["areas"][0]["id"]
    assert T.propose_solutions(site, 999)["available"] is False


def test_loop_runs_tools_and_verifies_numbers(site):
    def answer(kw):
        top = _tool_result(kw, "traffic_areas")["areas"][0]
        return [("text", f"The worst simulated area scores {top['score']} with load {top['load_ratio']}.")]

    fake = FakeClient([[("tool", "traffic_areas", {"top": 3})], answer])
    trace = []
    out = CA.run(site, "Where is traffic worst?", trace, client=fake, model="claude-sonnet-5-5", provider="Anthropic API")
    assert out["verified"] and out["unverified_numbers"] == []
    assert [t["tool"] for t in trace] == ["traffic_areas"]
    assert out["llm"]["turns"] == 2 and out["llm"]["request_ids"] == ["req_x", "req_x"]
    first = fake.calls[0]
    assert first["model"] == "claude-sonnet-5-5" and first["tools"] is T.TOOL_SPECS and "temperature" not in first


def test_loop_flags_invented_numbers(site):
    fake = FakeClient([[("tool", "site_summary", {})], [("text", "There are 98765 cars an hour here.")]])
    out = CA.run(site, "How busy is it?", [], client=fake, provider="Anthropic API")
    assert not out["verified"] and 98765.0 in out["unverified_numbers"]


def test_bad_tool_call_goes_back_as_an_error(site):
    fake = FakeClient([[("tool", "no_such_tool", {})], [("text", "Sorry, I could not measure that.")]])
    CA.run(site, "x", [], client=fake, provider="Anthropic API")
    res = fake.calls[1]["messages"][2]["content"][0]   # question, Claude's tool call, then our tool result
    assert res["is_error"] and "unknown tool" in res["content"]


def test_refusal_raises(site):
    class Refuse(FakeClient):
        def create(self, **kw):
            return NS(content=[], stop_reason="refusal", usage=None)

    with pytest.raises(RuntimeError):
        CA.run(site, "x", [], client=Refuse([]), provider="Anthropic API")


def test_status_without_keys_is_offline(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LLM_BACKEND", "CLAUDE_CLI"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(CA.shutil, "which", lambda name: None)     # no Claude Code on this machine either
    assert CA.llm_status()["mode"] == "offline" and CA.make_client() is None
    monkeypatch.setenv("LLM_BACKEND", "bedrock")
    st = CA.llm_status()
    assert st["mode"] == "claude" and st["model"] == "anthropic.claude-sonnet-5-5"


def test_offline_traffic_answer_is_verified(site):
    out = A.offline_answer(site, "Where is the traffic jam worst and what should we do?")
    assert out["verified"], out
    assert "Simulated" in out["answer"] and any(p.get("kind") == "traffic" for p in out["map_points"])


def test_offline_brief_has_three_sections(site):
    out = A.offline_brief(site)
    assert out["verified"], out["unverified_numbers"]
    for h in ("Where it hurts", "What we would try", "How sure we are"):
        assert h in out["answer"]


def test_handler_status_and_brief_offline(monkeypatch):
    monkeypatch.setenv("TWIN_DIR", str(SITE_DIR.parent))
    monkeypatch.setenv("USE_LLM", "0")
    monkeypatch.delenv("ASK_TOKEN", raising=False)
    st = json.loads(H.lambda_handler({"requestContext": {"http": {"method": "GET"}}})["body"])
    assert st["mode"] == "offline"
    r = H.lambda_handler({"body": json.dumps({"site": "dupont", "mode": "brief"})})
    assert r["statusCode"] == 200 and "How sure we are" in json.loads(r["body"])["answer"]
