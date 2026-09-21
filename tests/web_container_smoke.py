"""Check Docker secret exclusions and the actual non-root Vite runtime.

Uses synthetic files, disposable containers, no published ports or shared network.
Build filehop-issue6-web before running; FILEHOP_WEB_IMAGE can override the tag.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix="filehop-context-test-") as temporary:
    root = Path(temporary)
    for name in [".env", ".env.local", "web/.env", "web/.env.local", "web/nested/.env.production"]:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("SYNTHETIC_TEST_ONLY=not-a-secret\n")
    (root / "safe.txt").write_text("included")
    (root / ".dockerignore").write_text((ROOT / ".dockerignore").read_text())
    (root / "Dockerfile").write_text("FROM scratch\nCOPY . /context/\n")
    output = root / "output"
    subprocess.run(["docker", "build", "--output", f"type=local,dest={output}", str(root)], check=True)
    assert (output / "context/safe.txt").is_file()
    leaked = list((output / "context").rglob(".env*"))
    assert not leaked, f"Environment files included in Docker context: {leaked}"

name = "filehop-web-test-" + uuid.uuid4().hex[:12]
image = os.environ.get("FILEHOP_WEB_IMAGE", "filehop-issue6-web")
command = ["docker", "run", "--detach", "--name", name, "--network", "none",
           "--env", "FILEHOP_DEV_HOST=transfer-dev.example.invalid"]
# Mirror the read-only mounts used by the development Compose configuration.
for relative in ["src", "index.html", "vite.config.ts"]:
    command += ["--mount", f"type=bind,src={ROOT / 'web' / relative},dst=/app/{relative},readonly"]
command.append(image)
try:
    subprocess.run(command, check=True)
    identity = subprocess.check_output(["docker", "exec", name, "id", "-u"], text=True).strip()
    assert identity != "0", "Vite must run as a non-root user"
    # Request transformed source too: an HTML response alone misses cache/write failures.
    probe = """
const deadline = Date.now() + 20000;
let lastError;
while (Date.now() < deadline) {
  try {
    for (const path of ['/', '/src/main.tsx', '/src/App.tsx']) {
      const response = await fetch('http://127.0.0.1:5173' + path);
      if (!response.ok) throw new Error(path + ': ' + response.status);
      const body = await response.text();
      if (!body.length) throw new Error('empty response');
    }
    process.exit(0);
  } catch (error) { lastError = error; }
  await new Promise(resolve => setTimeout(resolve, 200));
}
throw lastError;
"""
    subprocess.run(["docker", "exec", name, "node", "--input-type=module", "-e", probe], check=True, timeout=30)
    state = json.loads(subprocess.check_output(["docker", "inspect", name], text=True))[0]
    assert state["State"]["Running"]
    assert not state["HostConfig"]["PortBindings"]
    print("Non-root Vite serves HTML and transformed source with read-only development mounts.")
finally:
    subprocess.run(["docker", "logs", name], check=False)
    subprocess.run(["docker", "rm", "--force", name], check=False)
