#!/usr/bin/env python3
"""Exercise helper port ownership against real throwaway servers."""
import concurrent.futures
import errno
import json
import os
from pathlib import Path
import shlex
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


def bind_port(port=0):
    listener = None
    try:
        listener = socket.socket(socket.AF_INET6)
        listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        listener.bind(("::", port))
    except OSError as error:
        if listener is not None:
            listener.close()
        if error.errno not in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.EADDRNOTAVAIL):
            raise
        listener = socket.socket(socket.AF_INET)
        listener.bind(("0.0.0.0", port))
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
        for name in ("first", "second", "collision", "broken"):
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
            for url in urls:
                issuer = get(url + "/auth/.well-known/oauth-authorization-server")["issuer"]
                expected_origin = urllib.parse.urlparse(url.replace("127.0.0.1", "localhost"))
                actual_origin = urllib.parse.urlparse(issuer)
                assert (actual_origin.scheme, actual_origin.netloc) == (expected_origin.scheme, expected_origin.netloc), issuer
                assert not url.endswith(f":{candidate}")
            collision = environments[2] | {"PORT": str(candidate)}
            result = subprocess.run([scripts / "server-up.sh"], env=collision, capture_output=True, text=True)
            assert result.returncode != 0, "occupied explicit port booted"
            assert "EADDRINUSE" in result.stderr, result.stderr
            assert not Path(collision["MARFA_SERVER_ENV"]).exists(), "failed boot left its env file"
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
        finally:
            for env in environments:
                path = Path(env["MARFA_SERVER_ENV"])
                if path.exists():
                    subprocess.run([scripts / "server-down.sh", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print("Atomic automatic ports, distinct instances, auth origins and explicit-port refusal passed.")
