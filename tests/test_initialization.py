"""Public CLI + HTTP contract tests. Only TemporaryDirectory data is used."""
import json
import os
import pty
import time
from pathlib import Path
import select
import subprocess
import tempfile
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("FILEHOP_TEST_BINARY", ROOT / "backend/target/debug/backend"))


class Instance:
    def __init__(self, root):
        self.database = root / "database"
        self.files = root / "files"
        self.database.mkdir()
        self.files.mkdir()

    def command(self, *args):
        return [str(BINARY), "--database-dir", str(self.database),
                "--files-dir", str(self.files), *args]

    def initialize(self, username="Admin", password=" synthetic password ", file_limit=None):
        # A real terminal exercises hidden password entry; no password CLI flag.
        master, slave = pty.openpty()
        def terminal():
            import fcntl
            import termios
            if file_limit is not None:
                import resource
                import signal
                resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))
                signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        process = subprocess.Popen(
            self.command("init", "--username", username, "--confirm-paths"),
            stdin=slave, stdout=slave, stderr=slave, preexec_fn=terminal)
        os.close(slave)
        output = b""
        sent = False
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 4096)
                    except OSError:
                        break
                    if not data:
                        break
                    output += data
                    if b"Password: " in output and not sent:
                        os.write(master, (password + "\n").encode())
                        sent = True
                if process.poll() is not None:
                    break
            process.wait(timeout=2)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
        return process.returncode, output.decode(errors="replace")

    def start(self):
        process = subprocess.Popen(
            self.command("serve", "--listen", "127.0.0.1:0"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if not select.select([process.stdout], [], [], 15)[0]:
            process.kill()
            raise AssertionError("server did not start")
        line = process.stdout.readline().strip()
        if not line.startswith("listening="):
            process.kill()
            raise AssertionError(f"server failed: {line} {process.communicate()[1]}")
        return process, "http://" + line.removeprefix("listening=")


class InitializationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="filehop-test-")
        self.addCleanup(self.temp.cleanup)
        self.instance = Instance(Path(self.temp.name))

    def status(self):
        process, url = self.instance.start()
        try:
            with urllib.request.urlopen(url + "/api/status") as response:
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                return json.load(response)
        finally:
            process.terminate()
            process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0)

    def test_fresh_start_is_uninitialized_and_does_not_create_storage(self):
        self.assertEqual(self.status(), {"state": "uninitialized"})
        self.assertEqual(list(self.instance.database.iterdir()), [])
        self.assertEqual(list(self.instance.files.iterdir()), [])

    def test_confirmation_is_required_and_password_argument_is_rejected(self):
        for args in [("init", "--username", "admin"),
                     ("init", "--username", "admin", "--confirm-paths", "--password", "synthetic")]:
            result = subprocess.run(self.instance.command(*args), capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.instance.database.iterdir()), [])
        self.assertEqual(list(self.instance.files.iterdir()), [])

    def test_business_writes_are_unavailable_before_and_after_initialization(self):
        import urllib.error
        for initialized in [False, True]:
            if initialized:
                self.assertEqual(self.instance.initialize()[0], 0)
            process, url = self.instance.start()
            try:
                for path in ["/api/messages", "/api/session", "/api/status"]:
                    request = urllib.request.Request(url + path, data=b'{}', method="POST")
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(request)
                    self.assertIn(error.exception.code, [404, 405])
                    error.exception.close()
            finally:
                process.terminate()
                process.communicate(timeout=10)

    def test_symlinked_database_is_refused(self):
        self.assertEqual(self.instance.initialize()[0], 0)
        database = self.instance.database / "transfer.db"
        original = self.instance.database / "original.db"
        database.rename(original)
        database.symlink_to(original)
        self.assertEqual(self.status(), {"state": "storage_error"})

    def test_partial_write_reports_partial_state_and_never_cleans_up(self):
        code, output = self.instance.initialize(file_limit=10)
        self.assertNotEqual(code, 0)
        self.assertIn("partially completed", output)
        self.assertTrue(any(self.instance.database.iterdir()))
        self.assertEqual(self.status(), {"state": "storage_error"})
        self.assertNotEqual(self.instance.initialize()[0], 0)

    def test_concurrent_initializers_cannot_both_succeed(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.instance.initialize()[0], range(2)))
        self.assertEqual(results.count(0), 1)
        self.assertEqual(self.status(), {"state": "initialized"})

    def test_reinitialization_preserves_original_files(self):
        self.assertEqual(self.instance.initialize()[0], 0)
        before = {p: p.read_bytes() for directory in [self.instance.database, self.instance.files]
                  for p in directory.iterdir() if p.is_file()}
        code, output = self.instance.initialize("Other", "another password")
        self.assertNotEqual(code, 0)
        self.assertIn("refusing", output)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(self.status(), {"state": "initialized"})

    def test_unknown_residue_is_preserved_and_refused(self):
        residue = self.instance.files / "unrelated.txt"
        residue.write_text("do not delete")
        self.assertNotEqual(self.instance.initialize()[0], 0)
        self.assertEqual(residue.read_text(), "do not delete")
        self.assertEqual(list(self.instance.database.iterdir()), [])
        self.assertEqual(self.status(), {"state": "storage_error"})

    def test_missing_database_never_creates_replacement(self):
        self.assertEqual(self.instance.initialize()[0], 0)
        database = self.instance.database / "transfer.db"
        database.rename(self.instance.database / "original.db")
        self.assertEqual(self.status(), {"state": "storage_error"})
        self.assertFalse(database.exists())
        self.assertNotEqual(self.instance.initialize()[0], 0)
        self.assertFalse(database.exists())

    def test_mismatched_or_missing_identity_fails_closed(self):
        self.assertEqual(self.instance.initialize()[0], 0)
        marker = self.instance.files / "storage-id"
        marker.write_text("f966a9c0-cf17-4e71-a035-3a459dbb541d")
        self.assertEqual(self.status(), {"state": "storage_error"})
        marker.unlink()
        self.assertEqual(self.status(), {"state": "storage_error"})
        self.assertNotEqual(self.instance.initialize()[0], 0)
        self.assertFalse(marker.exists())

    def test_invalid_credentials_leave_directories_empty(self):
        for username, password in [("ab", "long enough password"), (" space", "long enough password"),
                                   ("管理员", "long enough password"), ("admin", "短" * 11),
                                   ("admin", "a" * 129)]:
            with self.subTest(username=username, length=len(password)):
                self.assertNotEqual(self.instance.initialize(username, password)[0], 0)
                self.assertEqual(list(self.instance.database.iterdir()), [])
                self.assertEqual(list(self.instance.files.iterdir()), [])

    def test_unicode_password_uses_codepoints_not_bytes(self):
        self.assertEqual(self.instance.initialize(password="密" * 12)[0], 0)
        self.assertEqual(self.status(), {"state": "initialized"})

    def test_inaccessible_file_directory_fails_closed(self):
        self.assertEqual(self.instance.initialize()[0], 0)
        self.instance.files.chmod(0o500)
        try:
            self.assertEqual(self.status(), {"state": "storage_error"})
        finally:
            self.instance.files.chmod(0o700)

    def test_read_only_storage_is_not_reported_ready(self):
        self.assertEqual(self.instance.initialize()[0], 0)
        database = self.instance.database / "transfer.db"
        database.chmod(0o400)
        try:
            self.assertEqual(self.status(), {"state": "storage_error"})
        finally:
            database.chmod(0o600)

    def test_running_status_observes_initialization_without_restart(self):
        process, url = self.instance.start()
        try:
            self.assertEqual(self.instance.initialize()[0], 0)
            with urllib.request.urlopen(url + "/api/status") as response:
                self.assertEqual(json.load(response), {"state": "initialized"})
        finally:
            process.terminate()
            process.communicate(timeout=10)

    def test_explicit_initialization_survives_restart_and_hides_password(self):
        code, output = self.instance.initialize()
        self.assertEqual(code, 0, output)
        self.assertNotIn("synthetic password", output)
        self.assertEqual(self.status(), {"state": "initialized"})
        self.assertEqual(self.status(), {"state": "initialized"})


if __name__ == "__main__":
    unittest.main()
