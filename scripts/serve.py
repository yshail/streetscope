"""Serve web/ at http://localhost:8765 with no caching. Run: python scripts/serve.py"""
import http.server, os, socketserver
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("localhost", 8765), H) as s:
    print("Serving http://localhost:8765/ (no cache)")
    s.serve_forever()
