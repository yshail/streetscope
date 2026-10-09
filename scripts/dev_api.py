"""Local stand-in for the Lambda. POST http://localhost:8766/ask  {"site":"aiims","question":"..."}

Uses Bedrock when AWS credentials work, otherwise the offline answer. Run: python scripts/dev_api.py
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "pipeline"), str(ROOT / "agent")]
os.environ.setdefault("TWIN_DIR", str(ROOT / "web" / "data"))

from streetscope_agent.handler import lambda_handler  # noqa: E402


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-ask-token")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != "/ask":
            self.send_response(404)
            self.end_headers()
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        res = lambda_handler({"body": body, "headers": dict(self.headers)})
        self.send_response(res["statusCode"])
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(res["body"].encode("utf-8"))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    mode = "Bedrock (falls back to offline if credentials fail)" if os.environ.get("USE_LLM", "1") == "1" else "offline only"
    print("Doctor API on http://localhost:8766/ask ,", mode)
    HTTPServer(("localhost", 8766), H).serve_forever()
