"""Run the backend through isolated Compose, with no published ports or shared network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid
import urllib.request
from test_initialization import Instance

with tempfile.TemporaryDirectory(prefix="filehop-compose-") as temporary:
    root = Path(temporary).resolve()
    root.chmod(0o755)
    for name in ["database", "files"]:
        (root / name).mkdir()
    # Run as the caller, so disposable data never needs privileged cleanup.
    config = {
        "services": {"backend": {
            "image": "filehop-issue6-backend",
            "user": f"{os.getuid()}:{os.getgid()}",
            "network_mode": "none",
            "volumes": [f"{root / 'database'}:/data/database", f"{root / 'files'}:/data/files"],
        }}
    }
    path = root / "compose.json"
    path.write_text(json.dumps(config))
    compose = ["docker", "compose", "-p", "filehop-test-" + uuid.uuid4().hex[:12], "-f", str(path)]
    try:
        subprocess.run([*compose, "up", "-d"], check=True)
        # Lifecycle smoke of uninitialized diagnostics; detailed HTTP/CLI contracts
        # are covered by tests/test_initialization.py and browser.py.
        subprocess.run([*compose, "exec", "-T", "backend", "filehop", "--help"], check=True)
        subprocess.run([*compose, "up", "-d", "--force-recreate"], check=True)
        result = subprocess.check_output([*compose, "ps", "--format", "json"], text=True)
        assert json.loads(result)["State"] == "running", result
        assert list((root / "database").iterdir()) == []
        assert list((root / "files").iterdir()) == []
        instance = Instance.__new__(Instance)
        instance.database = root / "database"
        instance.files = root / "files"
        instance.command = lambda *args: [*compose, "exec", "-it", "backend", "filehop", *args]
        code, output = instance.initialize()
        assert code == 0, output
        subprocess.run([*compose, "up", "-d", "--force-recreate"], check=True)
        subprocess.run([*compose, "stop"], check=True)
        # Inspect the exact mounted data via the public HTTP interface after recreation.
        del instance.command
        process, url = instance.start()
        try:
            with urllib.request.urlopen(url + "/api/status") as response:
                assert json.load(response) == {"state": "initialized"}
        finally:
            process.terminate()
            process.communicate(timeout=10)
        print("Isolated Compose initialization and recreation passed; no ports published.")
    finally:
        subprocess.run([*compose, "down"], check=True)
