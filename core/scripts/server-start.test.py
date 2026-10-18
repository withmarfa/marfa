#!/usr/bin/env python3
"""Exercise helper port ownership against real throwaway servers."""
import concurrent.futures
import fcntl
import http.server
import threading
import time
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

scripts = Path(__file__).resolve().parent


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        name, value = line.removeprefix("export ").split("=", 1)
        values[name] = shlex.split(value)[0]
    return values


def get(url):
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)


def lock_available(path):
    with path.open("a") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True


def bind_port(port=0):
    listener = socket.socket(socket.AF_INET)
    listener.bind(("127.0.0.1", port))
    return listener


with tempfile.TemporaryDirectory(prefix="marfa-start-") as directory:
    work = Path(directory)
    # A witness for the former bind-close-bind race: the old chooser is made
    # to return a candidate another listener already holds.
    with bind_port() as occupied:
        occupied.listen()
        candidate = occupied.getsockname()[1]
        shim = work / "bin"
        shim.mkdir()
        python = shim / "python3"
        python.write_text(f"#!{sys.executable}\nimport os, sys\n"
                          f"if len(sys.argv)>2 and 's.bind' in sys.argv[2]: print({candidate})\n"
                          f"else: os.execv({sys.executable!r}, [{sys.executable!r}] + sys.argv[1:])\n")
        python.chmod(0o700)
        environments = []
        for name in ("first", "second", "collision", "broken", "ipv4", "shared-env", "racing"):
            env = dict(os.environ)
            for key in ("PORT", "MARFA_SERVER_KEEP", "MARFA_CONTROL_SOCKET", "MARFA_AUTH_BASE_URL"):
                env.pop(key, None)
            env["MARFA_SERVER_REPO"] = str(scripts.parents[1])
            env["PATH"] = str(shim) + os.pathsep + env["PATH"]
            env["MARFA_SERVER_ENV"] = str(work / f"{name}.env")
            env["MARFA_SERVER_KEEP"] = str(work / f"{name}-state")
            environments.append(env)

        def up(env):
            result = subprocess.run([scripts / "server-up.sh"], env=env, capture_output=True, text=True)
            if result.returncode:
                raise AssertionError(result.stderr)
            return read_env(Path(env["MARFA_SERVER_ENV"]))

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                first, second = list(pool.map(up, environments[:2]))
            assert "Marfa server listening on port" in (Path(first["MARFA_SERVER_STATE"]) / "server.log").read_text()
            urls = [first["MARFA_TEST_URL"], second["MARFA_TEST_URL"]]
            assert urls[0] != urls[1]
            identities = [get(url + "/")["instance_id"] for url in urls]
            assert identities[0] != identities[1]
            for instance, expected in zip((first, second), identities):
                private = json.loads(subprocess.check_output(["curl", "-fsS", "--unix-socket", instance["MARFA_TEST_SOCKET"], "http://localhost/"]))
                assert private["instance_id"] == expected, "published URL reaches a different instance"
            for url in urls:
                issuer = get(url + "/auth/.well-known/oauth-authorization-server")["issuer"]
                expected_origin = urllib.parse.urlparse(url.replace("127.0.0.1", "localhost"))
                actual_origin = urllib.parse.urlparse(issuer)
                assert (actual_origin.scheme, actual_origin.netloc) == (expected_origin.scheme, expected_origin.netloc), issuer
                assert not url.endswith(f":{candidate}")
            class Witness(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"witness": true}')

                def log_message(self, *_args):
                    pass

            with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Witness) as witness:
                thread = threading.Thread(target=witness.serve_forever)
                thread.start()
                try:
                    ipv4 = environments[4] | {"PORT": str(witness.server_port)}
                    result = subprocess.run([scripts / "server-up.sh"], env=ipv4, capture_output=True, text=True)
                    assert result.returncode != 0, "helper accepted another instance's IPv4 endpoint"
                    assert "EADDRINUSE" in result.stderr, result.stderr
                    assert get(f"http://127.0.0.1:{witness.server_port}/health") == {"witness": True}
                finally:
                    witness.shutdown()
                    thread.join()

            original_env = Path(environments[0]["MARFA_SERVER_ENV"])
            saved_env = original_env.read_bytes()
            state = Path(first["MARFA_SERVER_STATE"])
            saved_boot = (state / "boot.env").read_bytes()
            assert "node" in subprocess.check_output(["ps", "-p", first["MARFA_SERVER_PID"], "-o", "comm="], text=True)
            assert not lock_available(state / "server.lock"), "server lost its state reservation"
            assert not lock_available(original_env), "server lost its env reservation"
            for duplicate in (environments[0], environments[5] | {"MARFA_SERVER_ENV": str(original_env)}):
                saved_log = (state / "server.log").read_bytes()
                result = subprocess.run([scripts / "server-up.sh"], env=duplicate, capture_output=True, text=True)
                observed = original_env.read_bytes() if original_env.exists() else None
                # Preserve the original process's shutdown metadata even on a failed witness.
                original_env.write_bytes(saved_env)
                assert result.returncode != 0, "duplicate helper booted"
                assert observed == saved_env, "duplicate replaced the running server's env file"
                assert (state / "boot.env").read_bytes() == saved_boot
                # The running server may append, but its earlier bytes must remain.
                assert (state / "server.log").read_bytes().startswith(saved_log)
                assert get(urls[0] + "/")["instance_id"] == identities[0]

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                starts = list(pool.map(lambda _index: subprocess.run(
                    [scripts / "server-up.sh"], env=environments[6], capture_output=True, text=True), range(2)))
            assert sorted(result.returncode for result in starts) == [0, 1], "concurrent duplicate starts did not have one owner"
            racing = read_env(Path(environments[6]["MARFA_SERVER_ENV"]))
            assert get(racing["MARFA_TEST_URL"] + "/")["instance_id"]
            collision = environments[2] | {"PORT": str(candidate)}
            result = subprocess.run([scripts / "server-up.sh"], env=collision, capture_output=True, text=True)
            assert result.returncode != 0, "occupied explicit port booted"
            assert "EADDRINUSE" in result.stderr, result.stderr
            assert not Path(collision["MARFA_SERVER_ENV"]).exists(), "failed boot left its env file"
            assert lock_available(Path(collision["MARFA_SERVER_KEEP"]) / "server.lock")
            # A failure after reservation must also close its listener and state.
            broken_state = work / "broken-state"
            broken_state.mkdir()
            (broken_state / "blobs").write_text("occupied")
            with bind_port() as released:
                startup_port = released.getsockname()[1]
            broken = environments[3] | {"MARFA_SERVER_KEEP": str(broken_state), "PORT": str(startup_port)}
            result = subprocess.run([scripts / "server-up.sh"], env=broken, capture_output=True, text=True)
            assert result.returncode != 0, "invalid blob path booted"
            assert "Marfa server listening on port" not in result.stderr
            assert not Path(broken["MARFA_SERVER_ENV"]).exists()
            assert lock_available(broken_state / "server.lock")
            with bind_port(startup_port):
                pass
            with sqlite3.connect(broken_state / "marfa.db", timeout=0) as database:
                database.execute("BEGIN EXCLUSIVE")
                database.rollback()
            # A malformed claim is read after the private socket opens.
            (broken_state / "blobs").unlink()
            with sqlite3.connect(broken_state / "marfa.db") as database:
                database.execute("INSERT INTO settings (key, value) VALUES ('instance.claim', 'null')")
            result = subprocess.run([scripts / "server-up.sh"], env=broken, capture_output=True, text=True)
            assert result.returncode != 0, "malformed claim booted"
            assert "Marfa server listening on port" not in result.stderr
            assert "Private control socket listening" in result.stderr, result.stderr
            for line in result.stderr.splitlines():
                if line.startswith("{"):
                    event = json.loads(line)
                    if event.get("message") == "Private control socket listening":
                        assert not Path(event["path"]).exists(), "failed boot left its control socket"
            with bind_port(startup_port):
                pass
            assert lock_available(broken_state / "server.lock")
            subprocess.run([scripts / "server-down.sh", original_env], check=True)
            assert lock_available(state / "server.lock"), "normal shutdown kept the state reservation"
            restarted = up(environments[0])
            assert restarted["MARFA_TEST_URL"] == first["MARFA_TEST_URL"]
            assert restarted["MARFA_TEST_KEY"] == first["MARFA_TEST_KEY"]
            os.kill(int(restarted["MARFA_SERVER_PID"]), signal.SIGKILL)
            deadline = time.monotonic() + 10
            while not lock_available(state / "server.lock") or not lock_available(original_env):
                assert time.monotonic() < deadline, "crashed server kept its reservations"
                time.sleep(0.05)
            restarted = up(environments[0])
            assert restarted["MARFA_TEST_KEY"] == first["MARFA_TEST_KEY"]
        finally:
            for env in environments:
                path = Path(env["MARFA_SERVER_ENV"])
                if path.exists():
                    subprocess.run([scripts / "server-down.sh", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print("Automatic ports, endpoint ownership, metadata reservations and kept restarts passed.")
