"""Loopback-only browser fixture; temporary storage and synthetic credentials."""
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import urllib.request
from test_initialization import Instance, ROOT

if len(sys.argv) > 1 and sys.argv[1] == "init":
    instance = Instance.__new__(Instance)
    instance.database = Path(os.environ["TEST_DATABASE"])
    instance.files = Path(os.environ["TEST_FILES"])
    code, output = instance.initialize()
    if code:
        print(output)
    sys.exit(code)

with tempfile.TemporaryDirectory(prefix="filehop-browser-") as root:
    instance = Instance(Path(root))
    process, backend = instance.start()
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/api/"):
                with urllib.request.urlopen(backend + self.path) as response:
                    self.send_response(response.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(response.read())
            else:
                super().do_GET()
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT / "web/dist")))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        environment = dict(os.environ, TEST_BASE_URL=f"http://127.0.0.1:{server.server_port}",
                           TEST_DATABASE=str(instance.database), TEST_FILES=str(instance.files))
        result = subprocess.run(["npm", "--prefix", str(ROOT / "web"), "run", "test:e2e"], env=environment)
    finally:
        server.shutdown()
        server.server_close()
        process.terminate()
        process.communicate(timeout=10)
    sys.exit(result.returncode)
