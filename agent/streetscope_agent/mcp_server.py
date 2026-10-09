"""The measuring tools as a tiny MCP server (stdio, JSON-RPC), so the `claude` command line can call them.

Run by claude_agent.run_cli, never by hand:  python -m streetscope_agent.mcp_server <site folder> <trace file>
Every call and its result is appended to the trace file, so the answer can be number-checked afterwards.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import tools as T


def _send(msg: dict) -> None:
    sys.stdout.buffer.write(json.dumps(msg).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def _reply(req_id, result=None, error=None) -> None:
    msg = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    _send(msg)


def handle(site: T.Site, trace_path: Path, msg: dict) -> dict | None:
    """Answer one JSON-RPC message. Returns the reply, or None for notifications."""
    method, req_id, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if req_id is None:
        return None                                    # notifications (initialized, cancelled) need no reply
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "streetscope", "version": "1.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [{"name": s["name"], "description": s["description"], "inputSchema": s["input_schema"]} for s in T.TOOL_SPECS]}
    if method == "tools/call":
        name, args = params.get("name", ""), dict(params.get("arguments") or {})
        fn = T.TOOLS.get(name)
        if fn is None:
            return {"content": [{"type": "text", "text": f"error: unknown tool {name}"}], "isError": True}
        try:
            out = fn(site, **args)
        except Exception as exc:
            return {"content": [{"type": "text", "text": f"error: {exc}"}], "isError": True}
        with trace_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"tool": name, "args": args, "result": out}) + "\n")
        return {"content": [{"type": "text", "text": json.dumps(out)}]}
    raise LookupError(method)


def main() -> None:
    site, trace_path = T.Site(sys.argv[1]), Path(sys.argv[2])
    for line in sys.stdin.buffer:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        try:
            res = handle(site, trace_path, msg)
            if res is not None:
                _reply(msg["id"], res)
        except LookupError:
            _reply(msg.get("id"), error={"code": -32601, "message": f"method not found: {msg.get('method')}"})


if __name__ == "__main__":
    main()
