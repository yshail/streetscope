"""Local stand-in for the Lambda, plus the twin builder for GreenCityAI.

POST /ask        {"site":"aiims","question":"..."}            the doctor (Claude Sonnet 5.5, or offline answers)
GET  /status                                                  which model answers
POST /build      {"lat":..,"lon":..,"radius":500,"name":".."}  build a twin for any place (background job)
GET  /build/<id>                                              progress of that job
GET  /context?lat=..&lon=..&r=900                             map context (OpenStreetMap), cached on disk

The doctor uses Claude through your Claude Code login (no API key), ANTHROPIC_API_KEY, or LLM_BACKEND=bedrock.
Run: python scripts/dev_api.py
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "pipeline"), str(ROOT / "agent"), str(ROOT / "scripts")]
os.environ.setdefault("TWIN_DIR", str(ROOT / "web" / "data"))

from streetscope_agent.handler import lambda_handler  # noqa: E402
import builder  # noqa: E402
import context_proxy  # noqa: E402
from urllib.parse import parse_qs, urlparse  # noqa: E402


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-ask-token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code: int, body):
        data = (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            return self._json(200, lambda_handler({"requestContext": {"http": {"method": "GET"}}})["body"])
        if self.path.startswith("/context"):
            q = parse_qs(urlparse(self.path).query)
            try:
                data = context_proxy.fetch(float(q["lat"][0]), float(q["lon"][0]), int(float(q.get("r", ["900"])[0])))
            except Exception as exc:
                return self._json(503, {"error": str(exc)})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(data)
            return
        if self.path.startswith("/build/"):
            job = builder.get(self.path.split("/")[-1])
            return self._json(200 if job else 404, job or {"error": "no such job"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        if self.path == "/ask":
            res = lambda_handler({"body": body, "headers": dict(self.headers)})
            return self._json(res["statusCode"], res["body"])
        if self.path == "/build":
            try:
                b = json.loads(body or "{}")
                job = builder.start(float(b["lat"]), float(b["lon"]), float(b.get("radius", 400)), str(b.get("name") or "New site")[:60],
                                    float(b.get("tz", round(float(b["lon"]) / 15))), bool(b.get("lidar", True)))
                return self._json(200, job)
            except (KeyError, ValueError) as exc:
                return self._json(400, {"error": str(exc)})
        self._json(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    from streetscope_agent.handler import status

    st = status()
    mode = f"{st['model']} via {st['provider']} (falls back to offline on errors)" if st["mode"] != "offline" else "offline only"
    print("Doctor API on http://localhost:8766/ask ,", mode)
    print("Twin builder on http://localhost:8766/build (any place on Earth)")
    ThreadingHTTPServer(("localhost", 8766), H).serve_forever()
