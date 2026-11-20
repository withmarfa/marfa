//! `marfa server`, run as a process against a stand-in for Docker, so the
//! files it writes, the questions it does not ask, and what it refuses are
//! held without an engine. The stand-in keeps its state in files; a thread
//! plays the server's health endpoint once the stand-in has "started" it.

#[allow(dead_code)]
#[path = "support/terminal.rs"]
mod terminal;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

const FAKE_DOCKER: &str = r#"#!/bin/sh
S="$FAKE_DOCKER_STATE"
echo "$*" >> "$S/log"
named() { printf '%s\n' "$*" | sed -n 's/.*name=^\(.*\)\$ --format.*/\1/p'; }
case "$1" in
  compose)
    [ "$2" = version ] && exit 0
    dir="$3"; action="$4"
    name=$(sed -n 's/^MARFA_NAME=//p' "$dir/.env")
    case "$action" in
      pull)
        if [ -e "$S/pull-fails" ]; then echo "failed to extract layer: no space left on device" >&2; exit 1; fi
        touch "$S/image" ;;
      up)
        port=$(sed -n 's/^MARFA_PORT=//p' "$dir/.env")
        release=$(sed -n 's/^MARFA_RELEASE=//p' "$dir/.env")
        touch "$S/c-$name" "$S/vol-$name-data"
        if [ -e "$S/refuses-$release" ]; then
          rm -f "$S/go-$port"; touch "$S/refused-run"
          echo "marfa-server will not start on the database (exit status 78)" > "$S/server-log"
          exit 0
        fi
        if [ -e "$S/refused-run" ]; then rm -f "$S/refused-run" "$S/server-log"; fi
        echo "$release" > "$S/version-$port"
        touch "$S/go-$port" ;;
      down) if [ -e "$S/down-needs-compose" ] && [ ! -e "$dir/compose.yaml" ]; then echo "no configuration file provided" >&2; exit 1; fi; rm -f "$S/c-$name" ;;
    esac
    exit 0 ;;
  info) echo 27.0.0 ;;
  network)
    case "$2" in
      ls) n=$(named "$@"); [ -e "$S/net-$n" ] && echo "$n"; exit 0 ;;
      create) touch "$S/net-$3"; echo id ;;
      inspect) if [ -e "$S/ipam" ]; then cat "$S/ipam"; else echo '[{"Subnet":"172.30.0.0/24","Gateway":"172.30.0.1"}]'; fi ;;
      rm) if [ -e "$S/netbusy-$3" ]; then echo "network $3 has active endpoints" >&2; exit 1; fi; rm -f "$S/net-$3" ;;
    esac ;;
  volume)
    case "$2" in
      ls) n=$(named "$@"); [ -e "$S/vol-$n" ] && echo "$n"; exit 0 ;;
      rm) rm -f "$S/vol-$3" ;;
    esac ;;
  container) n=$(named "$@"); [ -e "$S/c-$n" ] && echo "$n"; exit 0 ;;
  image) [ -e "$S/image" ] ;;
  manifest) case "$3" in
    *:9.9.9) echo "manifest unknown" >&2; exit 1 ;;
    *:8.8.8) echo 'error getting credentials - err: exec: "docker-credential-x": executable file not found in $PATH' >&2; exit 1 ;;
  esac ;;
  rm) rm -f "$S/c-$3" ;;
  pull)
    if [ -e "$S/pull-fails" ]; then echo "failed to extract layer: no space left on device" >&2; exit 1; fi
    touch "$S/image" ;;
  run)
    # The image's server asked whether it opens the database in the volume.
    for word; do case "$word" in ghcr.io/*) tag="${word##*:}" ;; esac; done
    echo "$tag" >> "$S/asked-can-open"
    env | grep '^MARFA_' > "$S/can-open-env"
    if [ -e "$S/ask-fails-$tag" ]; then echo "docker: Error response from daemon: the question could not run" >&2; exit 125; fi
    if [ -e "$S/cannot-open-$tag" ]; then cat "$S/cannot-open-$tag" >&2; exit 78; fi
    echo '{"schema":1,"standing":"current"}' ;;
  inspect)
    # A container the engine cannot say the start of has a current run that cannot be told from an earlier one.
    if [ -e "$S/started-at-unreadable" ]; then echo '{"Status":"running"}'; else echo '{"Status":"running","StartedAt":"2026-01-01T00:00:00.123456789Z"}'; fi ;;
  exec)
    case "$*" in
      *"setup status"*) if [ -e "$S/claimed" ]; then echo '{"claimed":true}'; else echo '{"claimed":false}'; fi ;;
      *"config get"*) if [ -e "$S/address" ]; then printf '{"sign_in_address":"%s"}\n' "$(cat "$S/address")"; else echo '{}'; fi ;;
      *"config update"*) case "$*" in *'"sign_in_address":null'*) rm -f "$S/address" ;; *) printf '%s' "$*" | sed -n 's/.*"sign_in_address":"\([^"]*\)".*/\1/p' > "$S/address" ;; esac; echo '{}' ;;
      *"setup open"*) echo '{"url":"http://localhost/setup#handoff=TICKET123","expires_at":"2030-01-01T00:00:00Z"}' ;;
    esac ;;
  logs)
    # A container keeps the logs of its earlier runs; only a read bounded by the current run's start leaves them out.
    case "$*" in *"--since 2026-01-01T00:00:00.123456789Z"*) ;; *) cat "$S/server-log-earlier" 2>/dev/null ;; esac
    if [ -e "$S/server-log" ]; then cat "$S/server-log"; else echo "a line of the server's log"; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
"#;

/// macOS gives a socket its close-on-exec flag a moment after it makes it, so
/// a child spawned in that moment by another test's thread keeps the socket
/// open for as long as it lives, and the port stays taken. Every socket this
/// file makes, and every spawn, is made under this lock.
static SOCKETS: Mutex<()> = Mutex::new(());

fn output_of(command: &mut Command) -> std::process::Output {
    let child = {
        let _held = SOCKETS.lock().unwrap();
        command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap()
    };
    child.wait_with_output().unwrap()
}

/// Ports this process has reserved, each held as a lock on a file in a folder
/// every test process shares, until the process exits.
static RESERVED: Mutex<Vec<fs::File>> = Mutex::new(Vec::new());

/// A port nothing else holds and no other test process will pick. Test
/// processes run side by side (nextest runs each test in its own), and a
/// rig's health listener binds its port only once an install starts it, so
/// looking for a bound socket cannot see the port another test has chosen:
/// the reservation is the lock. The ports lie below the range the system
/// gives to outgoing connections, which other tests' health checks would
/// otherwise be holding.
fn free_port() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let folder = PathBuf::from("/tmp/marfa-cli-test-ports");
    fs::create_dir_all(&folder).unwrap();
    loop {
        let offset = NEXT.fetch_add(1, Ordering::Relaxed);
        let port = 20_000 + ((std::process::id() % 400) * 20 + u32::from(offset)) % 28_000;
        let port = u16::try_from(port).unwrap();
        let Ok(reservation) = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(folder.join(port.to_string()))
        else {
            continue;
        };
        if reservation.try_lock().is_err() {
            continue;
        }
        let _held = SOCKETS.lock().unwrap();
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            RESERVED.lock().unwrap().push(reservation);
            return port;
        }
    }
}

const FAKE_TAILSCALE: &str = r#"#!/bin/sh
# A Tailscale whose Serve configuration is a file of "port target" lines.
S="$FAKE_DOCKER_STATE"
MAP="$S/serve.map"
touch "$MAP"
echo "$*" >> "$S/tailscale.log"
without() { grep -v "^$1 " "$MAP" > "$MAP.new"; mv "$MAP.new" "$MAP"; }
case "$1 $2" in
  "status --json") echo '{"Self":{"DNSName":"host.example.ts.net."}}' ;;
  "serve status")
    printf '{"Web":{'; first=1
    while read -r port target; do
      [ -z "$port" ] && continue
      [ $first = 1 ] || printf ','; first=0
      printf '"host.example.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}' "$port" "$target"
    done < "$MAP"
    printf '}}\n' ;;
  "serve --bg") port=${3#--https=}; without "$port"; echo "$port $4" >> "$MAP" ;;
  serve\ --https=*) port=${2#--https=}; without "$port" ;;
esac
"#;

const FAKE_LAUNCHCTL: &str = r#"#!/bin/sh
# A launchd that remembers what was loaded, and runs a native server by
# letting the stand-in health endpoint answer.
H="$MARFA_AUTOSTART_ROOT"
S="$FAKE_DOCKER_STATE"
# A real service manager returns once the process has stopped, so the port is
# free. The stand-in health endpoint says when it has let go of its port.
settled() {
  n=0
  while [ -n "$(ls "$S" | grep '^listening-')" ] && [ $n -lt 500 ]; do sleep 0.01; n=$((n+1)); done
}
echo "$*" >> "$H/launchctl.log"
label=$(printf '%s' "$*" | sed -n 's/.*so\.marfa\.server\.\([a-z0-9_-]*\).*/\1/p')
spawn() {
  [ -e "$H/loaded-$label" ] || return 0
  if [ -e "$H/restart-ignored" ] && [ -e "$H/pid-$label" ]; then return 0; fi
  n=$(cat "$H/pidseq" 2>/dev/null || echo 100); n=$((n+1))
  echo $n > "$H/pidseq"; echo $n > "$H/pid-$label"
}
begin() {
  plist="$1"
  grep -q '<string>run</string>' "$plist" || return 0
  spawn
  dir=$(awk '/<string>--dir<\/string>/{getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit}' "$plist")
  name=$(sed -n 's/^MARFA_NAME=//p' "$dir/.env")
  if [ -e "$S/refuse" ]; then
    mkdir -p "$H/Library/Logs/Marfa"
    echo "marfa-server will not start on the database (exit status 78)" >> "$H/Library/Logs/Marfa/$name.log"
    return 0
  fi
  if [ -e "$S/logs-with" ]; then
    mkdir -p "$H/Library/Logs/Marfa"
    cat "$S/logs-with" >> "$H/Library/Logs/Marfa/$name.log"
  fi
  [ -e "$S/stops" ] && return 0
  port=$(sed -n 's/^MARFA_PORT=//p' "$dir/.env")
  prog=$(awk '/<key>ProgramArguments<\/key>/{getline; getline; gsub(/.*<string>|<\/string>.*/, ""); print; exit}' "$plist")
  "$(dirname "$prog")/marfa-server" --version | awk '{print $NF}' > "$S/version-$port"
  # A server that serves names its release beside the database, as releases up to 0.0.85 do not.
  # The server makes its data folder 0700 whatever the umask.
  [ -e "$S/no-release-record" ] || { mkdir -p -m 700 "$dir/data"; cp "$S/version-$port" "$dir/data/marfa.db.release"; }
  touch "$S/go-$port"
}
case "$1" in
  print)
    [ -e "$H/loaded-$label" ] || exit 1
    if [ -e "$H/stopped-$label" ]; then echo "	state = waiting"; else echo "	state = running"; [ -e "$H/pid-query-fails" ] || echo "	pid = $(cat "$H/pid-$label" 2>/dev/null)"; fi ;;
  bootstrap)
    [ -e "$H/bootstrap-fails" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    label=$(basename "$3" .plist | sed 's/^so\.marfa\.server\.//')
    touch "$H/loaded-$label"; rm -f "$H/stopped-$label"; begin "$3" ;;
  kickstart)
    [ "$2" = -k ] && [ -e "$H/restart-fails" ] && { echo "Could not kickstart service: 5: Input/output error" >&2; exit 5; }
    if [ "$2" = -k ] && [ ! -e "$H/restart-ignored" ]; then rm -f "$S"/go-* "$H/pid-$label"; settled; fi
    rm -f "$H/stopped-$label"; f="$H/Library/LaunchAgents/so.marfa.server.$label.plist"; [ -e "$f" ] || f="$H/../install/so.marfa.server.$label.plist"; begin "$f" ;;
  bootout) rm -f "$H/loaded-$label" "$H/pid-$label" "$S"/go-*; settled ;;
esac
"#;

const FAKE_SYSTEMCTL: &str = r#"#!/bin/sh
# A systemd that remembers what is enabled and active, and runs a native
# server by letting the stand-in health endpoint answer.
H="$MARFA_AUTOSTART_ROOT"
S="$FAKE_DOCKER_STATE"
# A real service manager returns once the process has stopped, so the port is
# free. The stand-in health endpoint says when it has let go of its port.
settled() {
  n=0
  while [ -n "$(ls "$S" | grep '^listening-')" ] && [ $n -lt 500 ]; do sleep 0.01; n=$((n+1)); done
}
echo "systemctl $*" >> "$H/systemctl.log"
[ "$1" = --user ] && shift
cmd="$1"; shift
[ "$1" = --quiet ] && shift
unit="$1"
begin() {
  f="$H/.config/systemd/user/$unit"
  dir=$(sed -n 's/.*"--dir" "\{0,1\}\([^" ]*\).*/\1/p' "$f")
  name=$(sed -n 's/^MARFA_NAME=//p' "$dir/.env")
  touch "$H/active-$unit"
  if ! { [ -e "$H/restart-ignored" ] && [ -e "$H/pid-$unit" ]; }; then
    n=$(cat "$H/pidseq" 2>/dev/null || echo 100); n=$((n+1))
    echo $n > "$H/pidseq"; echo $n > "$H/pid-$unit"
  fi
  if [ -e "$S/refuse" ]; then
    echo "marfa-server will not start on the database (exit status 78)" >> "$S/server-log"
    return 0
  fi
  [ -e "$S/logs-with" ] && cat "$S/logs-with" >> "$S/server-log"
  [ -e "$S/stops" ] && return 0
  port=$(sed -n 's/^MARFA_PORT=//p' "$dir/.env")
  prog=$(sed -n 's/^ExecStart="\{0,1\}\([^" ]*\).*/\1/p' "$f")
  "$(dirname "$prog")/marfa-server" --version | awk '{print $NF}' > "$S/version-$port"
  # A server that serves names its release beside the database, as releases up to 0.0.85 do not.
  # The server makes its data folder 0700 whatever the umask.
  [ -e "$S/no-release-record" ] || { mkdir -p -m 700 "$dir/data"; cp "$S/version-$port" "$dir/data/marfa.db.release"; }
  touch "$S/go-$port"
}
case "$cmd" in
  show-environment) [ -e "$H/no-user-session" ] && { echo "Failed to connect to bus" >&2; exit 1; }; exit 0 ;;
  daemon-reload) exit 0 ;;
  enable) touch "$H/enabled-$unit" ;;
  disable) rm -f "$H/enabled-$unit" ;;
  is-enabled) [ -e "$H/enabled-$unit" ] ;;
  is-active) [ -e "$H/active-$unit" ] ;;
  start) [ -e "$H/start-fails" ] && { echo "Job for $unit failed" >&2; exit 1; }; begin ;;
  restart)
    [ -e "$H/start-fails" ] || [ -e "$H/restart-fails" ] && { echo "Job for $unit failed" >&2; exit 1; }
    if [ ! -e "$H/restart-ignored" ]; then rm -f "$S"/go-* "$H/pid-$unit"; settled; fi
    begin ;;
  show) [ -e "$H/pid-query-fails" ] && exit 1; for last; do :; done; cat "$H/pid-$last" 2>/dev/null || echo 0 ;;
  stop) rm -f "$H/active-$unit" "$H/pid-$unit" "$S"/go-*; settled ;;
esac
"#;

const FAKE_LOGINCTL: &str = r#"#!/bin/sh
H="$MARFA_AUTOSTART_ROOT"
case "$1" in
  show-user) cat "$H/linger" 2>/dev/null ;;
  enable-linger)
    [ -e "$H/linger-refused" ] && { echo "Access denied" >&2; exit 1; }
    echo yes > "$H/linger" ;;
esac
"#;

/// The server's log as a journal: each line an entry, whose cursor is its number. A line logged
/// after a cursor is read after it however little time has passed, and `journal-unreadable`
/// makes every call fail.
const FAKE_JOURNALCTL: &str = r#"#!/bin/sh
J="$FAKE_DOCKER_STATE/server-log"
[ -e "$FAKE_DOCKER_STATE/journal-unreadable" ] && { echo "Failed to open journal" >&2; exit 1; }
after=""; json=""; last=""
while [ $# -gt 0 ]; do
  case "$1" in
    --after-cursor=*) after="${1#--after-cursor=}" ;;
    --output=json) json=1 ;;
    -n) shift; last="$1" ;;
  esac
  shift
done
[ -e "$J" ] || exit 0
count=$(wc -l < "$J" | tr -d ' ')
if [ -n "$json" ]; then
  [ "$count" -gt 0 ] && printf '{"__CURSOR":"c%s","MESSAGE":"x"}\n' "$count"
  exit 0
fi
if [ -n "$after" ]; then tail -n +$(( ${after#c} + 1 )) "$J"
elif [ -n "$last" ]; then tail -n "$last" "$J"
else cat "$J"; fi
exit 0
"#;

/// What `marfa-server --version` prints and a server that does nothing.
const FAKE_SERVER: &str = r#"#!/bin/sh
case "$1" in
  --version)
    if [ -n "$FAKE_VERSION_HANG" ]; then exec sleep 60; fi
    if [ -n "$FAKE_VERSION_EXIT" ]; then exit "$FAKE_VERSION_EXIT"; fi
    echo "marfa-server ${FAKE_SERVER_VERSION:-0.0.0}"; exit 0 ;;
  --can-open)
    # Asked only with the install's environment, so the state is found beside the program.
    S="${FAKE_DOCKER_STATE:-$(dirname "$0")/../state}"
    [ "$2" = "$MARFA_DATABASE_PATH" ] || { echo "asked about $2" >&2; exit 9; }
    echo "$2" >> "$S/asked-can-open"
    if [ -e "$S/cannot-open" ]; then cat "$S/cannot-open" >&2; exit 78; fi
    if [ -e "$S/refuse-otel" ] && env | grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT='; then
      echo "OTEL_EXPORTER_OTLP_ENDPOINT must be an http or https URL" >&2; exit 78
    fi
    echo '{"schema":1,"standing":"current"}'; exit 0 ;;
esac
env > "$FAKE_DOCKER_STATE/server-env"
echo $$ > "$FAKE_DOCKER_STATE/server-pid"
if [ -n "$FAKE_SERVER_UPGRADE" ]; then
  echo '"began"' > "$MARFA_INSTALL_DIR/data/update/upgrade.json"
  i=0; while [ "$i" -lt "$FAKE_SERVER_UPGRADE" ]; do sleep 0.1; i=$((i + 1)); done
  echo '"ended"' > "$MARFA_INSTALL_DIR/data/update/upgrade.json"
fi
if [ -n "$FAKE_SERVER_SETTLES" ]; then rm -f "$MARFA_INSTALL_DIR/data/update/pending.json"; fi
if [ -n "$FAKE_SERVER_SAYS" ]; then echo "$FAKE_SERVER_SAYS"; fi
if [ -n "$FAKE_SERVER_HANG" ]; then
  touch "$FAKE_DOCKER_STATE/ready"
  while :; do sleep 0.1; done
fi
if [ -n "$FAKE_SERVER_TRAP" ]; then
  trap "touch '$FAKE_DOCKER_STATE/term'; exit $FAKE_SERVER_TRAP" TERM INT
  touch "$FAKE_DOCKER_STATE/ready"
  while :; do sleep 0.1; done
fi
exit "${FAKE_SERVER_EXIT:-0}"
"#;

/// Answers the `marfa` commands the installer sends to the server's socket.
const FAKE_CONTROL: &str = r#"#!/bin/sh
S="$FAKE_DOCKER_STATE"
echo "$*" >> "$S/control.log"
case "$*" in
  *"setup status"*) if [ -e "$S/claimed" ]; then echo '{"claimed":true}'; else echo '{"claimed":false}'; fi ;;
  *"config get"*) if [ -e "$S/address" ]; then printf '{"sign_in_address":"%s"}\n' "$(cat "$S/address")"; else echo '{}'; fi ;;
  *"config update"*) case "$*" in *'"sign_in_address":null'*) rm -f "$S/address" ;; *) printf '%s' "$*" | sed -n 's/.*"sign_in_address":"\([^"]*\)".*/\1/p' > "$S/address" ;; esac; echo '{}' ;;
  *"setup open"*) echo '{"url":"http://localhost/setup#handoff=TICKET123","expires_at":"2030-01-01T00:00:00Z"}' ;;
  *) echo "{}" ;;
esac
"#;

fn script(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

struct Rig {
    root: PathBuf,
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
    health: Vec<JoinHandle<()>>,
    isolated: std::cell::Cell<bool>,
    /// The umask `marfa` runs under, where a test sets one.
    umask: std::cell::Cell<Option<libc::mode_t>>,
}

impl Rig {
    fn new(name: &str) -> Rig {
        let root = PathBuf::from("/tmp").join(format!("mfs-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let docker = root.join("docker");
        fs::write(&docker, FAKE_DOCKER).unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o755)).unwrap();
        let tailscale = root.join("tailscale");
        fs::write(&tailscale, FAKE_TAILSCALE).unwrap();
        fs::set_permissions(&tailscale, fs::Permissions::from_mode(0o755)).unwrap();
        let home = root.join("home");
        fs::create_dir_all(home.join("bin")).unwrap();
        script(&home.join("bin/launchctl"), FAKE_LAUNCHCTL);
        script(&home.join("bin/systemctl"), FAKE_SYSTEMCTL);
        script(&home.join("bin/loginctl"), FAKE_LOGINCTL);
        script(&home.join("bin/journalctl"), FAKE_JOURNALCTL);
        let tools = root.join("bin");
        fs::create_dir_all(&tools).unwrap();
        script(&tools.join("marfa-server"), FAKE_SERVER);
        script(&root.join("control"), FAKE_CONTROL);
        let port = free_port();
        let stop = Arc::new(AtomicBool::new(false));
        let health = {
            let (stop, state) = (stop.clone(), state.clone());
            std::thread::spawn(move || serve_health(port, &state, &stop))
        };
        Rig {
            isolated: std::cell::Cell::new(false),
            umask: std::cell::Cell::new(None),
            dir: root.join("install"),
            root,
            state,
            port,
            stop,
            health: vec![health],
        }
    }

    fn marfa(&self, args: &[&str]) -> (i32, String, String) {
        self.marfa_with(args, &[])
    }

    /// Runs `marfa` from a copy beside the stand-in `marfa-server`, so that a
    /// real `marfa-server` built next to the test binary is never the one found.
    fn isolate(&self) {
        let copy = self.root.join("bin/marfa");
        if !copy.exists() {
            fs::copy(quiet::marfa().get_program(), &copy).unwrap();
        }
        self.isolated.set(true);
    }

    fn command(&self) -> Command {
        let mut command = if self.isolated.get() {
            quiet::quiet(Command::new(self.root.join("bin/marfa")))
        } else {
            quiet::marfa()
        };
        if let Some(mask) = self.umask.get() {
            // SAFETY: `umask` is async-signal-safe and cannot fail.
            unsafe {
                command.pre_exec(move || {
                    libc::umask(mask);
                    Ok(())
                });
            }
        }
        command
    }

    fn marfa_with(&self, args: &[&str], env: &[(&str, &Path)]) -> (i32, String, String) {
        let mut command = self.command();
        command
            .arg("server")
            .args(args)
            .arg("--dir")
            .arg(&self.dir)
            .env("MARFA_DOCKER", self.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &self.state)
            .env("MARFA_TAILSCALE", self.root.join("tailscale"))
            .env("MARFA_AUTOSTART_ROOT", self.root.join("home"))
            .env("MARFA_SERVER_CONTROL", self.root.join("control"))
            .env("PATH", self.path());
        for (name, value) in env {
            command.env(name, value);
        }
        let output = output_of(&mut command);
        (
            output.status.code().unwrap(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    /// `install` with standard output and error on terminals, as a person sees
    /// it.
    fn install_on_terminal(&self, extra: &[&str], env: &[(&str, &str)]) -> terminal::Ran {
        let port = self.port.to_string();
        let mut command = quiet::marfa();
        command
            .args([
                "server",
                "install",
                "--docker",
                "--release",
                "0.0.92",
                "--port",
                &port,
            ])
            .args(["--yes", "--wait-seconds", "5"])
            .args(extra)
            .arg("--dir")
            .arg(&self.dir)
            .env("MARFA_DOCKER", self.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &self.state)
            .env("MARFA_TAILSCALE", self.root.join("tailscale"))
            .env("MARFA_AUTOSTART_ROOT", self.root.join("home"))
            .env("TERM", "xterm-256color")
            .env_remove("NO_COLOR");
        for (name, value) in env {
            command.env(name, value);
        }
        terminal::run_holding(&mut command, true, true, &SOCKETS)
    }

    fn install(&self, extra: &[&str]) -> (i32, String, String) {
        let port = self.port.to_string();
        let mut args = vec![
            "install",
            "--docker",
            "--release",
            "0.0.92",
            "--port",
            &port,
            "--yes",
            "--wait-seconds",
            "5",
        ];
        args.extend(extra);
        self.marfa(&args)
    }

    /// An install with exactly the options given, apart from not asking.
    fn install_as(&self, extra: &[&str]) -> (i32, String, String) {
        let mut args = vec!["install", "--docker", "--yes", "--wait-seconds", "5"];
        args.extend(extra);
        self.marfa(&args)
    }

    /// An install that must work, whose refusal is said in full.
    fn installed(&self, extra: &[&str]) {
        let (code, stdout, stderr) = self.install(extra);
        assert_eq!(code, 0, "{stdout}\n{stderr}");
    }

    fn file(&self, name: &str) -> String {
        fs::read_to_string(self.dir.join(name)).unwrap()
    }

    fn setting(&self, name: &str) -> Option<String> {
        self.file("marfa.env")
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")).map(str::to_string))
    }

    /// Answers the health check on one more port, once a start names it.
    fn also_listen(&mut self, port: u16) {
        let (stop, state) = (self.stop.clone(), self.state.clone());
        self.health.push(std::thread::spawn(move || {
            serve_health(port, &state, &stop)
        }));
    }

    /// The tools a native install reaches: the stand-in server first.
    fn path(&self) -> String {
        format!("{}:/usr/bin:/bin", self.root.join("bin").display())
    }

    /// The sign-in address the stand-in server holds.
    fn address(&self) -> Option<String> {
        fs::read_to_string(self.state.join("address"))
            .ok()
            .map(|text| text.trim().to_string())
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    fn agent(&self, name: &str) -> PathBuf {
        self.home()
            .join(format!("Library/LaunchAgents/so.marfa.server.{name}.plist"))
    }

    fn log(&self) -> String {
        fs::read_to_string(self.state.join("log")).unwrap_or_default()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for health in self.health.drain(..) {
            let _ = health.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Answers `200` on the port once the stand-in has started a container.
fn serve_health(port: u16, state: &Path, stop: &AtomicBool) {
    let go = state.join(format!("go-{port}"));
    while !stop.load(Ordering::Relaxed) {
        if !go.exists() {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        let listening = state.join(format!("listening-{port}"));
        fs::write(&listening, "").unwrap();
        let listener = {
            let _held = SOCKETS.lock().unwrap();
            TcpListener::bind(("127.0.0.1", port))
        };
        let Ok(listener) = listener else {
            let _ = fs::remove_file(&listening);
            std::thread::sleep(Duration::from_millis(20));
            continue;
        };
        listener.set_nonblocking(true).unwrap();
        while !stop.load(Ordering::Relaxed) && go.exists() {
            let accepted = {
                let _held = SOCKETS.lock().unwrap();
                listener.accept()
            };
            match accepted {
                Ok((mut stream, _)) => {
                    // macOS gives an accepted socket the listener's non-blocking
                    // mode, so a single read can return before the request has
                    // arrived. Closing with request bytes unread then resets the
                    // connection, and the client reports the server as down. The
                    // head is read whole before the answer goes.
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut head = Vec::new();
                    let mut buffer = [0u8; 512];
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(size) => head.extend_from_slice(&buffer[..size]),
                        }
                    }
                    // The instance description names the release that answers.
                    if head.starts_with(b"GET / ") {
                        let reply = match fs::read_to_string(state.join(format!("version-{port}")))
                        {
                            Ok(release) => {
                                let body = format!("{{\"version\":\"{}\"}}", release.trim());
                                format!(
                                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                    body.len()
                                )
                            }
                            Err(_) => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                        };
                        let _ = stream.write_all(reply.as_bytes());
                        continue;
                    }
                    let degraded = fs::read_to_string(state.join("health-body")).ok();
                    let answer: &[u8] = if let Some(body) = &degraded {
                        let (line, body) = body.split_once('\n').unwrap();
                        let reply = format!(
                            "HTTP/1.1 {line}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(reply.as_bytes());
                        continue;
                    } else if state.join("unhealthy").exists() {
                        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno"
                    } else {
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                    };
                    let _ = stream.write_all(answer);
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        drop(listener);
        let _ = fs::remove_file(&listening);
    }
}

fn secrets(rig: &Rig) -> [String; 2] {
    [
        rig.setting("MARFA_KEY_SALT").unwrap(),
        rig.setting("MARFA_AUTH_SECRET").unwrap(),
    ]
}

#[test]
fn a_first_install_writes_the_files_and_prints_the_link_and_no_secret() {
    let rig = Rig::new("first");
    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("http://localhost/setup#handoff=TICKET123"),
        "{stdout}"
    );
    assert!(stdout.contains(&format!("http://localhost:{}", rig.port)));
    assert_eq!(
        rig.address().as_deref(),
        Some(format!("http://localhost:{}", rig.port).as_str())
    );

    let mode = |name: &str| {
        fs::metadata(rig.dir.join(name))
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(mode("marfa.env"), 0o600);
    let [salt, secret] = secrets(&rig);
    assert_eq!((salt.len(), secret.len()), (64, 64));
    assert_ne!(salt, secret);
    for text in [&stdout, &stderr] {
        assert!(
            !text.contains(&salt) && !text.contains(&secret),
            "a secret was printed"
        );
    }
    assert!(
        !rig.file(".env").contains(&salt),
        "the Compose file's settings hold a secret"
    );

    let compose = rig.file("compose.yaml");
    assert!(
        compose.contains("restart: unless-stopped")
            && compose.contains("127.0.0.1:${MARFA_PORT}:8600")
    );
    let dotenv = rig.file(".env");
    for line in [
        "MARFA_NAME=marfa",
        "MARFA_RELEASE=0.0.92",
        "MARFA_ACCESS=local",
    ] {
        assert!(dotenv.lines().any(|l| l == line), "{line}\n{dotenv}");
    }
    assert_eq!(rig.setting("MARFA_TRUSTED_PROXY_CIDRS"), None);
    assert_eq!(rig.setting("MARFA_TRUSTED_PROXY_HEADER"), None);
    let log = rig.log();
    assert!(log.contains("network create marfa-net"), "{log}");
    assert!(log.lines().any(|l| l.contains(" up -d")), "{log}");
}

const KEEP_WARNING: &str = "Keep a copy of";

/// A first run whose image cannot be pulled, which is after the secrets are
/// written. The failure is switched off for the next run.
fn failed_first_install(rig: &Rig) {
    fs::write(rig.state.join("pull-fails"), "").unwrap();
    let (code, _, stderr) = rig.install(&["--access", "local"]);
    assert_ne!(code, 0, "the pull should have failed");
    assert!(stderr.contains("no space left"), "{stderr}");
    assert!(
        rig.dir.join("marfa.env").exists(),
        "the secrets were not written before the failure"
    );
    fs::remove_file(rig.state.join("pull-fails")).unwrap();
}

#[test]
fn the_warning_to_keep_the_settings_file_survives_a_first_install_that_failed() {
    let rig = Rig::new("warn-after-failure");
    failed_first_install(&rig);
    let kept = secrets(&rig);

    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains(KEEP_WARNING), "{stdout}");
    assert!(
        stdout.contains(&rig.dir.join("marfa.env").display().to_string()),
        "{stdout}"
    );
    assert_eq!(secrets(&rig), kept, "the secrets were made again");

    let (code, stdout, stderr) = rig.install(&[]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!stdout.contains(KEEP_WARNING), "{stdout}");
}

#[test]
fn a_failure_after_a_failure_keeps_the_warning_until_one_install_succeeds() {
    let rig = Rig::new("warn-after-two-failures");
    failed_first_install(&rig);
    failed_first_install(&rig);
    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains(KEEP_WARNING), "{stdout}");
}

#[test]
fn a_first_install_that_succeeds_warns_once() {
    let rig = Rig::new("warn-once");
    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.matches(KEEP_WARNING).count(), 1, "{stdout}");
    for _ in 0..2 {
        let (code, stdout, stderr) = rig.install(&[]);
        assert_eq!(code, 0, "{stderr}");
        assert!(!stdout.contains(KEEP_WARNING), "{stdout}");
    }
}

#[test]
fn the_json_report_says_to_keep_the_settings_file_until_an_install_succeeds() {
    let rig = Rig::new("warn-json");
    failed_first_install(&rig);
    let report = |rig: &Rig| {
        let (code, stdout, stderr) = rig.install(&["--json"]);
        assert_eq!(code, 0, "{stderr}");
        let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        report["keep_settings_file"].clone()
    };
    assert_eq!(report(&rig), true);
    assert_eq!(report(&rig), false);
}

#[test]
fn a_settings_file_the_person_supplied_gets_no_warning_even_after_a_failure() {
    let rig = Rig::new("warn-supplied");
    managed_elsewhere(&rig, CLOUDFLARE_FILE);
    fs::write(rig.state.join("pull-fails"), "").unwrap();
    let (code, _, _) = rig.install(&["--access", "local"]);
    assert_ne!(code, 0);
    fs::remove_file(rig.state.join("pull-fails")).unwrap();
    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!stdout.contains(KEEP_WARNING), "{stdout}");
}

#[test]
fn a_leftover_marker_with_no_settings_file_warns_for_the_new_secrets_and_does_not_crash() {
    let rig = Rig::new("warn-stale");
    failed_first_install(&rig);
    fs::remove_file(rig.dir.join("marfa.env")).unwrap();
    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.matches(KEEP_WARNING).count(), 1, "{stdout}");
    let (code, stdout, _) = rig.install(&[]);
    assert_eq!(code, 0);
    assert!(!stdout.contains(KEEP_WARNING), "{stdout}");
}

#[test]
fn a_marker_that_cannot_be_kept_costs_neither_the_install_nor_a_false_warning() {
    let rig = Rig::new("warn-unwritable");
    // A folder where the marker belongs: it can be neither written nor read
    // as a marker.
    fs::create_dir_all(rig.dir.join(".secrets-unconfirmed")).unwrap();
    let (code, stdout, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout.matches(KEEP_WARNING).count(), 1, "{stdout}");
    let (code, stdout, stderr) = rig.install(&[]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!stdout.contains(KEEP_WARNING), "{stdout}");
}

#[test]
fn uninstalling_with_the_data_leaves_no_marker_behind() {
    let rig = Rig::new("warn-uninstall");
    failed_first_install(&rig);
    assert!(rig.dir.join(".secrets-unconfirmed").is_file(), "no witness");
    let (code, _, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!rig.dir.exists(), "{:?}", fs::read_dir(&rig.dir).ok());
}

#[test]
fn running_it_again_changes_nothing_and_keeps_the_secrets() {
    let rig = Rig::new("again");
    rig.installed(&["--access", "local"]);
    let before = (
        secrets(&rig),
        rig.file("marfa.env"),
        rig.file(".env"),
        rig.file("compose.yaml"),
    );
    let (code, stdout, stderr) = rig.install(&[]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("TICKET123"),
        "an unclaimed server gets a new link"
    );
    let after = (
        secrets(&rig),
        rig.file("marfa.env"),
        rig.file(".env"),
        rig.file("compose.yaml"),
    );
    assert_eq!(before, after);
    assert_eq!(rig.log().matches("network create").count(), 1);
    assert_eq!(
        rig.log().matches(" pull").count(),
        1,
        "the image was pulled again"
    );
}

#[test]
fn a_claimed_server_gets_no_setup_link() {
    let rig = Rig::new("claimed");
    rig.installed(&["--access", "local"]);
    fs::write(rig.state.join("claimed"), "").unwrap();
    let (code, stdout, _) = rig.install(&[]);
    assert_eq!(code, 0);
    assert!(
        !stdout.contains("handoff") && stdout.contains("owner already"),
        "{stdout}"
    );
}

#[test]
fn each_way_of_reaching_it_sets_the_proxy_trust_it_needs() {
    let mut rig = Rig::new("proxy");
    let (code, _, stderr) = rig.install(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com/",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_CIDRS").as_deref(),
        Some("172.30.0.1/32")
    );
    assert_eq!(rig.setting("MARFA_TRUSTED_PROXY_HEADER"), None);
    assert_eq!(rig.address().as_deref(), Some("https://marfa.example.com"));
    assert_eq!(rig.setting("MARFA_SIGN_IN_ADDRESS"), None);

    let salt = secrets(&rig);
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_CIDRS").as_deref(),
        Some("172.30.0.1/32")
    );
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_HEADER").as_deref(),
        Some("CF-Connecting-IP")
    );
    assert_eq!(
        secrets(&rig),
        salt,
        "changing how it is reached remade a secret"
    );

    let (code, _, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.setting("MARFA_TRUSTED_PROXY_HEADER"), None);
    let local = format!("http://localhost:{}", rig.port);
    assert_eq!(rig.address().as_deref(), Some(local.as_str()));
    let moved = free_port();
    rig.also_listen(moved);
    let moved_arg = moved.to_string();
    let (code, _, stderr) = rig.install_as(&["--port", &moved_arg]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.address(), Some(format!("http://localhost:{moved}")));
    // A run that changes nothing still puts it back, as after a failed update.
    fs::write(rig.state.join("address"), "https://moved.example.com\n").unwrap();
    let (code, _, stderr) = rig.install_as(&[]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.address(), Some(format!("http://localhost:{moved}")));
    let fresh = Rig::new("proxy-local");
    fresh.installed(&["--access", "local"]);
    assert_eq!(
        fresh.address(),
        Some(format!("http://localhost:{}", fresh.port))
    );
}

#[test]
fn the_summary_says_where_a_tunnel_points_and_which_machine_holds_the_folder() {
    let rig = Rig::new("target");
    let (code, stdout, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 0, "{stderr}");
    let target = format!("http://localhost:{}", rig.port);
    assert!(
        stdout.contains(&format!("Point at  {target}")),
        "the summary never says where the tunnel points: {stdout}"
    );
    let real = fs::canonicalize(&rig.root).unwrap().join("install");
    let folder = format!("  Folder    {} on ", real.display());
    assert!(
        stdout.contains(&folder),
        "the summary never names the machine: {stdout}"
    );
    assert!(
        stdout
            .trim_end()
            .ends_with("run `marfa docs connect-your-agent`."),
        "the summary does not end by pointing at the agent guide: {stdout}"
    );

    let (code, stdout, _) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0);
    assert!(
        !stdout.contains("Point at"),
        "a local server has no tunnel to point: {stdout}"
    );
}

#[test]
fn the_json_report_gains_the_host_and_the_local_address_and_keeps_its_shape() {
    let rig = Rig::new("target-json");
    let (code, stdout, stderr) = rig.install(&[
        "--json",
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 0, "{stderr}");
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(
        report["local_address"],
        format!("http://localhost:{}", rig.port)
    );
    assert_eq!(report["port"], rig.port);
    assert_eq!(report["address"], "https://marfa.example.com");
    assert!(report.get("host").is_some(), "{report}");
    assert!(
        !stdout.contains("connect-your-agent"),
        "the pointer is for people, not the report: {stdout}"
    );
}

#[test]
fn the_install_draws_color_on_a_terminal_and_the_same_words_everywhere_else() {
    let rig = Rig::new("colour");
    let ran = rig.install_on_terminal(&["--access", "local"], &[]);
    let stdout = terminal::Ran::text(&ran.stdout);
    let stderr = terminal::Ran::text(&ran.stderr);
    assert_eq!(ran.code, 0, "{stdout}\n{stderr}");
    assert!(
        stdout.contains("\u{1b}[1;32mMarfa 0.0.92 is running.\u{1b}[0m"),
        "{stdout:?}"
    );
    assert!(
        stdout.contains("\u{1b}[1mAddress\u{1b}[0m   http://localhost:"),
        "{stdout:?}"
    );
    assert!(
        stderr.contains("\u{1b}[1mChecking Docker...\u{1b}[0m"),
        "{stderr:?}"
    );
    // The words are the same without the escapes, and a later run has none.
    let plain = |text: &str| {
        let mut out = String::new();
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            if c == '\u{1b}' {
                for c in chars.by_ref() {
                    if c == 'm' {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    };
    assert!(plain(&stdout).contains("  Address   http://localhost:"));
    for (name, env, json) in [
        ("NO_COLOR", vec![("NO_COLOR", "1")], false),
        ("TERM=dumb", vec![("TERM", "dumb")], false),
        ("--json", vec![], true),
    ] {
        let rig = Rig::new(&format!("colour-{}", name.len()));
        let extra: Vec<&str> = if json {
            vec!["--access", "local", "--json"]
        } else {
            vec!["--access", "local"]
        };
        let ran = rig.install_on_terminal(&extra, &env);
        assert_eq!(ran.code, 0, "{name}");
        assert!(
            !ran.stdout.contains(&0x1b),
            "{name}: {:?}",
            terminal::Ran::text(&ran.stdout)
        );
        assert!(
            !ran.stderr.contains(&0x1b),
            "{name}: {:?}",
            terminal::Ran::text(&ran.stderr)
        );
    }
    let (_, piped, piped_err) = rig.install(&["--access", "local"]);
    assert!(!piped.contains('\u{1b}') && !piped_err.contains('\u{1b}'));
}

#[test]
fn an_address_the_server_would_refuse_is_refused_first() {
    let rig = Rig::new("address");
    for (args, said) in [
        (
            &[
                "--access",
                "cloudflare",
                "--address",
                "http://marfa.example.com",
            ][..],
            "https",
        ),
        (&["--access", "cloudflare"], "pass --address"),
        (
            &["--access", "local", "--address", "https://x.example.com"],
            "--address is for",
        ),
    ] {
        let (code, _, stderr) = rig.install(args);
        assert_eq!(code, 2, "{args:?}: {stderr}");
        assert!(stderr.contains(said), "{args:?}: {stderr}");
    }
    assert!(!rig.dir.exists(), "a refused install left files behind");
}

#[test]
fn tailscale_without_tailscale_says_what_to_install() {
    let rig = Rig::new("tailscale");
    let missing = rig.root.join("no-tailscale");
    let port = rig.port.to_string();
    let (code, _, stderr) = rig.marfa_with(
        &[
            "install",
            "--docker",
            "--release",
            "0.0.92",
            "--port",
            &port,
            "--yes",
            "--access",
            "tailscale",
        ],
        &[("MARFA_TAILSCALE", &missing)],
    );
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains("Tailscale"), "{stderr}");
    assert!(!rig.dir.join("marfa.env").exists());
}

#[test]
fn data_whose_secrets_are_gone_is_never_started_on_new_ones() {
    let rig = Rig::new("lost");
    rig.installed(&["--access", "local"]);
    fs::remove_file(rig.dir.join("marfa.env")).unwrap();
    let (code, _, stderr) = rig.install(&[]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("marfa.env is missing") || stderr.contains("marfa.env"),
        "{stderr}"
    );
    assert!(!rig.dir.join("marfa.env").exists());

    // The same with the folder gone altogether.
    fs::remove_dir_all(&rig.dir).unwrap();
    fs::remove_file(rig.state.join("c-marfa")).unwrap();
    let (code, _, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("already holds data"), "{stderr}");
}

#[test]
fn a_container_it_did_not_make_is_not_taken_over() {
    let rig = Rig::new("foreign");
    fs::write(rig.state.join("c-marfa"), "").unwrap();
    let (code, _, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("already exists"), "{stderr}");
}

#[test]
fn an_install_in_the_folder_is_not_renamed_and_foreign_files_are_not_overwritten() {
    let rig = Rig::new("folder");
    let (code, _, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = rig.install(&["--name", "other"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("already holds the install marfa"),
        "{stderr}"
    );

    let alien = Rig::new("alien");
    fs::create_dir_all(&alien.dir).unwrap();
    fs::write(alien.dir.join("compose.yaml"), "services: {}\n").unwrap();
    let (code, _, stderr) = alien.install(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(
        fs::read_to_string(alien.dir.join("compose.yaml")).unwrap(),
        "services: {}\n"
    );
}

#[test]
fn a_build_without_a_release_and_the_word_latest_are_refused() {
    let rig = Rig::new("release");
    let port = rig.port.to_string();
    for (extra, said) in [
        (&[][..], "not a release"),
        (&["--release", "latest"], "is not a release"),
    ] {
        let mut args = vec![
            "install", "--docker", "--access", "local", "--yes", "--port", &port,
        ];
        args.extend(extra);
        let (code, _, stderr) = rig.marfa(&args);
        assert_eq!(code, 2, "{stderr}");
        assert!(stderr.contains(said), "{stderr}");
    }
}

#[test]
fn a_port_in_use_is_refused() {
    let rig = Rig::new("port");
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let held_port = held.local_addr().unwrap().port().to_string();
    let (code, _, stderr) = rig.marfa(&[
        "install",
        "--docker",
        "--release",
        "0.0.92",
        "--access",
        "local",
        "--yes",
        "--port",
        &held_port,
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("cannot be used"), "{stderr}");
}

#[test]
fn no_docker_is_said_plainly() {
    let rig = Rig::new("nodocker");
    let output = output_of(
        quiet::marfa()
            .args([
                "server",
                "install",
                "--docker",
                "--release",
                "0.0.92",
                "--access",
                "local",
                "--yes",
            ])
            .arg("--dir")
            .arg(&rig.dir)
            .env("MARFA_DOCKER", rig.root.join("missing")),
    );
    assert_eq!(output.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Docker is not installed"));
    assert!(!rig.dir.exists());
}

#[test]
fn a_docker_upgrade_moves_newer_or_older_once_the_release_says_it_opens_the_database() {
    let rig = Rig::new("upgrade");
    rig.installed(&["--access", "local"]);
    let salt = secrets(&rig);
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.92 to 0.0.93"), "{stdout}");
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.93\n"));
    assert_eq!(secrets(&rig), salt);
    // The settings reach the image's server through the environment, never the command.
    let given = fs::read_to_string(rig.state.join("can-open-env")).unwrap();
    assert!(
        given.contains(&format!("MARFA_KEY_SALT={}\n", salt[0])),
        "{given}"
    );
    assert!(!rig.log().contains(&salt[0]), "{}", rig.log());
    let log = rig.log();
    let lines: Vec<&str> = log.lines().collect();
    let asked = lines.iter().position(|line| line.starts_with("run --rm "));
    let started = lines.iter().rposition(|line| line.contains(" up "));
    assert!(asked.is_some() && asked < started, "asked first: {log}");

    // Going back is the same move, asked the same way.
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.91", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.93 to 0.0.91"), "{stdout}");
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.91\n"));
    assert_eq!(
        fs::read_to_string(rig.state.join("asked-can-open")).unwrap(),
        "0.0.93\n0.0.91\n"
    );

    // A release that is already running is not asked again.
    let (code, stdout, _) = rig.marfa(&["upgrade", "--release", "0.0.91", "--wait-seconds", "5"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Already on 0.0.91"), "{stdout}");
    assert_eq!(
        fs::read_to_string(rig.state.join("asked-can-open")).unwrap(),
        "0.0.93\n0.0.91\n"
    );
}

#[test]
fn a_docker_upgrade_to_a_release_that_will_not_open_the_database_changes_nothing() {
    let rig = Rig::new("upgrade-cannot-open");
    rig.installed(&["--access", "local"]);
    fs::write(
        rig.state.join("cannot-open-0.0.91"),
        "The database was written by a build this one does not read.",
    )
    .unwrap();
    let dotenv = rig.file(".env");
    let ups = |rig: &Rig| rig.log().matches(" up ").count();
    let before = ups(&rig);

    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.91", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains(
            "0.0.91 will not run on this install's settings and database, so nothing was changed: the container and the database stay on 0.0.92"
        ) && stderr.contains("a build this one does not read")
            && stderr.contains("marfa export")
            && stderr.contains("--release 0.0.91"),
        "{stderr}"
    );
    assert_eq!(rig.file(".env"), dotenv);
    assert_eq!(ups(&rig), before, "{}", rig.log());
    assert!(answers(rig.port));

    // An image whose question could not run is started, and judges the database itself; the
    // witness that only a refusal stops the move.
    fs::write(rig.state.join("ask-fails-0.0.91"), "").unwrap();
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.91", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.92 to 0.0.91"), "{stdout}");
    assert_eq!(ups(&rig), before + 1, "{}", rig.log());
}

#[test]
fn a_docker_upgrade_to_a_release_that_refuses_the_database_puts_the_earlier_release_back() {
    let rig = Rig::new("upgrade-refused");
    rig.installed(&["--access", "local"]);
    // A release whose question could not run judges the database at start.
    fs::write(rig.state.join("ask-fails-0.0.93"), "").unwrap();
    fs::write(rig.state.join("refuses-0.0.93"), "").unwrap();

    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("0.0.93 did not update the database")
            && stderr.contains("so 0.0.92 was put back and runs")
            && stderr.contains("marfa export")
            && stderr.contains("marfa restore"),
        "{stderr}"
    );
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.92\n"));
    assert!(answers(rig.port));
    let ups = rig
        .log()
        .lines()
        .filter(|line| line.contains(" up "))
        .count();
    assert_eq!(
        ups,
        3,
        "install, the upgrade and the put-back: {}",
        rig.log()
    );

    // Witness: without the refusal, the same upgrade moves the install.
    fs::remove_file(rig.state.join("refuses-0.0.93")).unwrap();
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.92 to 0.0.93"), "{stdout}");
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.93\n"));
}

#[test]
fn a_docker_upgrade_to_an_image_too_old_to_be_asked_changes_nothing() {
    let rig = Rig::new("upgrade-too-old");
    rig.installed(&["--access", "local"]);
    let dotenv = rig.file(".env");
    let before = rig.log();

    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.75", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains(
            "0.0.75 cannot say whether it opens this install's database, because only releases from 0.0.76 answer that, so nothing was changed: the container and the database stay on 0.0.92"
        ) && stderr.contains("export the data with `marfa export` while 0.0.92 runs")
            && stderr.contains("make a new install with `--release 0.0.75`")
            && stderr.contains("marfa restore"),
        "{stderr}"
    );
    assert_eq!(rig.file(".env"), dotenv);
    let since = &rig.log()[before.len()..];
    assert!(
        !since.contains("pull") && !since.contains("run ") && !since.contains(" up "),
        "{since}"
    );
    assert!(!rig.state.join("asked-can-open").exists());
    assert!(answers(rig.port));

    // Witness: the first release that answers is asked, and moved to.
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.76", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.92 to 0.0.76"), "{stdout}");
    assert_eq!(
        fs::read_to_string(rig.state.join("asked-can-open")).unwrap(),
        "0.0.76\n"
    );
}

/// A line in the shape the server writes it, which the shared definition names.
fn log_line(level: &str, message: &str, fields: serde_json::Value) -> String {
    let mut line = serde_json::json!({
        "timestamp": "2026-01-01T00:00:00.000000Z",
        "level": level,
        "message": message,
    });
    for (name, value) in fields.as_object().unwrap() {
        line[name] = value.clone();
    }
    line.to_string() + "\n"
}

/// What a server of this release logs once it has upgraded a database.
fn upgraded_line(from: u64, to: u64, copy: Option<&str>) -> String {
    upgraded_line_by(env!("CARGO_PKG_VERSION"), from, to, copy)
}

fn upgraded_line_by(release: &str, from: u64, to: u64, copy: Option<&str>) -> String {
    use marfa_rules::server_log::upgraded;
    let mut fields = serde_json::json!({
        upgraded::SCHEMA_FROM: from,
        upgraded::SCHEMA_TO: to,
        upgraded::RELEASE: release,
    });
    if let Some(copy) = copy {
        fields[upgraded::COPY] = copy.into();
    }
    log_line("info", upgraded::MESSAGE, fields)
}

fn start_failed_line(error: &str) -> String {
    use marfa_rules::server_log::{ERROR, START_FAILED};
    log_line("error", START_FAILED, serde_json::json!({ ERROR: error }))
}

const COPY_PATH: &str = "/data/marfa.db.before-upgrade";

fn upgrade_json(rig: &Rig, release: &str) -> serde_json::Value {
    let output = output_of(
        quiet::marfa()
            .args([
                "--json",
                "server",
                "upgrade",
                "--release",
                release,
                "--wait-seconds",
                "5",
                "--dir",
            ])
            .arg(&rig.dir)
            .env("MARFA_DOCKER", rig.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home()),
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn an_upgrade_says_where_the_copy_of_the_database_is_and_that_the_next_one_replaces_it() {
    let rig = Rig::new("upgrade-copy");
    rig.installed(&["--access", "local"]);
    fs::write(
        rig.state.join("server-log"),
        upgraded_line(0, 1, None) + &upgraded_line(1, 2, Some(COPY_PATH)) + "not a log line\n",
    )
    .unwrap();

    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.92 to 0.0.93"), "{stdout}");
    assert!(stdout.contains("from schema version 1 to 2"), "{stdout}");
    assert!(stdout.contains(COPY_PATH), "{stdout}");
    assert!(
        stdout.contains("next update of the database replaces that copy"),
        "{stdout}"
    );
    assert!(!stdout.contains("until you remove"), "{stdout}");

    fs::write(
        rig.state.join("server-log"),
        upgraded_line(1, 2, Some(COPY_PATH)),
    )
    .unwrap();
    let report = upgrade_json(&rig, "0.0.94");
    assert_eq!(report["database_update"]["schema_from"], 1);
    assert_eq!(report["database_update"]["schema_to"], 2);
    assert_eq!(report["database_update"]["copy"], COPY_PATH);

    // Witness: a start that logged no update says nothing of one.
    fs::write(rig.state.join("server-log"), "a line of the server's log\n").unwrap();
    let report = upgrade_json(&rig, "0.0.95");
    assert_eq!(report["release"], "0.0.95");
    assert_eq!(report["database_update"], serde_json::Value::Null);
}

#[test]
fn an_upgrade_of_a_database_with_no_data_says_that_no_copy_was_made() {
    let rig = Rig::new("upgrade-no-copy");
    rig.installed(&["--access", "local"]);
    fs::write(rig.state.join("server-log"), upgraded_line(1, 2, None)).unwrap();

    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("from schema version 1 to 2"), "{stdout}");
    assert!(stdout.contains("no copy was made"), "{stdout}");
    assert!(!stdout.contains("before-upgrade"), "{stdout}");

    fs::write(rig.state.join("server-log"), upgraded_line(2, 3, None)).unwrap();
    let report = upgrade_json(&rig, "0.0.94");
    assert_eq!(report["database_update"]["schema_to"], 3);
    assert_eq!(report["database_update"]["copy"], serde_json::Value::Null);
}

#[test]
fn a_retried_upgrade_still_says_where_the_copy_of_the_database_is() {
    let rig = Rig::new("upgrade-retry");
    rig.installed(&["--access", "local"]);
    fs::write(rig.state.join("unhealthy"), "").unwrap();
    fs::write(
        rig.state.join("server-log"),
        upgraded_line(1, 2, Some(COPY_PATH)),
    )
    .unwrap();

    // The wait ends while the server is still copying; the env file is
    // already on the target.
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "1"]);
    assert_ne!(code, 0);
    assert!(stderr.contains("did not become healthy"), "{stderr}");
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.93"));

    // The update completed, and the operator runs the command again.
    fs::remove_file(rig.state.join("unhealthy")).unwrap();
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Already on 0.0.93"), "{stdout}");
    assert!(stdout.contains("from schema version 1 to 2"), "{stdout}");
    assert!(stdout.contains(COPY_PATH), "{stdout}");

    // Witness: a retry whose log records no update says nothing of a copy.
    fs::write(rig.state.join("server-log"), "a line of the server's log\n").unwrap();
    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Already on 0.0.93"), "{stdout}");
    assert!(!stdout.contains("copy"), "{stdout}");
}

#[test]
fn an_upgrade_the_server_refuses_says_how_to_go_back() {
    let rig = Rig::new("upgrade-refused");
    rig.installed(&["--access", "local"]);
    fs::write(rig.state.join("unhealthy"), "").unwrap();
    fs::write(
        rig.state.join("server-log"),
        start_failed_line("/data/marfa.db is at schema version 9, which a newer build wrote; this build reads schema version 2.")
            + "This server will not start on the database at /data/marfa.db, and the message above says why and what to do.\n",
    )
    .unwrap();

    let started = std::time::Instant::now();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "30"]);
    assert_ne!(code, 0);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "it waited out --wait"
    );
    assert!(stderr.contains("a newer build wrote"), "{stderr}");
    assert!(
        stderr.contains("0.0.93 did not update the database"),
        "{stderr}"
    );
    assert!(
        stderr.contains("`marfa server upgrade --release 0.0.92 --dir "),
        "{stderr}"
    );
}

#[test]
fn an_upgrade_whose_copy_the_server_could_not_make_says_why_and_how_to_go_back() {
    let rig = Rig::new("upgrade-copy-refused");
    rig.installed(&["--access", "local"]);
    fs::write(rig.state.join("unhealthy"), "").unwrap();
    let why = "/data/marfa.db was not upgraded from schema version 1, because the copy kept before an upgrade could not be written to /data/marfa.db.before-upgrade: it needs 900 bytes and must leave the disk reserve of 100 bytes, and 4096 bytes are free. Nothing was changed.";
    fs::write(
        rig.state.join("server-log"),
        refused_line(marfa_rules::server_log::UpgradeRefusal::CopyNotMade, why),
    )
    .unwrap();

    let started = std::time::Instant::now();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "30"]);
    assert_ne!(code, 0);
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "it waited out --wait"
    );
    assert!(
        stderr.contains(
            "0.0.93 did not update the database, because the copy kept first could not be made"
        ),
        "{stderr}"
    );
    assert!(stderr.contains("4096 bytes are free"), "{stderr}");
    assert!(stderr.contains("still reads it"), "{stderr}");
    assert!(
        stderr.contains("`marfa server upgrade --release 0.0.92 --dir "),
        "{stderr}"
    );

    // Witness: a start that failed for another reason is not taken for a refused copy.
    fs::write(
        rig.state.join("server-log"),
        start_failed_line("The port 8080 is already taken (EADDRINUSE)"),
    )
    .unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "1"]);
    assert_ne!(code, 0);
    assert!(!stderr.contains("the copy kept first"), "{stderr}");
    assert!(!stderr.contains("still reads it"), "{stderr}");
}

#[test]
fn status_reports_in_json() {
    let rig = Rig::new("status");
    rig.installed(&["--access", "local"]);
    let (code, stdout, stderr) = rig.marfa(&["status"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("running and healthy"), "{stdout}");
    let output = output_of(
        quiet::marfa()
            .args(["--json", "server", "status", "--dir"])
            .arg(&rig.dir)
            .env("MARFA_DOCKER", rig.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home()),
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["release"], "0.0.92");
    assert_eq!(report["healthy"], true);
    assert_eq!(report["claimed"], false);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&secrets(&rig)[0]));
}

fn status_json(rig: &Rig) -> serde_json::Value {
    let output = output_of(
        quiet::marfa()
            .args(["--json", "server", "status", "--dir"])
            .arg(&rig.dir)
            .env("MARFA_DOCKER", rig.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home()),
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn status_says_what_the_health_answer_says() {
    let rig = Rig::new("status-health");
    rig.installed(&["--access", "local"]);

    fs::write(
        rig.state.join("health-body"),
        "200 OK\n{\"status\":\"degraded\",\"components\":{\"database\":{\"status\":\"ok\"},\"disk\":{\"status\":\"degraded\"}},\"backups\":{\"status\":\"ok\"}}",
    )
    .unwrap();
    let (code, stdout, stderr) = rig.marfa(&["status"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("running, degraded: disk degraded"),
        "{stdout}"
    );
    assert!(!stdout.contains("running and healthy"), "{stdout}");
    let report = status_json(&rig);
    assert_eq!(report["running"], true);
    assert_eq!(report["answering"], true);
    assert_eq!(report["healthy"], false);
    assert_eq!(report["health"]["status"], "degraded");
    assert_eq!(report["health"]["problems"][0], "disk degraded");

    fs::write(
        rig.state.join("health-body"),
        "503 Service Unavailable\n{\"status\":\"down\",\"components\":{\"database_write\":{\"status\":\"down\"}},\"backups\":{\"status\":\"failing\"}}",
    )
    .unwrap();
    let (code, stdout, stderr) = rig.marfa(&["status"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("database write down") && stdout.contains("backups failing"),
        "{stdout}"
    );
    assert!(!stdout.contains("not answering"), "{stdout}");
    assert_eq!(status_json(&rig)["health"]["status"], "down");

    // An answer that is not the health report is still an answer, not silence.
    fs::remove_file(rig.state.join("health-body")).unwrap();
    fs::write(rig.state.join("unhealthy"), "").unwrap();
    let (code, stdout, _) = rig.marfa(&["status"]);
    assert_eq!(code, 0);
    assert!(!stdout.contains("running and healthy"), "{stdout}");
    assert!(!stdout.contains("not answering"), "{stdout}");
}

#[test]
fn uninstall_keeps_the_data_unless_told_to_delete_it() {
    let rig = Rig::new("uninstall");
    rig.installed(&["--access", "local"]);
    let (code, stdout, stderr) = rig.marfa(&["uninstall"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("data stays"), "{stdout}");
    assert!(rig.dir.join("marfa.env").exists());
    assert!(rig.state.join("vol-marfa-data").exists());
    assert!(!rig.state.join("c-marfa").exists());

    // Nothing can ask, so deleting needs the flag that says it is meant.
    let (code, _, stderr) = rig.marfa(&["uninstall", "--delete-data"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(rig.dir.join("marfa.env").exists());

    let (code, stdout, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("deleted"), "{stdout}");
    assert!(!rig.dir.exists());
    assert!(
        !rig.state.join("vol-marfa-data").exists() && !rig.state.join("net-marfa-net").exists()
    );
}

#[test]
fn the_server_is_set_to_start_at_login_unless_declined() {
    let rig = Rig::new("login");
    rig.installed(&["--access", "local"]);
    let plist = fs::read_to_string(rig.agent("marfa")).unwrap();
    assert!(plist.contains("<string>server</string>") && plist.contains("<string>start</string>"));
    assert!(plist.contains(rig.dir.to_str().unwrap()), "{plist}");
    assert!(rig.home().join("loaded-marfa").exists());
    assert!(rig.file(".env").contains("MARFA_AUTOSTART=on"));
    assert!(!plist.contains(&secrets(&rig)[0]) && !plist.contains(&secrets(&rig)[1]));
    // Loading the agent runs it, so it is loaded once the server is up.
    let docker = rig.log();
    let up = docker.find(" up -d").unwrap();
    assert!(up < docker.len());
    let launchctl = fs::read_to_string(rig.home().join("launchctl.log")).unwrap();
    assert_eq!(launchctl.matches("bootstrap").count(), 1, "{launchctl}");

    // Run again, the agent is left alone.
    rig.installed(&[]);
    let launchctl = fs::read_to_string(rig.home().join("launchctl.log")).unwrap();
    assert_eq!(launchctl.matches("bootstrap").count(), 1, "{launchctl}");

    let (code, stdout, _) = rig.marfa(&["status"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Login     on"), "{stdout}");

    // Declined, it is taken away.
    rig.installed(&["--no-autostart"]);
    assert!(!rig.agent("marfa").exists() && !rig.home().join("loaded-marfa").exists());
    assert!(rig.file(".env").contains("MARFA_AUTOSTART=off"));
    rig.installed(&[]);
    assert!(!rig.agent("marfa").exists(), "a later run put it back");

    // Uninstall takes it away too.
    rig.installed(&["--autostart"]);
    assert!(rig.agent("marfa").exists());
    assert_eq!(rig.marfa(&["uninstall"]).0, 0);
    assert!(!rig.agent("marfa").exists() && !rig.home().join("loaded-marfa").exists());
}

fn count_connections(stop: Arc<AtomicBool>) -> (u16, Arc<AtomicU16>, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let arrivals = Arc::new(AtomicU16::new(0));
    let counted = arrivals.clone();
    let thread = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok(_) => {
                    counted.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    });
    (port, arrivals, thread)
}

#[test]
fn the_servers_health_is_asked_directly_whatever_proxy_the_environment_names() {
    let rig = Rig::new("no-proxy");
    let stop = Arc::new(AtomicBool::new(false));
    let (proxy, arrivals, thread) = count_connections(stop.clone());
    let through = format!("http://127.0.0.1:{proxy}");
    let environment: Vec<(&str, &Path)> = [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ]
    .into_iter()
    .map(|name| (name, Path::new(&through)))
    .chain([("NO_PROXY", Path::new("")), ("no_proxy", Path::new(""))])
    .collect();
    let port = rig.port.to_string();
    let (code, stdout, stderr) = rig.marfa_with(
        &[
            "install",
            "--docker",
            "--release",
            "0.0.92",
            "--port",
            &port,
            "--yes",
            "--wait-seconds",
            "5",
            "--access",
            "local",
        ],
        &environment,
    );
    assert_eq!(code, 0, "{stdout}\n{stderr}");
    let (code, stdout, stderr) = rig.marfa_with(&["status"], &environment);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("running and healthy"), "{stdout}");
    stop.store(true, Ordering::Relaxed);
    thread.join().unwrap();
    assert_eq!(arrivals.load(Ordering::Relaxed), 0);
}

#[test]
fn start_brings_the_server_up_without_changing_anything() {
    let rig = Rig::new("start");
    rig.installed(&["--access", "local"]);
    let before = (rig.file("marfa.env"), rig.file(".env"));
    fs::remove_file(rig.state.join("c-marfa")).unwrap();
    let (code, stdout, stderr) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("is running"), "{stdout}");
    assert!(rig.state.join("c-marfa").exists());
    assert_eq!(before, (rig.file("marfa.env"), rig.file(".env")));
    let (code, _, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(code, 2, "{stderr}");
}

fn managed_elsewhere(rig: &Rig, body: &str) {
    fs::create_dir_all(&rig.dir).unwrap();
    fs::write(rig.dir.join("marfa.env"), body).unwrap();
}

const CLOUDFLARE_FILE: &str =
    "MARFA_KEY_SALT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MARFA_AUTH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
MARFA_TRUSTED_PROXY_HEADER=CF-Connecting-IP
MARFA_TRUSTED_PROXY_CIDRS=172.30.0.1/32
MARFA_MAX_CONNECTIONS=512
";

const NATIVE_CLOUDFLARE_FILE: &str =
    "MARFA_KEY_SALT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MARFA_AUTH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
MARFA_TRUSTED_PROXY_HEADER=CF-Connecting-IP
MARFA_TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128
MARFA_MAX_CONNECTIONS=512
";

#[test]
fn a_settings_file_managed_elsewhere_is_used_as_it_is() {
    let rig = Rig::new("external");
    managed_elsewhere(&rig, CLOUDFLARE_FILE);
    let (code, stdout, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.address().as_deref(), Some("https://marfa.example.com"));
    assert_eq!(
        rig.file("marfa.env"),
        CLOUDFLARE_FILE,
        "the file was changed"
    );
    assert_eq!(
        fs::metadata(rig.dir.join("marfa.env"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644,
        "the file's mode was changed"
    );
    assert!(rig.file(".env").contains("MARFA_SETTINGS=external"));
    assert!(
        stdout.contains("https://marfa.example.com") && stdout.contains("managed outside"),
        "{stdout}"
    );
    assert!(!stdout.contains("Keep a copy"), "{stdout}");
    for text in [&stdout, &stderr] {
        assert!(!text.contains("aaaaaaaaaaaaaaaa") && !text.contains("bbbbbbbbbbbbbbbb"));
    }

    // It stays external without the flag, and a new rendering is picked up.
    let rendered = CLOUDFLARE_FILE.replace("CONNECTIONS=512", "CONNECTIONS=256");
    fs::write(rig.dir.join("marfa.env"), &rendered).unwrap();
    rig.installed(&[]);
    assert_eq!(rig.file("marfa.env"), rendered);
    let (_, stdout, _) = rig.marfa(&["--json", "status"]);
    assert!(stdout.contains("\"settings\": \"external\""), "{stdout}");
}

const QUOTED_FILE: &str =
    "MARFA_KEY_SALT='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
MARFA_AUTH_SECRET='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
MARFA_TRUSTED_PROXY_HEADER='CF-Connecting-IP'
MARFA_TRUSTED_PROXY_CIDRS='172.30.0.0/24'
";

#[test]
fn a_settings_file_with_quoted_values_is_read_the_way_compose_reads_it() {
    let rig = Rig::new("external-quoted");
    managed_elsewhere(&rig, QUOTED_FILE);
    let (code, stdout, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://example.test",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.file("marfa.env"), QUOTED_FILE, "the file was changed");
    assert!(
        stdout.contains("https://example.test") && !stdout.contains("'https"),
        "{stdout}"
    );

    // The address is read back without its quotes for status and a second run.
    let (_, stdout, _) = rig.marfa(&["--json", "status"]);
    assert!(
        stdout.contains("\"address\": \"https://example.test\""),
        "{stdout}"
    );
    rig.installed(&[]);
    assert_eq!(rig.file("marfa.env"), QUOTED_FILE);
}

#[test]
fn a_quoted_proxy_header_that_is_not_cloudflares_is_refused() {
    let rig = Rig::new("external-quoted-header");
    managed_elsewhere(
        &rig,
        &QUOTED_FILE.replace("'CF-Connecting-IP'", "'X-Real-IP'"),
    );
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://other.test",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("MARFA_TRUSTED_PROXY_HEADER must be CF-Connecting-IP"),
        "{stderr}"
    );
    assert!(
        !rig.dir.join(".env").exists(),
        "a refused install wrote its settings"
    );
}

#[test]
fn a_settings_file_that_lacks_what_the_install_needs_is_refused_without_its_values() {
    let rig = Rig::new("external-short");
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("does not exist"), "{stderr}");

    managed_elsewhere(&rig, "MARFA_KEY_SALT=sssssssssssssssssssssssssssssssss\n");
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 2, "{stderr}");
    for said in [
        "MARFA_AUTH_SECRET is not set",
        "MARFA_TRUSTED_PROXY_HEADER must be CF-Connecting-IP",
        "MARFA_TRUSTED_PROXY_CIDRS must include 172.30.0.1/32, the gateway of the Docker network",
    ] {
        assert!(stderr.contains(said), "{said}\n{stderr}");
    }
    assert!(
        !stderr.contains("ssssssss"),
        "a secret was printed: {stderr}"
    );
    assert!(
        !rig.dir.join(".env").exists(),
        "a refused install wrote its settings"
    );
}

#[test]
fn a_proxy_range_in_a_settings_file_must_cover_the_docker_networks_gateway() {
    let rig = Rig::new("external-range");
    let base = CLOUDFLARE_FILE.replace(
        "MARFA_TRUSTED_PROXY_HEADER=CF-Connecting-IP\nMARFA_TRUSTED_PROXY_CIDRS=172.30.0.1/32\n",
        "",
    );
    let proxy = [
        "--access",
        "proxy",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ];
    for (ranges, code) in [
        ("10.0.0.0/8", 2),
        ("172.30.0.3/32", 2),
        ("172.30.0.1/32", 0),
        ("10.0.0.0/8,172.30.0.0/16", 0),
    ] {
        managed_elsewhere(&rig, &format!("{base}MARFA_TRUSTED_PROXY_CIDRS={ranges}\n"));
        let (said, _, stderr) = rig.install(&proxy);
        assert_eq!(said, code, "{ranges}: {stderr}");
        if code == 2 {
            assert!(stderr.contains("172.30.0.1/32"), "{stderr}");
        }
    }
}

#[test]
fn a_docker_install_trusts_each_gateway_of_its_network_and_no_other_address() {
    let rig = Rig::new("gateways");
    fs::write(
        rig.state.join("ipam"),
        r#"[{"Subnet":"172.30.0.0/24","Gateway":"172.30.0.1"},{"Subnet":"fd07::/64","Gateway":"fd07::1"}]"#,
    )
    .unwrap();
    rig.installed(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_CIDRS").as_deref(),
        Some("172.30.0.1/32,fd07::1/128")
    );
}

#[test]
fn a_docker_network_that_names_no_gateway_is_refused() {
    let rig = Rig::new("no-gateway");
    fs::write(rig.state.join("ipam"), r#"[{"Subnet":"172.30.0.0/24"}]"#).unwrap();
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_ne!(code, 0, "{stderr}");
    assert!(
        stderr.contains("the Docker network marfa-net names no gateway"),
        "{stderr}"
    );
    assert!(!rig.dir.join("marfa.env").exists(), "{stderr}");
}

#[test]
fn install_never_moves_a_docker_install_to_another_release_and_names_upgrade() {
    let rig = Rig::new("other-release");
    rig.installed(&["--access", "local"]);
    let dotenv = rig.file(".env");
    let log = rig.log().len();
    for release in ["0.0.93", "0.0.91"] {
        let (code, _, stderr) = rig.install_as(&["--release", release]);
        assert_eq!(code, 2, "{release}: {stderr}");
        assert!(
            stderr.contains(&format!(
                "this install runs 0.0.92 and --release names {release}: `marfa server upgrade --release {release} --dir "
            )),
            "{stderr}"
        );
        assert_eq!(rig.file(".env"), dotenv);
        assert!(!rig.log()[log..].contains(" up "), "{}", &rig.log()[log..]);
    }

    // Witness: the release it runs is installed again.
    let (code, _, stderr) = rig.install_as(&["--release", "0.0.92"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(rig.log()[log..].contains(" up "), "{}", &rig.log()[log..]);
}

#[test]
fn a_release_that_does_not_exist_is_found_before_anything_is_written() {
    let rig = Rig::new("norelease");
    let port = rig.port.to_string();
    let (code, _, stderr) =
        rig.install_as(&["--access", "local", "--release", "9.9.9", "--port", &port]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("no release 9.9.9"), "{stderr}");
    assert!(!rig.dir.exists() && !rig.log().contains("network create"));
}

#[test]
fn an_upgrade_to_a_release_that_does_not_exist_writes_nothing() {
    let rig = Rig::new("upgradenone");
    rig.installed(&["--access", "local"]);
    let before = rig.file(".env");
    fs::remove_file(rig.state.join("image")).unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "9.9.9", "--wait-seconds", "5"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("no release 9.9.9"), "{stderr}");
    assert_eq!(rig.file(".env"), before);
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn a_registry_that_cannot_answer_does_not_make_a_release_missing() {
    let rig = Rig::new("credentials");
    let port = rig.port.to_string();
    let (code, _, stderr) =
        rig.install_as(&["--access", "local", "--release", "8.8.8", "--port", &port]);
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn a_settings_file_missing_a_secret_is_not_completed_over_data() {
    let rig = Rig::new("partial");
    rig.installed(&["--access", "local"]);
    let whole = rig.file("marfa.env");
    for broken in [
        whole
            .lines()
            .filter(|line| !line.starts_with("MARFA_AUTH_SECRET="))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
        whole
            .lines()
            .map(|line| {
                if line.starts_with("MARFA_KEY_SALT=") {
                    "MARFA_KEY_SALT="
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    ] {
        fs::write(rig.dir.join("marfa.env"), &broken).unwrap();
        let (code, _, stderr) = rig.install(&[]);
        assert_eq!(code, 2, "{stderr}");
        assert!(stderr.contains("missing or empty"), "{stderr}");
        assert_eq!(rig.file("marfa.env"), broken, "the file was completed");
    }
}

#[test]
fn a_relative_folder_works_because_compose_reads_it_from_inside() {
    let rig = Rig::new("relative");
    let port = rig.port.to_string();
    let output = output_of(
        quiet::marfa()
            .current_dir(&rig.root)
            .args([
                "server",
                "install",
                "--docker",
                "--dir",
                "install",
                "--release",
                "0.0.92",
                "--access",
                "local",
                "--yes",
                "--wait-seconds",
                "5",
                "--port",
                &port,
            ])
            .env("MARFA_DOCKER", rig.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home()),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = rig.log();
    let project = log
        .lines()
        .find(|line| line.contains("--project-directory"))
        .unwrap();
    assert!(project.contains(rig.dir.to_str().unwrap()), "{project}");
}

#[test]
fn an_edited_compose_file_is_kept_beside_the_new_one() {
    let rig = Rig::new("compose-edit");
    rig.installed(&["--access", "local"]);
    let edited = format!(
        "{}\n# mine: a sidecar goes here\n",
        rig.file("compose.yaml")
    );
    fs::write(rig.dir.join("compose.yaml"), &edited).unwrap();
    let (code, _, stderr) = rig.install(&[]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stderr.contains("compose.yaml.bak"), "{stderr}");
    assert_eq!(
        fs::read_to_string(rig.dir.join("compose.yaml.bak")).unwrap(),
        edited
    );
    assert!(!rig.file("compose.yaml").contains("a sidecar goes here"));
    assert!(
        !rig.log().contains("--remove-orphans"),
        "a sidecar would be removed"
    );
    // A second edit does not replace the first copy.
    fs::write(rig.dir.join("compose.yaml"), format!("{edited}# again\n")).unwrap();
    rig.installed(&[]);
    assert!(rig.dir.join("compose.yaml.bak.1").exists());
    assert_eq!(
        fs::read_to_string(rig.dir.join("compose.yaml.bak")).unwrap(),
        edited
    );
}

#[test]
fn a_login_agent_that_fails_does_not_cost_the_setup_link() {
    let rig = Rig::new("agent-fails");
    fs::write(
        rig.home().join("bin/launchctl"),
        "#!/bin/sh\ncase \"$1\" in print) exit 1;; bootstrap) echo 'Domain does not support specified action' >&2; exit 5;; esac\n",
    )
    .unwrap();
    let (code, stdout, stderr) = rig.install(&["--access", "local", "--autostart"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("TICKET123"), "{stdout}");
    assert!(
        stdout.contains("not set to start at login") && stdout.contains("--no-autostart"),
        "{stdout}"
    );
    assert!(rig.file(".env").contains("MARFA_AUTOSTART=off"));
    // The next run does not fail the same way, and does not try again unasked.
    let (code, _, stderr) = rig.install(&[]);
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn deleting_the_data_leaves_a_settings_file_that_is_managed_elsewhere() {
    let rig = Rig::new("external-delete");
    managed_elsewhere(&rig, CLOUDFLARE_FILE);
    rig.installed(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ]);
    let (code, stdout, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("managed elsewhere"), "{stdout}");
    assert_eq!(rig.file("marfa.env"), CLOUDFLARE_FILE);
    assert!(!rig.dir.join(".env").exists() && !rig.dir.join("compose.yaml").exists());
}

#[test]
fn uninstall_stops_the_container_even_when_the_compose_file_is_gone() {
    let rig = Rig::new("no-compose");
    rig.installed(&["--access", "local"]);
    fs::remove_file(rig.dir.join("compose.yaml")).unwrap();
    // Without a Compose file, `down` has nothing to take down.
    fs::write(rig.state.join("down-needs-compose"), "").unwrap();
    let (code, stdout, stderr) = rig.marfa(&["uninstall"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Stopped"), "{stdout}");
    assert!(
        !rig.state.join("c-marfa").exists(),
        "the container is still there"
    );
}

#[test]
fn a_network_that_cannot_be_removed_does_not_fail_a_deletion_that_has_happened() {
    let rig = Rig::new("net-busy");
    rig.installed(&["--access", "local"]);
    fs::write(rig.state.join("netbusy-marfa-net"), "").unwrap();
    let (code, stdout, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stderr.contains("network marfa-net stays"), "{stderr}");
    assert!(stdout.contains("deleted"), "{stdout}");
    assert!(!rig.state.join("vol-marfa-data").exists());
}

#[test]
fn a_busy_port_on_every_address_is_found_before_anything_is_written() {
    let rig = Rig::new("wildcard");
    let held = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = held.local_addr().unwrap().port().to_string();
    let (code, _, stderr) = rig.marfa(&[
        "install",
        "--docker",
        "--release",
        "0.0.92",
        "--access",
        "local",
        "--yes",
        "--port",
        &port,
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("cannot be used"), "{stderr}");
    assert!(!rig.dir.exists());
}

#[test]
fn the_tailnet_address_follows_the_install() {
    let mut rig = Rig::new("tailnet");
    let map_file = rig.state.join("serve.map");
    let map = || fs::read_to_string(&map_file).unwrap_or_default();
    rig.installed(&["--access", "tailscale"]);
    assert_eq!(map(), format!("443 http://127.0.0.1:{}\n", rig.port));
    assert_eq!(
        rig.address().as_deref(),
        Some("https://host.example.ts.net")
    );
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_CIDRS").as_deref(),
        Some("172.30.0.1/32")
    );

    // Its own mapping is replaced, not mistaken for a stranger's, when the port changes.
    let moved_port = free_port();
    rig.also_listen(moved_port);
    let moved = moved_port.to_string();
    let (code, _, stderr) = rig.install_as(&["--port", &moved]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(map(), format!("443 http://127.0.0.1:{moved}\n"));

    // A new Tailscale port takes the old one off the tailnet.
    let (code, _, stderr) = rig.install_as(&["--https-port", "8445"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(map(), format!("8445 http://127.0.0.1:{moved}\n"));

    // Moving away from Tailscale takes the address off the tailnet.
    let (code, _, stderr) = rig.install_as(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(map(), "");
}

#[test]
fn a_port_that_tailscale_serves_to_something_else_is_never_replaced() {
    let rig = Rig::new("tailnet-foreign");
    fs::write(rig.state.join("serve.map"), "443 http://127.0.0.1:8210\n").unwrap();
    let (code, _, stderr) = rig.install(&["--access", "tailscale"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("already serves http://127.0.0.1:8210"),
        "{stderr}"
    );
    assert_eq!(
        fs::read_to_string(rig.state.join("serve.map")).unwrap(),
        "443 http://127.0.0.1:8210\n"
    );
    assert!(!rig.dir.exists() && !rig.log().contains("network create"));
}

#[test]
fn a_login_agent_that_failed_to_load_is_not_left_to_load_at_the_next_login() {
    let rig = Rig::new("agent-left");
    fs::write(
        rig.home().join("bin/launchctl"),
        "#!/bin/sh\ncase \"$1\" in print) exit 1;; bootstrap) exit 5;; esac\n",
    )
    .unwrap();
    let (code, _, stderr) = rig.install(&["--access", "local", "--autostart"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        !rig.agent("marfa").exists(),
        "the agent's file stays for the next login"
    );
}

#[test]
fn an_empty_secret_is_made_where_there_is_no_data() {
    let rig = Rig::new("empty-secret");
    managed_elsewhere(&rig, "MARFA_KEY_SALT=\nMARFA_AUTH_SECRET=\n");
    rig.installed(&["--access", "local"]);
    let [salt, secret] = secrets(&rig);
    assert_eq!((salt.len(), secret.len()), (64, 64));
}

#[test]
fn a_tailnet_that_cannot_be_reached_does_not_cost_the_setup_link() {
    let rig = Rig::new("tailnet-down");
    rig.installed(&["--access", "tailscale"]);
    // Tailscale stops answering, so the old address cannot be taken off.
    let broken = rig.root.join("tailscale-down");
    fs::write(&broken, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&broken, fs::Permissions::from_mode(0o755)).unwrap();
    let (code, stdout, stderr) = rig.marfa_with(
        &[
            "install",
            "--docker",
            "--yes",
            "--wait-seconds",
            "5",
            "--access",
            "local",
        ],
        &[("MARFA_TAILSCALE", &broken)],
    );
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("TICKET123"), "{stdout}");
    assert!(
        stderr.contains("The old address stays on your tailnet"),
        "{stderr}"
    );
}

#[test]
fn an_uninstall_says_when_the_tailnet_address_stays() {
    let rig = Rig::new("uninstall-tailnet-down");
    rig.installed(&["--access", "tailscale"]);
    let broken = rig.root.join("tailscale-down");
    fs::write(&broken, "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(&broken, fs::Permissions::from_mode(0o755)).unwrap();
    let (code, _, stderr) = rig.marfa_with(&["uninstall"], &[("MARFA_TAILSCALE", &broken)]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stderr.contains("The address stays on your tailnet")
            && stderr.contains("tailscale serve --https=443 off"),
        "{stderr}"
    );
}

// ---- a server run without Docker ----------------------------------------

const MANAGER: &str = if cfg!(target_os = "macos") {
    "launchd"
} else {
    "systemd-user"
};

impl Rig {
    /// A native `install` with the options given, apart from not asking.
    fn native(&self, extra: &[&str]) -> (i32, String, String) {
        let port = self.port.to_string();
        let mut args = vec!["install", "--yes", "--wait-seconds", "5", "--port", &port];
        args.extend(extra);
        self.marfa(&args)
    }

    fn native_installed(&self, extra: &[&str]) {
        let (code, stdout, stderr) = self.native(extra);
        assert_eq!(code, 0, "{stdout}\n{stderr}");
    }

    /// The file the service manager reads the service from.
    fn service_file(&self, name: &str) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.agent(name)
        } else {
            self.home()
                .join(format!(".config/systemd/user/marfa-{name}.service"))
        }
    }

    fn manager_log(&self) -> String {
        let name = if cfg!(target_os = "macos") {
            "launchctl.log"
        } else {
            "systemctl.log"
        };
        fs::read_to_string(self.home().join(name)).unwrap_or_default()
    }

    fn restarts(&self) -> usize {
        let word = if cfg!(target_os = "macos") {
            "kickstart -k"
        } else {
            " restart "
        };
        self.manager_log()
            .lines()
            .filter(|line| line.contains(word))
            .count()
    }

    /// The number the stand-in manager gave the service's current process.
    fn service_pid(&self, name: &str) -> Option<String> {
        let key = if cfg!(target_os = "macos") {
            name.to_string()
        } else {
            format!("marfa-{name}.service")
        };
        fs::read_to_string(self.home().join(format!("pid-{key}"))).ok()
    }

    fn control_log(&self) -> String {
        fs::read_to_string(self.state.join("control.log")).unwrap_or_default()
    }

    /// The folder as the command sees it, with links followed.
    fn real_dir(&self) -> PathBuf {
        fs::canonicalize(&self.root).unwrap().join("install")
    }
}

#[test]
fn a_native_install_runs_the_server_as_a_service_and_prints_the_link_and_no_secret() {
    let rig = Rig::new("n-first");
    let (code, stdout, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 0, "{stdout}\n{stderr}");
    assert!(stdout.contains("TICKET123"), "{stdout}");
    assert!(stdout.contains("Marfa 0.0.0 is running"), "{stdout}");
    let dotenv = rig.file(".env");
    for line in [
        "MARFA_RUNTIME=native".to_string(),
        format!("MARFA_SERVICE={MANAGER}"),
        format!("MARFA_PORT={}", rig.port),
        "MARFA_AUTOSTART=on".to_string(),
    ] {
        assert!(dotenv.contains(&line), "{line}\n{dotenv}");
    }
    assert!(!rig.dir.join("compose.yaml").exists());
    assert!(
        !rig.log().contains("compose"),
        "a native install ran Docker: {}",
        rig.log()
    );
    let [salt, secret] = secrets(&rig);
    assert_eq!((salt.len(), secret.len()), (64, 64));
    for text in [&stdout, &stderr] {
        assert!(!text.contains(&salt) && !text.contains(&secret));
    }
    assert_eq!(rig.setting("MARFA_SIGN_IN_ADDRESS"), None);
    assert_eq!(rig.setting("MARFA_TRUSTED_PROXY_CIDRS"), None);

    let service = fs::read_to_string(rig.service_file("marfa")).unwrap();
    assert!(
        service.contains("server") && service.contains("run") && service.contains("--dir"),
        "{service}"
    );
    assert!(
        service.contains(&rig.real_dir().display().to_string()),
        "{service}"
    );
    assert!(!service.contains(&salt) && !service.contains(&secret));

    let (_, status, _) = rig.marfa(&["--json", "status"]);
    assert!(status.contains("\"runtime\": \"native\""), "{status}");
    assert!(status.contains("\"healthy\": true"), "{status}");
}

#[test]
fn running_a_native_install_again_changes_nothing() {
    let rig = Rig::new("n-again");
    rig.native_installed(&["--access", "local"]);
    let before = (
        rig.file(".env"),
        rig.file("marfa.env"),
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
    );
    let calls = rig.manager_log().lines().count();
    let (code, stdout, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("TICKET123"), "{stdout}");
    let after = (
        rig.file(".env"),
        rig.file("marfa.env"),
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
    );
    assert_eq!(before, after);
    assert!(
        !rig.manager_log()
            .lines()
            .skip(calls)
            .any(|line| line.contains("bootstrap")
                || line.contains("kickstart")
                || line.contains("restart")),
        "the second run reloaded the service: {}",
        rig.manager_log()
    );
}

/// Whether anything answers on the port.
fn answers(port: u16) -> bool {
    let _held = SOCKETS.lock().unwrap();
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(200),
    )
    .is_ok()
}

#[test]
fn running_a_native_install_again_with_another_port_moves_the_running_server_to_it() {
    let mut rig = Rig::new("n-port-move");
    rig.native_installed(&["--access", "local"]);
    assert!(answers(rig.port));
    let (restarts, pid) = (rig.restarts(), rig.service_pid("marfa"));
    assert!(pid.is_some(), "the stand-in gave the service no process");

    let moved = free_port();
    rig.also_listen(moved);
    let (code, stdout, stderr) = rig.marfa(&[
        "install",
        "--yes",
        "--wait-seconds",
        "5",
        "--access",
        "local",
        "--port",
        &moved.to_string(),
    ]);
    assert_eq!(code, 0, "{stdout}\n{stderr}");
    assert!(
        rig.file(".env").contains(&format!("MARFA_PORT={moved}")),
        "{}",
        rig.file(".env")
    );
    assert_eq!(rig.restarts(), restarts + 1, "{}", rig.manager_log());
    assert_ne!(rig.service_pid("marfa"), pid);
    assert!(answers(moved), "nothing answers on the new port");
    assert!(!answers(rig.port), "the old process still holds its port");
}

#[test]
fn changing_how_a_native_server_is_reached_restarts_it_and_an_unchanged_run_does_not() {
    let rig = Rig::new("n-access-restart");
    let proxy = [
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ];
    rig.native_installed(&proxy);
    assert!(rig.setting("MARFA_TRUSTED_PROXY_CIDRS").is_some());
    let (restarts, pid) = (rig.restarts(), rig.service_pid("marfa"));

    rig.native_installed(&proxy);
    assert_eq!(rig.restarts(), restarts, "an unchanged run restarted it");
    assert_eq!(rig.service_pid("marfa"), pid);

    rig.native_installed(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_HEADER").as_deref(),
        Some("CF-Connecting-IP")
    );
    assert_eq!(rig.restarts(), restarts + 1, "{}", rig.manager_log());
    assert_ne!(rig.service_pid("marfa"), pid);
}

#[test]
fn a_native_run_that_finds_the_service_not_answering_on_its_port_restarts_it() {
    let rig = Rig::new("n-unanswered");
    rig.native_installed(&["--access", "local"]);
    let restarts = rig.restarts();
    // The state an earlier run left when it wrote a setting and then failed.
    fs::remove_file(rig.state.join(format!("go-{}", rig.port))).unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while answers(rig.port) && std::time::Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    rig.native_installed(&["--access", "local"]);
    assert_eq!(rig.restarts(), restarts + 1, "{}", rig.manager_log());
    assert!(answers(rig.port));
}

#[test]
fn settings_managed_elsewhere_are_applied_by_running_install_again() {
    let rig = Rig::new("n-external-restart");
    managed_elsewhere(&rig, NATIVE_CLOUDFLARE_FILE);
    let external = [
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ];
    rig.native_installed(&external);
    let (restarts, pid) = (rig.restarts(), rig.service_pid("marfa"));
    fs::write(
        rig.dir.join("marfa.env"),
        NATIVE_CLOUDFLARE_FILE.replace("CONNECTIONS=512", "CONNECTIONS=256"),
    )
    .unwrap();
    rig.native_installed(&external);
    assert_eq!(rig.restarts(), restarts + 1, "{}", rig.manager_log());
    assert_ne!(rig.service_pid("marfa"), pid);
}

#[test]
fn settings_managed_elsewhere_that_have_not_changed_leave_the_running_server_alone() {
    let rig = Rig::new("n-external-same");
    managed_elsewhere(&rig, NATIVE_CLOUDFLARE_FILE);
    let external = [
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ];
    rig.native_installed(&external);
    let (restarts, pid) = (rig.restarts(), rig.service_pid("marfa"));
    assert!(pid.is_some());
    rig.native_installed(&external);
    assert_eq!(rig.restarts(), restarts, "{}", rig.manager_log());
    assert_eq!(rig.service_pid("marfa"), pid);
}

#[test]
fn what_the_running_server_was_started_with_is_kept_as_a_hash_and_survives_a_stop_and_start() {
    let rig = Rig::new("n-applied");
    managed_elsewhere(&rig, NATIVE_CLOUDFLARE_FILE);
    let external = [
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://marfa.example.com",
    ];
    rig.native_installed(&external);
    let dotenv = rig.file(".env");
    let applied = dotenv
        .lines()
        .find_map(|line| line.strip_prefix("MARFA_APPLIED="))
        .expect("no MARFA_APPLIED after a confirmed start");
    assert_eq!(applied.len(), 64, "{dotenv}");
    assert!(
        !dotenv.contains("aaaaaaaa") && !dotenv.contains("CF-Connecting-IP"),
        "the settings are in .env: {dotenv}"
    );

    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.file(".env"), dotenv);
    let (restarts, pid) = (rig.restarts(), rig.service_pid("marfa"));
    rig.native_installed(&external);
    assert_eq!(rig.restarts(), restarts, "{}", rig.manager_log());
    assert_eq!(rig.service_pid("marfa"), pid);
}

#[test]
fn a_restart_that_failed_is_tried_again_by_running_install_again() {
    let rig = Rig::new("n-failed-restart");
    rig.native_installed(&["--access", "local"]);
    let pid = rig.service_pid("marfa");
    let proxy = [
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ];
    assert!(rig.file(".env").contains("MARFA_APPLIED="));
    fs::write(rig.home().join("restart-fails"), "").unwrap();
    let (code, _, stderr) = rig.native(&proxy);
    assert_ne!(code, 0, "{stderr}");
    assert_eq!(rig.service_pid("marfa"), pid, "the failed restart ran");
    // A failed restart leaves no record of what the server runs.
    assert!(
        !rig.file(".env").contains("MARFA_APPLIED="),
        "{}",
        rig.file(".env")
    );

    fs::remove_file(rig.home().join("restart-fails")).unwrap();
    let restarts = rig.restarts();
    rig.native_installed(&proxy);
    assert_eq!(rig.restarts(), restarts + 1, "{}", rig.manager_log());
    assert_ne!(rig.service_pid("marfa"), pid);

    rig.native_installed(&proxy);
    assert_eq!(rig.restarts(), restarts + 1, "an applied run restarted it");
}

#[test]
fn a_stopped_server_whose_settings_changed_is_started_once_not_restarted() {
    let rig = Rig::new("n-stopped-changed");
    rig.native_installed(&["--access", "local"]);
    // `marfa server stop` unloads a launchd agent, which then loads as a
    // changed definition; a loaded agent whose process exited does not.
    if cfg!(target_os = "macos") {
        fs::write(rig.home().join("stopped-marfa"), "").unwrap();
    } else {
        let (code, _, stderr) = rig.marfa(&["stop"]);
        assert_eq!(code, 0, "{stderr}");
    }
    let restarts = rig.restarts();
    rig.native_installed(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(rig.restarts(), restarts, "{}", rig.manager_log());
    assert!(answers(rig.port));
}

#[test]
fn a_process_id_that_cannot_be_read_does_not_cancel_the_restart_and_is_said() {
    let rig = Rig::new("n-no-pid");
    rig.native_installed(&["--access", "local"]);
    let (restarts, pid) = (rig.restarts(), rig.service_pid("marfa"));
    fs::write(rig.home().join("pid-query-fails"), "").unwrap();
    let proxy = [
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ];
    let (code, stdout, stderr) = rig.native(&proxy);
    assert_eq!(code, 0, "{stdout}\n{stderr}");
    assert_eq!(rig.restarts(), restarts + 1, "{}", rig.manager_log());
    assert_ne!(rig.service_pid("marfa"), pid);
    assert!(stderr.contains("process ID"), "{stderr}");
    assert!(stderr.contains("answers on port"), "{stderr}");
    assert!(stderr.contains("restarts it again"), "{stderr}");
    assert!(!rig.file(".env").contains("MARFA_APPLIED="));

    rig.native_installed(&proxy);
    assert_eq!(
        rig.restarts(),
        restarts + 2,
        "an unconfirmed restart was taken as applied"
    );

    fs::remove_file(rig.home().join("pid-query-fails")).unwrap();
    rig.native_installed(&proxy);
    assert_eq!(rig.restarts(), restarts + 3, "{}", rig.manager_log());
    assert!(rig.file(".env").contains("MARFA_APPLIED="));
    rig.native_installed(&proxy);
    assert_eq!(
        rig.restarts(),
        restarts + 3,
        "a confirmed restart was not kept"
    );
}

#[test]
fn a_restart_that_leaves_the_same_process_running_is_reported() {
    let rig = Rig::new("n-restart-ignored");
    rig.native_installed(&["--access", "local"]);
    fs::write(rig.home().join("restart-ignored"), "").unwrap();
    let (code, _, stderr) = rig.native(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains("did not restart"), "{stderr}");
}

#[test]
fn a_native_server_trusts_the_loopback_proxy_and_the_address_is_set_on_its_socket() {
    let rig = Rig::new("n-proxy");
    rig.native_installed(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com/",
    ]);
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_CIDRS").as_deref(),
        Some("127.0.0.0/8,::1/128")
    );
    assert_eq!(rig.setting("MARFA_TRUSTED_PROXY_HEADER"), None);
    assert_eq!(rig.address().as_deref(), Some("https://marfa.example.com"));
    let socket = format!("{}/data/control/marfa.sock", rig.real_dir().display());
    assert!(rig.control_log().contains(&socket) || rig.control_log().contains("config update"));

    rig.native_installed(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_CIDRS").as_deref(),
        Some("127.0.0.0/8,::1/128")
    );
    assert_eq!(
        rig.setting("MARFA_TRUSTED_PROXY_HEADER").as_deref(),
        Some("CF-Connecting-IP")
    );
    // The address was held already, so it is not written again.
    let writes = rig
        .control_log()
        .lines()
        .filter(|line| line.contains("config update"))
        .count();
    assert_eq!(writes, 1, "{}", rig.control_log());
}

#[test]
fn a_refused_address_is_traced_to_the_install_the_service_runs_wherever_it_is_installed() {
    let rig = Rig::new("n-hint");
    rig.native_installed(&["--access", "local"]);
    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    let elsewhere = rig.root.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    let url = format!("http://127.0.0.1:{}", rig.port);
    let ask = |autostart: &Path| {
        let output = output_of(
            quiet::marfa()
                .env("HOME", &elsewhere)
                .env("MARFA_AUTOSTART_ROOT", autostart)
                .env("MARFA_NO_KEYCHAIN", "1")
                .env("MARFA_API_URL", &url)
                .env("MARFA_API_KEY", "marfa_k1_fixture")
                .args(["items", "list"]),
        );
        String::from_utf8_lossy(&output.stderr).into_owned()
    };
    let dir = rig.real_dir();
    let said = ask(&rig.home());
    assert!(
        said.contains(&format!("marfa server status --dir {}", dir.display()))
            && said.contains(&format!("marfa server start --dir {}", dir.display())),
        "{said}"
    );
    // The witness: with no service registered, nothing names the folder.
    let said = ask(&elsewhere);
    assert!(
        !said.contains(&dir.display().to_string())
            && said.contains("no install in the default folder"),
        "{said}"
    );
}

#[test]
fn an_install_keeps_its_runtime_and_a_release_is_for_docker() {
    let rig = Rig::new("n-runtime");
    rig.native_installed(&["--access", "local"]);
    let (code, _, stderr) = rig.native(&["--docker"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("keeps its runtime") && stderr.contains("marfa export"),
        "{stderr}"
    );
    assert!(rig.file(".env").contains("MARFA_RUNTIME=native"));

    let other = Rig::new("n-release");
    let (code, _, stderr) = other.native(&["--release", "0.0.92"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("--release is for --docker"), "{stderr}");
    assert!(!other.dir.exists());

    let docker = Rig::new("n-docker-first");
    docker.installed(&["--access", "local"]);
    let (code, _, stderr) = docker.native(&[]);
    assert_eq!(
        code, 0,
        "an install made with Docker stays on Docker: {stderr}"
    );
    assert!(docker.file(".env").contains("MARFA_RUNTIME=docker"));
}

#[test]
fn a_server_that_is_missing_or_of_another_release_is_refused_before_anything_is_written() {
    let rig = Rig::new("n-server");
    rig.isolate();
    fs::remove_file(rig.root.join("bin/marfa-server")).unwrap();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains("marfa-server was not found"), "{stderr}");
    assert!(!rig.dir.exists());

    let rig = Rig::new("n-version");
    rig.isolate();
    let (code, _, stderr) = rig.marfa_with(
        &[
            "install",
            "--yes",
            "--access",
            "local",
            "--port",
            &rig.port.to_string(),
        ],
        &[("FAKE_SERVER_VERSION", Path::new("9.9.9"))],
    );
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("9.9.9")
            && stderr.contains("0.0.0")
            && stderr.contains("released together"),
        "{stderr}"
    );
    assert!(!rig.dir.exists());
}

#[test]
fn a_port_in_use_is_refused_for_a_native_server_too() {
    let rig = Rig::new("n-port");
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let busy = held.local_addr().unwrap().port().to_string();
    let (code, _, stderr) = rig.marfa(&["install", "--yes", "--access", "local", "--port", &busy]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("cannot be used"), "{stderr}");
    assert!(!rig.dir.exists());
}

#[test]
fn a_service_manager_that_refuses_says_what_it_said_and_what_to_run() {
    let rig = Rig::new("n-refuses");
    let (flag, wanted) = if cfg!(target_os = "macos") {
        ("bootstrap-fails", "launchctl bootstrap")
    } else {
        ("start-fails", "systemctl --user start")
    };
    fs::write(rig.home().join(flag), "").unwrap();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains(wanted), "{stderr}");
}

#[test]
fn restart_stops_and_starts_the_service_and_says_when_the_server_did_not_come_back() {
    let rig = Rig::new("n-restart");
    rig.native_installed(&["--access", "local"]);
    let pid = rig.service_pid("marfa");

    let (code, stdout, stderr) = rig.marfa(&["restart", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let stopped = stdout.find("Stopped").expect(&stdout);
    let running = stdout.find("is running").expect(&stdout);
    assert!(
        stopped < running,
        "stop's words come before start's: {stdout}"
    );
    assert!(answers(rig.port));
    assert_ne!(rig.service_pid("marfa"), pid, "{}", rig.manager_log());

    let (code, stdout, _) = rig.marfa(&["--json", "restart", "--wait-seconds", "5"]);
    assert_eq!(code, 0);
    let said: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(said["stopped"]["stopped"], true, "{stdout}");
    assert_eq!(said["started"]["running"], true, "{stdout}");

    fs::write(rig.state.join("refuse"), "").unwrap();
    let (code, _, stderr) = rig.marfa(&["restart", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("will not start on its database"),
        "{stderr}"
    );
    // Witness: the same install, started with `stop` then `start`, ends alike.
    let (_, _, _) = rig.marfa(&["stop"]);
    let (alone, _, said) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(alone, 3, "{said}");
}

#[test]
fn a_server_that_refuses_its_database_is_reported_and_not_waited_for() {
    let rig = Rig::new("n-refused");
    fs::write(rig.state.join("refuse"), "").unwrap();
    let started = std::time::Instant::now();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("will not start on its database"),
        "{stderr}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "the install waited out the clock on a refusal"
    );
}

#[test]
fn a_native_server_stops_starts_and_upgrades_with_its_service() {
    let rig = Rig::new("n-lifecycle");
    rig.native_installed(&["--access", "local"]);

    let (code, stdout, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Stopped"), "{stdout}");
    let (_, status, _) = rig.marfa(&["--json", "status"]);
    assert!(status.contains("\"running\": false"), "{status}");
    assert!(rig.file(".env").contains("MARFA_RUNTIME=native"));
    // Earlier releases' `marfa` cannot run the service without the release named here.
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.0\n"));
    let (code, stdout, _) = rig.marfa(&["stop"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("was not running"), "{stdout}");

    let (code, stdout, stderr) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("is running"), "{stdout}");
    let (_, status, _) = rig.marfa(&["--json", "status"]);
    assert!(status.contains("\"running\": true"), "{status}");

    // The release is the installed program, so it is not named.
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.9"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("scripts/install.sh"), "{stderr}");
    let calls = rig.manager_log().lines().count();
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Already on 0.0.0"), "{stdout}");
    assert!(
        !rig.manager_log()
            .lines()
            .skip(calls)
            .any(|line| line.contains("kickstart") || line.contains("restart")),
        "an upgrade to the same release restarted the server: {}",
        rig.manager_log()
    );
}

impl Rig {
    /// The calls to the service manager since `from` that start, stop or reload the service.
    fn service_moves_since(&self, from: usize) -> Vec<String> {
        let moves = [
            "bootstrap",
            "bootout",
            "kickstart",
            " start ",
            " stop ",
            " restart ",
        ];
        self.manager_log()
            .lines()
            .skip(from)
            .filter(|line| moves.iter().any(|word| line.contains(word)))
            .map(str::to_string)
            .collect()
    }
}

#[test]
fn start_and_restart_keep_an_install_on_its_release_and_name_the_command_that_moves_it() {
    let rig = Rig::new("n-other-release");
    rig.native_installed(&["--access", "local"]);
    let pid = rig.service_pid("marfa");
    let upgrade = format!(
        "`marfa server upgrade --dir '{}'` moves it to 0.0.0, once 0.0.0 has said it opens the database",
        rig.real_dir().display()
    );

    // The programs the service runs were replaced in place while an earlier release runs.
    rig.on_an_earlier_release();
    let service = fs::read_to_string(rig.service_file("marfa")).unwrap();
    let calls = rig.manager_log().lines().count();
    for command in ["start", "restart"] {
        let (code, _, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
        assert_eq!(code, 2, "{command}: {stderr}");
        assert!(
            stderr.contains(
                "this install is on 0.0.0-before, and the programs its service runs are now 0.0.0: "
            ) && stderr.contains(&upgrade),
            "{command}: {stderr}"
        );
    }

    // The service runs another release's programs, newer than this marfa.
    rig.serve_from("0.0.5");
    let service_from = fs::read_to_string(rig.service_file("marfa")).unwrap();
    for command in ["start", "restart"] {
        let (code, _, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
        assert_eq!(code, 2, "{command}: {stderr}");
        assert!(
            stderr.contains("this install runs 0.0.5 and this marfa is 0.0.0: ")
                && stderr.contains(&upgrade),
            "{command}: {stderr}"
        );
    }
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert_eq!(
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
        service_from
    );
    assert_ne!(service_from, service, "the witness");
    assert_eq!(rig.service_pid("marfa"), pid, "restart stopped the server");
    assert!(answers(rig.port));

    // Witness: once the command it names has moved the install, both go ahead.
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Upgraded from 0.0.5 to 0.0.0"), "{stdout}");
    for command in ["start", "restart"] {
        let (code, _, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
        assert_eq!(code, 0, "{command}: {stderr}");
    }
}

#[test]
fn start_names_a_marfa_that_moved_at_the_same_release_by_its_new_path() {
    let rig = Rig::new("n-moved");
    rig.native_installed(&["--access", "local"]);
    let moved = format!(
        "{}/bin/marfa",
        rig.root.file_name().unwrap().to_string_lossy()
    );
    let before = fs::read_to_string(rig.service_file("marfa")).unwrap();
    assert!(!before.contains(&moved), "the witness: {before}");

    rig.isolate();
    let (code, stdout, stderr) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("marfa 0.0.0 is running"), "{stdout}");
    let after = fs::read_to_string(rig.service_file("marfa")).unwrap();
    assert!(after.contains(&moved), "{after}");
}

#[test]
fn an_update_that_failed_after_one_that_succeeded_leaves_the_release_its_service_runs() {
    use marfa_rules::update_record::{Folder, Outcome};
    let rig = Rig::new("u-recorded");
    rig.native_installed(&["--access", "local"]);
    // A release written in `.env` is not what the service runs.
    rig.recorded_release("0.0.0-before");
    let record = Folder::beside(&rig.dir.join("data/marfa.db"));
    record
        .end(
            "2026-11-20T10:00:00Z",
            Outcome::Succeeded,
            "0.0.0",
            None,
            Some(ATTEMPT),
        )
        .unwrap();
    // The next update failed, and its server was put back in place.
    record
        .end(
            "2026-11-21T10:00:00Z",
            Outcome::Failed,
            "0.0.1",
            Some("it did not answer".into()),
            Some(ATTEMPT),
        )
        .unwrap();

    let (code, stdout, stderr) = rig.marfa(&["--json", "status"]);
    assert_eq!(code, 0, "{stderr}");
    let status: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(status["release"], "0.0.0", "{stdout}");
    let (code, stdout, stderr) = rig.marfa(&["status"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("0.0.0") && !stdout.contains("0.0.0-before"),
        "{stdout}"
    );

    for command in ["start", "restart"] {
        let (code, stdout, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
        assert_eq!(code, 0, "{command}: {stderr}");
        assert!(
            stdout.contains("marfa 0.0.0 is running"),
            "{command}: {stdout}"
        );
    }
    let restarts = rig.restarts();
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Already on 0.0.0"), "{stdout}");
    assert_eq!(rig.restarts(), restarts, "{}", rig.manager_log());

    // Witness: the release the server runs is read, so an earlier one shows.
    rig.on_an_earlier_release();
    let (_, stdout, _) = rig.marfa(&["status"]);
    assert!(stdout.contains("0.0.0-before"), "{stdout}");
}

#[test]
fn a_native_upgrade_goes_back_to_an_earlier_release_once_it_says_it_opens_the_database() {
    let rig = Rig::new("n-back");
    rig.isolate();
    rig.native_installed(&["--access", "local"]);
    rig.serve_from("0.0.5");
    fs::write(
        rig.state.join("cannot-open"),
        "The database is at schema version 3, which a newer build wrote; this build reads schema version 2.",
    )
    .unwrap();
    let dotenv = rig.file(".env");
    let service = fs::read_to_string(rig.service_file("marfa")).unwrap();
    let pid = rig.service_pid("marfa");
    let calls = rig.manager_log().lines().count();

    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains(
            "0.0.0 will not run on this install's settings and database, so nothing was changed"
        ) && stderr.contains("a newer build wrote")
            && stderr.contains("while 0.0.5 runs"),
        "{stderr}"
    );
    // The programs the service runs are still 0.0.5's, so nothing needs putting back.
    assert!(!stderr.contains("MARFA_VERSION"), "{stderr}");
    assert_eq!(rig.file(".env"), dotenv);
    assert_eq!(
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
        service
    );
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert_eq!(rig.service_pid("marfa"), pid);
    assert!(answers(rig.port));

    // Witness: an earlier release that opens the database is moved to.
    fs::remove_file(rig.state.join("cannot-open")).unwrap();
    let (code, stdout, stderr) = rig.marfa(&["--json", "upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let report: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(report["from"], "0.0.5", "{stdout}");
    assert_eq!(report["release"], "0.0.0", "{stdout}");
    assert_eq!(report["changed"], true, "{stdout}");
    assert_eq!(
        rig.service_program(),
        rig.root.join("bin/marfa").to_string_lossy()
    );
    let (_, stdout, _) = rig.marfa(&["--json", "status"]);
    let status: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(status["release"], "0.0.0", "{stdout}");
}

#[test]
fn install_never_moves_a_native_install_to_another_release_and_names_upgrade() {
    let rig = Rig::new("n-install-other");
    rig.native_installed(&["--access", "local"]);
    rig.serve_from("0.0.5");
    let service = fs::read_to_string(rig.service_file("marfa")).unwrap();
    let calls = rig.manager_log().lines().count();

    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains(
            "this install runs 0.0.5 and this marfa is 0.0.0: `marfa server upgrade --dir "
        ),
        "{stderr}"
    );
    assert_eq!(
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
        service
    );
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());

    // Witness: once upgrade has moved it, install runs on it again.
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn a_first_native_install_on_a_database_this_release_will_not_open_writes_nothing() {
    let rig = Rig::new("n-install-cannot-open");
    rig.isolate();
    // Restored data and its settings, with no service to say which release ran on them.
    fs::create_dir_all(rig.dir.join("data")).unwrap();
    fs::write(rig.dir.join("data/marfa.db"), "").unwrap();
    fs::write(
        rig.dir.join("marfa.env"),
        "MARFA_KEY_SALT=a-salt-for-a-test\nMARFA_AUTH_SECRET=a-secret-for-a-test\n",
    )
    .unwrap();
    fs::write(
        rig.state.join("cannot-open"),
        "The database is at schema version 3, which a newer build wrote; this build reads schema version 2.",
    )
    .unwrap();

    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("0.0.0 will not run on the database in")
            && stderr.contains("a newer build wrote")
            && stderr.contains("Install the release that last ran on it"),
        "{stderr}"
    );
    assert!(!rig.service_file("marfa").exists());
    assert!(!rig.dir.join(".env").exists());

    // Witness: the same folder, with a database it opens, is installed.
    fs::remove_file(rig.state.join("cannot-open")).unwrap();
    rig.native_installed(&["--access", "local"]);
}

#[test]
fn start_and_restart_go_ahead_while_the_install_tries_the_new_server_of_an_update() {
    let rig = Rig::new("n-trying");
    rig.isolate();
    rig.native_installed(&["--access", "local"]);
    rig.keep_pending("0.0.0", "0.0.1", 0);
    // The update swapped its server in beside the marfa the service runs.
    let new = [("FAKE_SERVER_VERSION", Path::new("0.0.1"))];
    for command in ["start", "restart"] {
        let (code, stdout, stderr) = rig.marfa_with(&[command, "--wait-seconds", "5"], &new);
        assert_eq!(code, 0, "{command}: {stderr}");
        assert!(
            stdout.contains("marfa 0.0.1 is running"),
            "{command}: {stdout}"
        );
    }

    // Witness: with no update under way, the same programs are another release's.
    fs::remove_file(rig.update_record().join("pending.json")).unwrap();
    let (code, _, stderr) = rig.marfa_with(&["start", "--wait-seconds", "5"], &new);
    assert_ne!(code, 0, "{stderr}");
    assert!(stderr.contains("0.0.1"), "{stderr}");
}

#[test]
fn the_question_to_a_new_release_carries_the_installs_environment_and_not_the_shells() {
    let rig = Rig::new("n-probe-env");
    rig.isolate();
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();
    fs::write(rig.state.join("refuse-otel"), "").unwrap();
    // Telemetry this shell sets is not where the service sends it, and the SDK stays off.
    let endpoint = [(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        Path::new("ftp://only-this-shell"),
    )];
    let (code, stdout, stderr) = rig.marfa_with(&["upgrade", "--wait-seconds", "5"], &endpoint);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("Upgraded from 0.0.0-before to 0.0.0"),
        "{stdout}"
    );
    let asked = fs::read_to_string(rig.state.join("asked-can-open")).unwrap();
    assert!(asked.trim_end().ends_with("data/marfa.db"), "{asked}");

    // Witness: set in the install's settings, the same value is asked about, and refused.
    rig.on_an_earlier_release();
    let settings = rig.dir.join("marfa.env");
    fs::write(
        &settings,
        format!(
            "{}OTEL_EXPORTER_OTLP_ENDPOINT=ftp://in-the-settings\n",
            fs::read_to_string(&settings).unwrap()
        ),
    )
    .unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains("OTEL_EXPORTER_OTLP_ENDPOINT"), "{stderr}");
}

#[test]
fn a_native_upgrade_to_a_release_that_will_not_open_the_database_changes_nothing() {
    let rig = Rig::new("n-cannot-open");
    rig.isolate();
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();
    fs::write(
        rig.state.join("cannot-open"),
        "The database was written by a build this one does not read.",
    )
    .unwrap();
    let dotenv = rig.file(".env");
    let service = fs::read_to_string(rig.service_file("marfa")).unwrap();
    let pid = rig.service_pid("marfa");
    let calls = rig.manager_log().lines().count();

    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains(
            "0.0.0 will not run on this install's settings and database, so nothing was changed"
        ) && stderr.contains("a build this one does not read")
            && stderr.contains("marfa export")
            && stderr.contains("marfa restore"),
        "{stderr}"
    );
    // The programs were replaced in place, so the next start would meet the same refusal: the
    // earlier release is put back where the service runs it.
    let programs = rig.root.join("bin");
    assert!(
        stderr.contains("To put 0.0.0-before back, install it the way you installed marfa")
            && stderr.contains(&format!(
                "MARFA_VERSION=0.0.0-before MARFA_INSTALL_DIR='{}' sh`",
                programs.display()
            ))
            && stderr.contains(&format!(
                "then run `'{}'/marfa server upgrade --dir '{}'`",
                programs.display(),
                rig.real_dir().display()
            )),
        "{stderr}"
    );
    let asked = fs::read_to_string(rig.state.join("asked-can-open")).unwrap();
    assert!(asked.trim_end().ends_with("data/marfa.db"), "{asked}");
    assert_eq!(rig.file(".env"), dotenv);
    assert_eq!(
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
        service
    );
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert_eq!(rig.service_pid("marfa"), pid);
    assert!(answers(rig.port));

    // Witness: the same upgrade, with a release that opens the database, moves the install.
    fs::remove_file(rig.state.join("cannot-open")).unwrap();
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("Upgraded from 0.0.0-before to 0.0.0"),
        "{stdout}"
    );
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.0\n"));
}

/// An install an earlier release served and stopped, whose programs were then replaced in
/// place with this release's.
fn stopped_and_replaced(name: &str) -> Rig {
    let rig = Rig::new(name);
    rig.isolate();
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();
    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!answers(rig.port));
    rig
}

#[test]
fn a_stopped_install_whose_programs_were_replaced_is_moved_only_by_upgrade() {
    let rig = stopped_and_replaced("n-stopped-replaced");
    let service = fs::read_to_string(rig.service_file("marfa")).unwrap();
    let calls = rig.manager_log().lines().count();
    let moved_by = format!(
        "this install is on 0.0.0-before, and the programs its service runs are now 0.0.0: `marfa server upgrade --dir '{}'` moves it to 0.0.0, once 0.0.0 has said it opens the database",
        rig.real_dir().display()
    );

    for command in ["start", "restart"] {
        let (code, _, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
        assert_eq!(code, 2, "{command}: {stderr}");
        assert!(stderr.contains(&moved_by), "{command}: {stderr}");
    }
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 2, "install: {stderr}");
    assert!(stderr.contains(&moved_by), "install: {stderr}");
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert_eq!(
        fs::read_to_string(rig.service_file("marfa")).unwrap(),
        service
    );
    assert!(!answers(rig.port));
    let (_, stdout, _) = rig.marfa(&["--json", "status"]);
    let status: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(status["release"], "0.0.0-before", "{stdout}");
    let (_, stdout, _) = rig.marfa(&["status"]);
    assert!(
        stdout.contains("Programs  0.0.0: `marfa server upgrade --dir "),
        "{stdout}"
    );

    // Witness: once upgrade has moved it, the install starts and restarts.
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("Started 0.0.0, which this install is on."),
        "{stdout}"
    );
    // A release the install is on that refuses has nothing to go back to or move to.
    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    fs::write(rig.state.join("cannot-open"), "The settings do not read.").unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("0.0.0 will not run on this install's settings and database")
            && stderr.contains("The settings do not read.")
            && !stderr.contains("To put")
            && !stderr.contains("marfa export"),
        "{stderr}"
    );
    fs::remove_file(rig.state.join("cannot-open")).unwrap();
    for command in ["start", "restart"] {
        let (code, _, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
        assert_eq!(code, 0, "{command}: {stderr}");
    }
    let (_, stdout, _) = rig.marfa(&["status"]);
    assert!(!stdout.contains("Programs"), "{stdout}");
}

#[test]
fn a_refused_upgrade_of_a_stopped_install_puts_back_the_release_it_is_on() {
    let rig = stopped_and_replaced("n-stopped-refused");
    let calls = rig.manager_log().lines().count();
    fs::write(
        rig.state.join("cannot-open"),
        "The database was written by a build this one does not read.",
    )
    .unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("To put 0.0.0-before back, install it the way you installed marfa")
            && stderr.contains("MARFA_VERSION=0.0.0-before ")
            && stderr.contains("while 0.0.0-before runs"),
        "{stderr}"
    );
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert!(!answers(rig.port));
}

#[test]
fn a_passing_upgrade_of_a_stopped_install_moves_it_from_the_release_it_is_on() {
    let rig = stopped_and_replaced("n-stopped-passing");
    let (code, stdout, stderr) = rig.marfa(&["--json", "upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let report: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(report["from"], "0.0.0-before", "{stdout}");
    assert_eq!(report["release"], "0.0.0", "{stdout}");
    assert_eq!(report["changed"], true, "{stdout}");
    assert_eq!(rig.file("data/marfa.db.release"), "0.0.0\n");
}

/// An install whose database only releases up to 0.0.85 served, stopped, with `.env` naming
/// `recorded`, which releases up to 0.0.85 do not keep up to date.
fn served_before_the_record(name: &str, recorded: &str) -> Rig {
    let rig = Rig::new(name);
    rig.isolate();
    fs::write(rig.state.join("no-release-record"), "").unwrap();
    rig.native_installed(&["--access", "local"]);
    assert!(!rig.dir.join("data/marfa.db.release").exists());
    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    rig.recorded_release(recorded);
    rig
}

#[test]
fn an_install_whose_database_names_no_release_is_on_a_release_that_cannot_be_told() {
    let rig = served_before_the_record("n-no-record", "0.0.0-before");
    let calls = rig.manager_log().lines().count();

    // `.env` may be stale, so the release it names is not put in the refusal, and it does not
    // let a start through either, whether or not it names the programs' release.
    for recorded in ["0.0.0-before", "0.0.0"] {
        rig.recorded_release(recorded);
        for command in ["start", "restart"] {
            let (code, _, stderr) = rig.marfa(&[command, "--wait-seconds", "5"]);
            assert_eq!(code, 2, "{command}: {stderr}");
            assert!(
                stderr.contains("the release this install is on cannot be told, because ")
                    && stderr.contains("`marfa server upgrade --dir ")
                    && !stderr.contains("this install is on 0.0.")
                    && !stderr.contains("0.0.0-before"),
                "{command} with .env on {recorded}: {stderr}"
            );
        }
    }
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert!(!answers(rig.port));

    // Status says what `.env` records, and that it is not the release that ran.
    let (_, stdout, _) = rig.marfa(&["--json", "status"]);
    let status: serde_json::Value = serde_json::from_str(&stdout).expect(&stdout);
    assert_eq!(status["release"], serde_json::Value::Null, "{stdout}");
    let (_, stdout, _) = rig.marfa(&["status"]);
    assert!(
        stdout.contains("Release   cannot be told")
            && stdout.contains("Recorded  0.0.0 in .env")
            && stdout.contains("may not be the release that last ran"),
        "{stdout}"
    );

    // With no line at all, the release cannot be told either, and only upgrade moves the install.
    let dotenv: String = rig
        .file(".env")
        .lines()
        .filter(|line| !line.starts_with("MARFA_RELEASE="))
        .map(|line| format!("{line}\n"))
        .collect();
    fs::write(rig.dir.join(".env"), dotenv).unwrap();
    let (code, _, stderr) = rig.marfa(&["start", "--wait-seconds", "5"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("the release this install is on cannot be told, because ")
            && stderr.contains("`marfa server upgrade --dir "),
        "{stderr}"
    );
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Upgraded to 0.0.0"), "{stdout}");
}

#[test]
fn a_refused_upgrade_of_an_install_that_only_env_names_puts_back_no_named_release() {
    let rig = served_before_the_record("n-no-record-refused", "0.0.0-before");
    let calls = rig.manager_log().lines().count();
    fs::write(
        rig.state.join("cannot-open"),
        "The database was written by a build this one does not read.",
    )
    .unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("The release that last ran on this install cannot be told")
            && stderr.contains("install it the way you installed marfa")
            && stderr.contains("`marfa server restart --dir ")
            && stderr.contains("with that release's marfa")
            && !stderr.contains("0.0.0-before")
            && !stderr.contains("MARFA_VERSION")
            && !stderr.contains("<release>"),
        "{stderr}"
    );
    assert_eq!(rig.service_moves_since(calls), Vec::<String>::new());
    assert!(!answers(rig.port));

    // The same install, once its release is known, is told which one to put back.
    fs::create_dir_all(rig.dir.join("data")).unwrap();
    rig.name_served("0.0.0-before");
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("To put 0.0.0-before back")
            && stderr.contains("MARFA_VERSION=0.0.0-before "),
        "{stderr}"
    );
}

impl Rig {
    /// The server still running an earlier release, after the programs the service runs were
    /// replaced in place by this one's, as Homebrew and the install script do, so that an
    /// upgrade moves it.
    fn on_an_earlier_release(&self) {
        self.running("0.0.0-before");
        self.name_served("0.0.0-before");
        self.recorded_release("0.0.0-before");
    }

    /// The release `.env` names, which earlier releases' `marfa` reads.
    fn recorded_release(&self, release: &str) {
        let mut dotenv: String = self
            .file(".env")
            .lines()
            .filter(|line| !line.starts_with("MARFA_RELEASE="))
            .map(|line| format!("{line}\n"))
            .collect();
        dotenv.push_str(&format!("MARFA_RELEASE={release}\n"));
        fs::write(self.dir.join(".env"), dotenv).unwrap();
    }

    /// The release the server answering on the install's port says it is.
    fn running(&self, release: &str) {
        fs::write(self.state.join(format!("version-{}", self.port)), release).unwrap();
    }

    /// The `marfa` the service definition names.
    fn service_program(&self) -> String {
        let text = fs::read_to_string(self.service_file("marfa")).unwrap();
        if cfg!(target_os = "macos") {
            let after = text.split("<key>ProgramArguments</key>").nth(1).unwrap();
            let start = after.find("<string>").unwrap() + "<string>".len();
            after[start..]
                .split("</string>")
                .next()
                .unwrap()
                .to_string()
        } else {
            let line = text
                .lines()
                .find_map(|line| line.strip_prefix("ExecStart="))
                .unwrap();
            line.trim_start_matches('"')
                .split(['"', ' '])
                .next()
                .unwrap()
                .to_string()
        }
    }

    /// The install as `release`'s `marfa`, kept in a folder of its own, made it: its service
    /// runs that release's programs, and that release is the one running.
    fn serve_from(&self, release: &str) {
        let programs = self.root.join(format!("r-{release}"));
        fs::create_dir_all(&programs).unwrap();
        script(&programs.join("marfa"), "#!/bin/sh\nexit 0\n");
        script(
            &programs.join("marfa-server"),
            &FAKE_SERVER.replace("${FAKE_SERVER_VERSION:-0.0.0}", release),
        );
        let file = self.service_file("marfa");
        let program = self.service_program();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains(&program), "{text}");
        let moved = text.replacen(&program, &programs.join("marfa").to_string_lossy(), 1);
        fs::write(&file, moved).unwrap();
        self.running(release);
        self.name_served(release);
    }

    /// What the server logs when the service starts it, and whether it then stays down.
    fn the_server_logs(&self, lines: &str, stays_down: bool) {
        fs::write(self.state.join("logs-with"), lines).unwrap();
        if stays_down {
            fs::write(self.state.join("stops"), "").unwrap();
        }
    }

    /// Adds lines to the log the service manager keeps for the server: launchd's file, or the
    /// journal's stand-in.
    fn the_service_logged(&self, lines: &str) {
        use std::io::Write;
        let log = if cfg!(target_os = "macos") {
            self.home().join("Library/Logs/Marfa/marfa.log")
        } else {
            self.state.join("server-log")
        };
        fs::create_dir_all(log.parent().unwrap()).unwrap();
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .unwrap()
            .write_all(lines.as_bytes())
            .unwrap();
    }
}

fn refused_line(refusal: marfa_rules::server_log::UpgradeRefusal, error: &str) -> String {
    use marfa_rules::server_log::{ERROR, REFUSED, START_FAILED};
    log_line(
        "error",
        START_FAILED,
        serde_json::json!({ ERROR: error, REFUSED: refusal.name() }),
    )
}

#[test]
fn a_native_upgrade_the_server_declines_says_why_and_that_the_service_keeps_trying() {
    use marfa_rules::server_log::UpgradeRefusal;
    let rig = Rig::new("n-upgrade-declined");
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();
    let why = "was not upgraded from schema version 1, because the copy kept before an upgrade could not be written: 4096 bytes are free. Nothing was changed.";
    rig.the_server_logs(&refused_line(UpgradeRefusal::CopyNotMade, why), true);

    let started = std::time::Instant::now();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "30"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "it waited out --wait"
    );
    assert!(
        stderr.contains(
            "0.0.0 did not update the database, because the copy kept first could not be made"
        ),
        "{stderr}"
    );
    assert!(stderr.contains("4096 bytes are free"), "{stderr}");
    assert!(
        stderr.contains("The service keeps trying to start 0.0.0"),
        "{stderr}"
    );
    assert!(stderr.contains("marfa server stop --dir"), "{stderr}");
    assert!(stderr.contains("still reads it"), "{stderr}");
    // The earlier release's `marfa`, put back, reads its own release where it left it.
    assert!(
        rig.file(".env").contains("MARFA_RELEASE=0.0.0-before\n"),
        "{}",
        rig.file(".env")
    );

    // The unreadable-settings refusal is told apart from a copy that could not be made.
    let why = "was not upgraded, because its stored setting disk_reserve_bytes does not read as a number. Nothing was changed.";
    rig.the_server_logs(&refused_line(UpgradeRefusal::SettingsUnreadable, why), true);
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "30"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(
        stderr.contains("because the settings stored in the database could not be used"),
        "{stderr}"
    );
    assert!(!stderr.contains("the copy kept first"), "{stderr}");

    // Witness: a start that stopped for another reason is not taken for a refusal.
    rig.the_server_logs(
        &start_failed_line("The port 8080 is already taken (EADDRINUSE)"),
        true,
    );
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "1"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(!stderr.contains("did not update the database"), "{stderr}");
    assert!(!stderr.contains("keeps trying"), "{stderr}");
}

#[test]
fn a_native_upgrade_reads_only_what_this_start_logged() {
    use marfa_rules::server_log::UpgradeRefusal;
    let rig = Rig::new("n-upgrade-this-start");
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();
    let refused = refused_line(UpgradeRefusal::CopyNotMade, "no room. Nothing was changed.");

    // An earlier start's refusal, and an upgrade an earlier release logged, are not this one's.
    rig.the_service_logged(
        &(refused.clone() + &upgraded_line_by("0.0.0-before", 1, 2, Some(COPY_PATH))),
    );
    rig.the_server_logs(
        &start_failed_line("The port 8080 is already taken (EADDRINUSE)"),
        true,
    );
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "1"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(!stderr.contains("did not update the database"), "{stderr}");

    // The service now runs 0.0.0's programs, which never served, and this run starts its server.
    fs::remove_file(rig.state.join("stops")).unwrap();
    fs::remove_file(rig.state.join("logs-with")).unwrap();
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("Upgraded from 0.0.0-before to 0.0.0."),
        "{stdout}"
    );
    assert!(!stdout.contains("schema version"), "{stdout}");
    assert!(!stdout.contains(COPY_PATH), "{stdout}");

    // Witness: the same upgrade, when this start logs one, reports it.
    rig.on_an_earlier_release();
    rig.the_server_logs(&upgraded_line(2, 3, None), false);
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("from schema version 2 to 3"), "{stdout}");
    assert!(!stdout.contains("earlier start"), "{stdout}");
    assert!(!stdout.contains(COPY_PATH), "{stdout}");
}

#[test]
fn a_retried_native_upgrade_still_names_the_copy_an_earlier_start_made() {
    let rig = Rig::new("n-upgrade-retry");
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();

    // The wait ends while the server is still copying.
    rig.the_server_logs("", true);
    let (code, _, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "1"]);
    assert_ne!(code, 0, "{stderr}");
    fs::remove_file(rig.state.join("stops")).unwrap();

    // Witness: what an earlier release logged is not this release's update.
    rig.the_service_logged(&upgraded_line_by(
        "0.0.0-before",
        1,
        2,
        Some("/data/other.db"),
    ));
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        !stdout.contains("other.db") && !stdout.contains("copy"),
        "{stdout}"
    );

    // The first start finished the update after the wait ended, and the run again restarts the
    // server, which finds nothing to update and logs nothing of one.
    rig.on_an_earlier_release();
    rig.the_service_logged(&upgraded_line(1, 2, Some(COPY_PATH)));
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        stdout.contains("An earlier start of this release"),
        "{stdout}"
    );
    assert!(stdout.contains("from schema version 1 to 2"), "{stdout}");
    assert!(stdout.contains(COPY_PATH), "{stdout}");

    rig.on_an_earlier_release();
    let (code, json, stderr) = rig.marfa(&["--json", "upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let report: serde_json::Value = serde_json::from_str(&json).expect(&json);
    assert_eq!(report["database_update"]["copy"], COPY_PATH, "{json}");
    assert_eq!(report["database_update"]["earlier_start"], true, "{json}");
    assert_eq!(report["log_read"], true, "{json}");
}

// The journal's stand-in is the only log a test can make unreadable.
#[cfg(target_os = "linux")]
#[test]
fn a_native_upgrade_whose_log_cannot_be_read_does_not_say_no_copy_was_made() {
    let rig = Rig::new("n-upgrade-unread");
    rig.native_installed(&["--access", "local"]);
    rig.on_an_earlier_release();
    fs::write(rig.state.join("journal-unreadable"), "").unwrap();

    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("The log could not be read"), "{stdout}");
    assert!(!stdout.contains("no copy was made"), "{stdout}");

    rig.on_an_earlier_release();
    let (code, json, stderr) = rig.marfa(&["--json", "upgrade", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    let report: serde_json::Value = serde_json::from_str(&json).expect(&json);
    assert_eq!(report["database_update"], serde_json::Value::Null, "{json}");
    assert_eq!(report["log_read"], false, "{json}");
}

// What `docker logs` holds of a container's earlier runs is not what this start said.
#[test]
fn a_docker_upgrade_reads_only_the_containers_current_run() {
    use marfa_rules::server_log::UpgradeRefusal;
    let rig = Rig::new("upgrade-this-run");
    rig.installed(&["--access", "local"]);
    fs::write(
        rig.state.join("server-log-earlier"),
        refused_line(UpgradeRefusal::CopyNotMade, "no room. Nothing was changed.")
            + &upgraded_line(1, 2, Some(COPY_PATH)),
    )
    .unwrap();
    fs::write(rig.state.join("unhealthy"), "").unwrap();
    fs::write(
        rig.state.join("server-log"),
        start_failed_line("The port 8080 is already taken (EADDRINUSE)"),
    )
    .unwrap();
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "1"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(!stderr.contains("did not update the database"), "{stderr}");

    fs::remove_file(rig.state.join("unhealthy")).unwrap();
    fs::write(rig.state.join("server-log"), "a line of the server's log\n").unwrap();
    let report = upgrade_json(&rig, "0.0.94");
    assert_eq!(report["database_update"], serde_json::Value::Null);
}

#[test]
fn a_docker_upgrade_whose_run_cannot_be_told_from_an_earlier_one_says_the_log_could_not_be_read() {
    let rig = Rig::new("upgrade-unread");
    rig.installed(&["--access", "local"]);
    fs::write(
        rig.state.join("server-log"),
        upgraded_line(1, 2, Some(COPY_PATH)),
    )
    .unwrap();
    fs::write(rig.state.join("started-at-unreadable"), "").unwrap();

    let (code, stdout, stderr) =
        rig.marfa(&["upgrade", "--release", "0.0.93", "--wait-seconds", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("The log could not be read"), "{stdout}");
    assert!(!stdout.contains("no copy was made"), "{stdout}");
    assert!(!stdout.contains(COPY_PATH), "{stdout}");
    let report = upgrade_json(&rig, "0.0.94");
    assert_eq!(report["database_update"], serde_json::Value::Null);
    assert_eq!(report["log_read"], false);

    // Witness: with the start readable, the same log is read and says so.
    fs::remove_file(rig.state.join("started-at-unreadable")).unwrap();
    let report = upgrade_json(&rig, "0.0.95");
    assert_eq!(report["database_update"]["copy"], COPY_PATH);
    assert_eq!(report["log_read"], true);
}

#[test]
fn uninstalling_a_native_server_keeps_its_data_unless_told_to_delete_it() {
    let rig = Rig::new("n-uninstall");
    rig.native_installed(&["--access", "local"]);
    let data = rig.dir.join("data");
    fs::create_dir_all(&data).unwrap();
    fs::write(data.join("marfa.db"), "rows").unwrap();

    let (code, stdout, stderr) = rig.marfa(&["uninstall"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("Its data stays in"), "{stdout}");
    assert!(!rig.service_file("marfa").exists());
    assert!(data.join("marfa.db").exists() && rig.dir.join("marfa.env").exists());
    if cfg!(target_os = "macos") {
        assert!(!rig.home().join("loaded-marfa").exists());
    }

    // Data is never started on new secrets: with the settings gone, an install refuses.
    let secrets_copy = rig.file("marfa.env");
    fs::remove_file(rig.dir.join("marfa.env")).unwrap();
    fs::remove_file(rig.dir.join(".env")).unwrap();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("already holds data"), "{stderr}");
    fs::write(rig.dir.join("marfa.env"), secrets_copy).unwrap();
    rig.native_installed(&["--access", "local"]);

    let logs = rig.home().join("Library/Logs/Marfa");
    fs::create_dir_all(&logs).unwrap();
    for name in ["marfa.log", "marfa.log.1", "marfa.launchd.log"] {
        fs::write(logs.join(name), "line").unwrap();
    }
    let (code, _, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!rig.dir.exists(), "the folder and its data were left");
    if cfg!(target_os = "macos") {
        assert!(
            fs::read_dir(&logs).unwrap().next().is_none(),
            "the logs were left"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a_user_service_asks_for_lingering_and_says_the_one_line_when_it_is_refused() {
    let rig = Rig::new("n-linger");
    rig.native_installed(&["--access", "local"]);
    assert!(
        rig.home().join("linger").exists(),
        "lingering was not asked for"
    );
    assert!(rig.home().join("enabled-marfa-marfa.service").exists());

    let refused = Rig::new("n-linger-refused");
    fs::write(refused.home().join("linger-refused"), "").unwrap();
    let (code, stdout, stderr) = refused.native(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("sudo loginctl enable-linger"), "{stdout}");
    assert!(stdout.contains("TICKET123"), "{stdout}");

    let none = Rig::new("n-no-session");
    fs::write(none.home().join("no-user-session"), "").unwrap();
    let (code, _, stderr) = none.native(&["--access", "local"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(
        stderr.contains("systemd is not running for this account"),
        "{stderr}"
    );
    assert!(!none.dir.exists());
}

// ---- `marfa server run` -------------------------------------------------

impl Rig {
    /// `marfa server run` as a child process that outlives the call.
    fn run_server(&self, env: &[(&str, &str)]) -> Run {
        self.isolate();
        let mut command = self.command();
        command
            .args(["server", "run", "--dir"])
            .arg(&self.dir)
            .env("FAKE_DOCKER_STATE", &self.state)
            .env("MARFA_AUTOSTART_ROOT", self.home())
            .env("PATH", self.path())
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(fs::File::create(self.root.join("run.out")).unwrap())
            .stderr(fs::File::create(self.root.join("run.err")).unwrap());
        for (name, value) in env {
            command.env(name, value);
        }
        let _held = SOCKETS.lock().unwrap();
        Run(command.spawn().unwrap())
    }

    fn run_said(&self) -> String {
        fs::read_to_string(self.root.join("run.err")).unwrap_or_default()
    }
}

/// A `marfa server run` that leads its own process group. A test that fails
/// before the run ends would otherwise leave the run and its stand-in server
/// running after the test process exits.
struct Run(std::process::Child);

impl std::ops::Deref for Run {
    type Target = std::process::Child;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Run {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if let Ok(None) = self.0.try_wait() {
            stop_group(&mut self.0);
        }
    }
}

/// Kills the group a run leads. The run is not yet reaped, so its process ID
/// still names that group and no other.
fn stop_group(child: &mut std::process::Child) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", child.id())])
        .status();
    let _ = child.wait();
}

/// Waits for the child to end, and gives up (stopping its process group)
/// after `seconds`.
fn ended(child: &mut std::process::Child, seconds: u64) -> Option<std::process::ExitStatus> {
    let until = std::time::Instant::now() + Duration::from_secs(seconds);
    while std::time::Instant::now() < until {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    stop_group(child);
    None
}

fn wait_for(path: &Path) {
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < until,
            "{} never appeared",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn signal(child: &std::process::Child, name: &str) {
    assert!(
        Command::new("kill")
            .arg(format!("-{name}"))
            .arg(child.id().to_string())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn run_starts_the_server_with_the_settings_of_its_folder() {
    let rig = Rig::new("r-env");
    rig.native_installed(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ]);
    let mut child = rig.run_server(&[]);
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(0));
    let env = fs::read_to_string(rig.state.join("server-env")).unwrap();
    let dir = rig.real_dir();
    for line in [
        format!("MARFA_PORT={}", rig.port),
        "MARFA_LISTEN_HOST=127.0.0.1".to_string(),
        format!("MARFA_DATABASE_PATH={}/data/marfa.db", dir.display()),
        format!("MARFA_BLOB_PATH={}/data/blobs", dir.display()),
        format!(
            "MARFA_CONTROL_SOCKET={}/data/control/marfa.sock",
            dir.display()
        ),
        "MARFA_TRUSTED_PROXY_CIDRS=127.0.0.0/8,::1/128".to_string(),
        format!("MARFA_KEY_SALT={}", secrets(&rig)[0]),
    ] {
        assert!(
            env.lines().any(|set| set == line),
            "{line}\n{}",
            env.replace(&secrets(&rig)[1], "...")
        );
    }
    // Where the machine has launchd, the log is kept in a file of the account.
    if cfg!(target_os = "macos") {
        let log = rig.home().join("Library/Logs/Marfa/marfa.log");
        assert!(log.exists(), "no log at {}", log.display());
    }
}

#[test]
fn run_takes_the_port_and_the_paths_from_the_folder_whatever_the_settings_file_says() {
    let rig = Rig::new("r-own");
    rig.native_installed(&["--access", "local"]);
    let mut text = rig.file("marfa.env");
    text.push_str(
        "MARFA_PORT=9123\nMARFA_LISTEN_HOST=0.0.0.0\nMARFA_DATABASE_PATH=/elsewhere/marfa.db\n",
    );
    fs::write(rig.dir.join("marfa.env"), text).unwrap();
    let mut child = rig.run_server(&[]);
    ended(&mut child, 20).expect("run did not end");
    let env = fs::read_to_string(rig.state.join("server-env")).unwrap();
    let dir = rig.real_dir();
    assert!(
        env.lines()
            .any(|line| line == format!("MARFA_PORT={}", rig.port)),
        "{env}"
    );
    assert!(
        env.lines()
            .any(|line| line == "MARFA_LISTEN_HOST=127.0.0.1"),
        "{env}"
    );
    assert!(
        env.lines()
            .any(|line| line == format!("MARFA_DATABASE_PATH={}/data/marfa.db", dir.display())),
        "{env}"
    );
    for name in ["MARFA_PORT=", "MARFA_LISTEN_HOST=", "MARFA_DATABASE_PATH="] {
        assert_eq!(
            env.lines().filter(|line| line.starts_with(name)).count(),
            1,
            "{name} set twice in {env}"
        );
    }
}

#[test]
fn a_server_on_the_path_is_never_the_one_run_starts() {
    let rig = Rig::new("r-path");
    rig.native_installed(&["--access", "local"]);
    fs::remove_file(rig.root.join("bin/marfa-server")).unwrap();
    let (code, _, stderr) = rig.marfa(&["stop"]);
    assert_eq!(code, 0, "{stderr}");
    let elsewhere = rig.root.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    script(&elsewhere.join("marfa-server"), FAKE_SERVER);
    let path = format!("{}:{}", elsewhere.display(), rig.path());
    let mut child = rig.run_server(&[("PATH", &path)]);
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(3));
    assert!(
        !rig.state.join("server-env").exists(),
        "run started a server found on the path"
    );
    assert!(
        rig.run_said().contains("beside"),
        "the refusal never says where the server is looked for: {}",
        rig.run_said()
    );
}

#[test]
fn run_ends_with_the_status_of_the_server() {
    let rig = Rig::new("r-status");
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[("FAKE_SERVER_EXIT", "7")]);
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(7));
}

#[test]
fn a_stop_reaches_the_server_and_run_ends_with_what_it_ended_with() {
    let rig = Rig::new("r-term");
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[("FAKE_SERVER_TRAP", "9")]);
    wait_for(&rig.state.join("ready"));
    signal(&child, "TERM");
    let status = ended(&mut child, 20).expect("run did not end after a stop");
    assert!(
        rig.state.join("term").exists(),
        "the server never heard the stop"
    );
    assert_eq!(status.code(), Some(9));
}

/// Whether a process still exists, a zombie not counting.
fn alive(pid: &str) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&output.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

fn gone(pid: &str) -> bool {
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while std::time::Instant::now() < until {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn ctrl_c_reaches_the_server_and_run_together() {
    let rig = Rig::new("r-ctrl-c");
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[("FAKE_SERVER_HANG", "1")]);
    wait_for(&rig.state.join("ready"));
    let server = fs::read_to_string(rig.state.join("server-pid")).unwrap();
    let server = server.trim();
    // A terminal sends Ctrl-C to the whole foreground group, and the server
    // here ignores nothing and handles nothing.
    assert!(
        Command::new("kill")
            .args(["-INT", "--", &format!("-{}", child.id())])
            .status()
            .unwrap()
            .success()
    );
    let status = ended(&mut child, 20).expect("run did not end after Ctrl-C");
    assert!(gone(server), "the server outlived run");
    assert_eq!(status.code(), Some(0));
}

#[cfg(target_os = "linux")]
#[test]
fn a_server_does_not_outlive_a_run_that_was_killed() {
    let rig = Rig::new("r-killed");
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[("FAKE_SERVER_HANG", "1")]);
    wait_for(&rig.state.join("ready"));
    let server = fs::read_to_string(rig.state.join("server-pid")).unwrap();
    let server = server.trim().to_string();
    signal(&child, "KILL");
    let _ = child.wait();
    let ended = gone(&server);
    if !ended {
        let _ = Command::new("kill").args(["-KILL", &server]).status();
    }
    assert!(ended, "the server stayed running after run was killed");
}

#[test]
fn a_server_that_refuses_its_database_is_not_started_again_and_run_waits_to_be_stopped() {
    let rig = Rig::new("r-refused");
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[
        ("FAKE_SERVER_EXIT", "78"),
        ("FAKE_SERVER_SAYS", "the database is from a newer release"),
    ]);
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !rig.run_said().contains("will not start on the database") {
        assert!(
            std::time::Instant::now() < until,
            "no refusal said: {}",
            rig.run_said()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(400));
    assert!(
        child.try_wait().unwrap().is_none(),
        "run ended on a refusal, so a supervisor would start it into the same one"
    );
    let said = rig.run_said();
    for command in ["stop", "start"] {
        assert!(
            said.contains(&format!(
                "`marfa server {command} --dir '{}'",
                rig.real_dir().display()
            )),
            "{said}"
        );
    }
    signal(&child, "TERM");
    let status = ended(&mut child, 20).expect("run did not end after a stop");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn run_refuses_a_server_of_another_release_and_a_missing_one() {
    let rig = Rig::new("r-refuse");
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[("FAKE_SERVER_VERSION", "9.9.9")]);
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(3));
    let said = rig.run_said();
    assert!(said.contains("9.9.9") && said.contains("0.0.0"), "{said}");
    assert!(!rig.state.join("server-env").exists());

    fs::remove_file(rig.root.join("bin/marfa-server")).unwrap();
    let mut child = rig.run_server(&[]);
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(3));
    assert!(
        rig.run_said().contains("marfa-server was not found"),
        "{}",
        rig.run_said()
    );
}

// ---- when the address moves ----------------------------------------------

#[test]
fn a_rerun_leaves_an_address_the_server_holds_and_says_so() {
    let rig = Rig::new("n-left");
    rig.native_installed(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ]);
    // Someone moved it on the server since.
    fs::write(rig.state.join("address"), "https://moved.example.com\n").unwrap();
    let (code, stdout, stderr) = rig.native(&["--access", "proxy"]);
    assert_eq!(code, 0, "{stdout}\n{stderr}");
    assert_eq!(rig.address().as_deref(), Some("https://moved.example.com"));
    assert!(
        stderr.contains("https://moved.example.com") && stderr.contains("left it there"),
        "{stderr}"
    );
    assert!(stdout.contains("https://moved.example.com"), "{stdout}");

    let (code, stdout, _) = rig.native(&["--access", "proxy", "--json"]);
    assert_eq!(code, 0, "{stdout}");
    let report: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(report["sign_in_address_left"], "https://moved.example.com");
    assert_eq!(report["address"], "https://moved.example.com");
}

#[test]
fn asking_for_a_new_address_or_a_new_way_moves_the_server_and_a_first_install_sets_it() {
    let rig = Rig::new("n-move");
    rig.native_installed(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(rig.address().as_deref(), Some("https://marfa.example.com"));
    let (code, _, stderr) = rig.native(&[
        "--access",
        "proxy",
        "--address",
        "https://other.example.com",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.address().as_deref(), Some("https://other.example.com"));

    // Another way of reaching it is asking to move too.
    fs::write(rig.state.join("address"), "https://moved.example.com\n").unwrap();
    let (code, _, stderr) = rig.native(&["--access", "cloudflare"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.address().as_deref(), Some("https://other.example.com"));

    // And asking for a local server clears the address that no longer fits.
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.address(), None);
}

// ---- the folder is the one this install made -----------------------------

#[test]
fn a_native_install_refuses_settings_that_move_what_the_folder_decides() {
    let rig = Rig::new("n-folder-settings");
    rig.native_installed(&["--access", "local"]);
    let mut text = rig.file("marfa.env");
    text.push_str("MARFA_DATABASE_PATH=/elsewhere/marfa.db\nMARFA_PORT=9123\n");
    fs::write(rig.dir.join("marfa.env"), &text).unwrap();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("MARFA_DATABASE_PATH") && stderr.contains("MARFA_PORT"),
        "{stderr}"
    );
    assert_eq!(rig.file("marfa.env"), text, "the refusal changed the file");

    let external = Rig::new("n-folder-external");
    fs::create_dir_all(&external.dir).unwrap();
    fs::write(
        external.dir.join("marfa.env"),
        "MARFA_KEY_SALT=a\nMARFA_AUTH_SECRET=b\nMARFA_BLOB_PATH=/elsewhere/blobs\n",
    )
    .unwrap();
    let (code, _, stderr) = external.native(&["--access", "local", "--external-settings"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("MARFA_BLOB_PATH"), "{stderr}");
}

#[test]
fn a_native_install_will_not_make_a_folder_of_something_else_its_own() {
    let rig = Rig::new("n-foreign");
    fs::create_dir_all(&rig.dir).unwrap();
    fs::write(rig.dir.join("notes.txt"), "mine").unwrap();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.contains("notes.txt") || stderr.contains("not a Marfa"),
        "{stderr}"
    );
    let mut names: Vec<_> = fs::read_dir(&rig.dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(
        names,
        ["notes.txt"],
        "something was written into the folder"
    );
}

#[test]
fn a_link_in_the_folder_is_never_followed_when_a_file_is_read_or_written() {
    let rig = Rig::new("n-link");
    rig.native_installed(&["--access", "local"]);
    let target = rig.root.join("elsewhere.env");
    fs::write(&target, "MARFA_KEY_SALT=a\nMARFA_AUTH_SECRET=b\n").unwrap();
    fs::remove_file(rig.dir.join("marfa.env")).unwrap();
    std::os::unix::fs::symlink(&target, rig.dir.join("marfa.env")).unwrap();
    let (code, _, stderr) = rig.native(&["--access", "local"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(stderr.contains("link"), "{stderr}");
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "MARFA_KEY_SALT=a\nMARFA_AUTH_SECRET=b\n",
        "a file behind a link was written"
    );
}

#[test]
fn deleting_data_refuses_a_data_folder_that_is_a_link() {
    let rig = Rig::new("n-data-link");
    rig.native_installed(&["--access", "local"]);
    let precious = rig.root.join("precious");
    fs::create_dir_all(&precious).unwrap();
    fs::write(precious.join("keep"), "x").unwrap();
    let data = rig.dir.join("data");
    let _ = fs::remove_dir_all(&data);
    std::os::unix::fs::symlink(&precious, &data).unwrap();
    let (code, _, stderr) = rig.marfa(&["uninstall", "--yes", "--delete-data"]);
    assert_ne!(code, 0, "{stderr}");
    assert!(precious.join("keep").exists(), "{stderr}");
    assert!(
        !rig.manager_log().contains("bootout") && !rig.manager_log().contains("stop"),
        "the server was stopped before the refusal: {}",
        rig.manager_log()
    );
}

// ---- the address on the socket ------------------------------------------

#[test]
fn the_address_for_setup_is_set_only_through_the_private_socket() {
    let rig = Rig::new("s-address");
    for args in [
        &[
            "setup",
            "open",
            "--no-browser",
            "--address",
            "https://marfa.example.com",
        ][..],
        &[
            "setup",
            "claim",
            "--address",
            "https://marfa.example.com",
            "--username",
            "a@example.com",
        ][..],
    ] {
        let mut command = quiet::marfa();
        command
            .args(args)
            .args(["--url", "http://127.0.0.1:1", "--key", "k"]);
        command.env("HOME", rig.home());
        let output = output_of(&mut command);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("--socket"),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

// ---- `marfa server run` trying the new server of an update --------------

/// The release an update kept aside: it says whether it opens the database as `can_open` says,
/// once it is asked about the database the server uses.
fn old_server(can_open: &str) -> String {
    format!(
        r#"#!/bin/sh
case "$1" in
  --version) echo "marfa-server 0.0.0"; exit 0 ;;
  --can-open)
    [ "$2" = "$MARFA_DATABASE_PATH" ] || {{ echo "asked about $2" >&2; exit 9; }}
    {can_open} ;;
  *) touch "$FAKE_DOCKER_STATE/old-ran"; exit 0 ;;
esac
"#
    )
}

const OPENS_SCHEMA_1: &str = r#"echo '{"schema":1,"standing":"current"}'"#;

impl Rig {
    fn programs(&self) -> PathBuf {
        self.root.join("bin")
    }

    fn update_record(&self) -> PathBuf {
        self.dir.join("data/update")
    }

    /// An installed server that swapped in release `to`'s server, with release `from`'s kept
    /// aside and release `to`'s `marfa` waiting.
    fn swapped(&self, from: &str, to: &str, starts: u64, can_open: &str) {
        self.native_installed(&["--access", "local"]);
        self.isolate();
        let bin = self.programs();
        script(&bin.join(".marfa-server.previous"), &old_server(can_open));
        fs::write(bin.join(".marfa.next"), "the new marfa").unwrap();
        self.keep_pending(from, to, starts);
    }

    fn keep_pending(&self, from: &str, to: &str, starts: u64) {
        fs::create_dir_all(self.update_record()).unwrap();
        let pending = serde_json::json!({
            "from": from,
            "to": to,
            "schema": 1,
            "starts": starts,
            "programs": self.programs(),
            "attempt": ATTEMPT,
        });
        fs::write(
            self.update_record().join("pending.json"),
            pending.to_string(),
        )
        .unwrap();
    }

    /// What the install names as the release last served on its database.
    fn served(&self) -> Option<String> {
        fs::read_to_string(self.dir.join("data/marfa.db.release")).ok()
    }

    fn name_served(&self, release: &str) {
        fs::write(
            self.dir.join("data/marfa.db.release"),
            format!("{release}\n"),
        )
        .unwrap();
    }

    fn starts(&self) -> Option<u64> {
        let text = fs::read(self.update_record().join("pending.json")).ok()?;
        serde_json::from_slice::<serde_json::Value>(&text).unwrap()["starts"].as_u64()
    }

    /// The outcome and the reason of the last update.
    fn last(&self) -> (String, String) {
        let text = fs::read_to_string(self.update_record().join("last.json")).unwrap();
        let last: serde_json::Value = serde_json::from_str(&text).unwrap();
        (
            last["outcome"].as_str().unwrap().to_string(),
            last["reason"].as_str().unwrap_or_default().to_string(),
        )
    }

    /// One start by the service manager, which ends within `seconds`.
    fn started_once(&self, env: &[(&str, &str)]) -> Option<i32> {
        let _ = fs::remove_file(self.state.join("server-env"));
        let mut child = self.run_server(env);
        ended(&mut child, 30).expect("run did not end").code()
    }

    fn server_started(&self) -> bool {
        self.state.join("server-env").exists()
    }

    fn program(&self, name: &str) -> Vec<u8> {
        fs::read(self.programs().join(name)).unwrap()
    }
}

const NEW: (&str, &str) = ("FAKE_SERVER_VERSION", "0.0.1");

#[test]
fn a_new_release_that_ends_before_it_settles_is_put_back_after_two_starts() {
    let rig = Rig::new("u-twice");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    let new_server = rig.program("marfa-server");
    for (round, exit) in [(1, "1"), (2, "0")] {
        let code = rig.started_once(&[NEW, ("FAKE_SERVER_EXIT", exit)]);
        assert_eq!(code, Some(75), "round {round}: {}", rig.run_said());
        assert!(rig.server_started(), "round {round}");
        assert_eq!(rig.starts(), Some(round), "round {round}");
    }
    let env = fs::read_to_string(rig.state.join("server-env")).unwrap();
    assert!(
        env.lines()
            .any(|line| line == format!("MARFA_INSTALL_DIR={}", rig.real_dir().display())),
        "{env}"
    );
    assert_eq!(rig.program("marfa-server"), new_server, "the witness");

    let code = rig.started_once(&[NEW]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(
        !rig.server_started(),
        "the new release was not run a third time"
    );
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes()
    );
    assert!(!rig.programs().join(".marfa.next").exists());
    assert_eq!(rig.starts(), None);
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "rolled_back");
    assert!(
        reason.contains("0.0.1 ended 2 times") && reason.contains("0.0.0 was put back"),
        "{reason}"
    );

    assert_eq!(rig.started_once(&[]), Some(0), "{}", rig.run_said());
    assert!(
        rig.state.join("old-ran").exists(),
        "the next start runs the old release"
    );
}

#[test]
fn a_new_release_that_refuses_its_database_is_put_back_at_once() {
    let rig = Rig::new("u-refused");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    rig.name_served("0.0.1");
    let code = rig.started_once(&[NEW, ("FAKE_SERVER_EXIT", "78")]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes()
    );
    assert_eq!(rig.served().as_deref(), Some("0.0.0\n"));
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "rolled_back");
    assert!(reason.contains("exit status 78"), "{reason}");
}

#[test]
fn a_stop_of_the_new_release_is_not_counted_as_a_failed_start() {
    let rig = Rig::new("u-stop");
    rig.swapped("0.0.0", "0.0.1", 1, OPENS_SCHEMA_1);
    let mut child = rig.run_server(&[NEW, ("FAKE_SERVER_TRAP", "0")]);
    wait_for(&rig.state.join("ready"));
    assert_eq!(rig.starts(), Some(2), "the witness: the start was counted");
    signal(&child, "TERM");
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(0), "{}", rig.run_said());
    assert_eq!(rig.starts(), Some(1), "the stop was taken off");
    assert_ne!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes(),
        "nothing was put back"
    );
}

#[test]
fn a_second_run_of_the_same_install_counts_no_start() {
    let rig = Rig::new("u-second");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    let mut first = rig.run_server(&[NEW, ("FAKE_SERVER_TRAP", "0")]);
    wait_for(&rig.state.join("ready"));
    assert_eq!(rig.starts(), Some(1));
    let mut second = rig.run_server(&[NEW, ("FAKE_SERVER_EXIT", "1")]);
    let status = ended(&mut second, 20).expect("the second run did not end");
    assert_eq!(status.code(), Some(1), "{}", rig.run_said());
    assert_eq!(rig.starts(), Some(1));
    signal(&first, "TERM");
    ended(&mut first, 20).expect("run did not end");
    assert_eq!(rig.starts(), Some(0));
}

#[test]
fn a_new_release_that_changed_the_database_is_kept_and_the_update_says_it_failed() {
    for (name, can_open, said) in [
        (
            "u-moved",
            r#"echo '{"schema":2,"standing":"current"}'"#,
            "schema from 1 to 2",
        ),
        (
            "u-newer",
            "echo 'the database is newer than this release' >&2; exit 78",
            "the database is newer than this release",
        ),
    ] {
        let rig = Rig::new(name);
        rig.swapped("0.0.0", "0.0.1", 2, can_open);
        let new_server = rig.program("marfa-server");
        let code = rig.started_once(&[NEW]);
        assert_eq!(code, Some(75), "{name}: {}", rig.run_said());
        assert_eq!(rig.program("marfa-server"), new_server, "{name}");
        assert_eq!(
            rig.program("marfa"),
            b"the new marfa",
            "{name}: the swap was finished"
        );
        assert_eq!(rig.starts(), None, "{name}");
        let (outcome, reason) = rig.last();
        assert_eq!(outcome, "failed", "{name}");
        assert!(
            reason.contains("0.0.0 cannot be put back") && reason.contains(said),
            "{name}: {reason}"
        );
    }
}

#[test]
fn an_update_made_by_a_release_that_swapped_both_programs_is_put_back_whole() {
    let rig = Rig::new("u-both");
    rig.swapped("0.0.9", "0.0.0", 2, OPENS_SCHEMA_1);
    fs::remove_file(rig.programs().join(".marfa.next")).unwrap();
    fs::write(
        rig.programs().join(".marfa.previous"),
        "release 0.0.9's marfa",
    )
    .unwrap();
    let code = rig.started_once(&[]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert_eq!(rig.program("marfa"), b"release 0.0.9's marfa");
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes()
    );
    assert_eq!(rig.last().0, "rolled_back");
}

#[test]
fn an_update_left_unfinished_is_ended_by_the_next_start() {
    // The old server is back but the record was not cleared.
    let rig = Rig::new("u-stale");
    rig.swapped("0.0.0", "0.0.1", 1, OPENS_SCHEMA_1);
    assert_eq!(rig.started_once(&[]), Some(0), "{}", rig.run_said());
    assert!(rig.server_started());
    assert_eq!(rig.starts(), None);
    assert!(!rig.programs().join(".marfa.next").exists());
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "rolled_back");
    assert!(reason.contains("did not finish"), "{reason}");

    // Putting back stopped between the two programs.
    let rig = Rig::new("u-between");
    rig.swapped("0.0.1", "0.0.0", 2, OPENS_SCHEMA_1);
    rig.name_served("0.0.0");
    fs::write(
        rig.programs().join(".marfa.previous"),
        "release 0.0.1's marfa",
    )
    .unwrap();
    assert_eq!(rig.started_once(&[NEW]), Some(75), "{}", rig.run_said());
    assert!(!rig.server_started());
    assert_eq!(rig.program("marfa"), b"release 0.0.1's marfa");
    assert_eq!(rig.served().as_deref(), Some("0.0.1\n"));
    assert_eq!(rig.starts(), None);
    assert_eq!(rig.last().0, "rolled_back");

    // Replaced by hand with a third release.
    let rig = Rig::new("u-by-hand");
    rig.swapped("0.0.0", "0.0.1", 1, OPENS_SCHEMA_1);
    let code = rig.started_once(&[("FAKE_SERVER_VERSION", "0.0.2")]);
    assert_eq!(code, Some(3), "the releases still have to agree");
    assert!(rig.run_said().contains("0.0.2"), "{}", rig.run_said());
    assert_eq!(rig.starts(), None);
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "failed");
    assert!(reason.contains("replaced with release 0.0.2"), "{reason}");
}

#[test]
fn run_check_checks_the_install_and_starts_nothing() {
    let rig = Rig::new("u-check");
    rig.native_installed(&["--access", "local"]);
    rig.isolate();
    let check = |env: &[(&str, &str)]| {
        let mut command = rig.command();
        command
            .args(["server", "run", "--check", "--dir"])
            .arg(&rig.dir)
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home())
            .env("PATH", rig.path());
        for (name, value) in env {
            command.env(name, value);
        }
        let output = command.output().unwrap();
        (
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        )
    };
    assert_eq!(check(&[]).0, Some(0));
    let (code, said) = check(&[NEW]);
    assert_eq!(code, Some(3));
    assert!(said.contains("0.0.1"), "{said}");
    rig.keep_pending("0.0.0", "0.0.1", 0);
    assert_eq!(
        check(&[NEW]).0,
        Some(0),
        "an unsettled update's server is accepted"
    );
    assert!(!rig.server_started());
    assert_eq!(rig.starts(), Some(0), "a check counts no start");
}

const ATTEMPT: &str = "01990000-0000-7000-8000-000000000001";

/// A trial limit short enough for a test; release builds read no such knob.
const TRIAL_LIMIT: (&str, &str) = ("MARFA_TEST_TRIAL_LIMIT_MS", "1500");

impl Rig {
    fn server_pid(&self) -> String {
        fs::read_to_string(self.state.join("server-pid"))
            .unwrap()
            .trim()
            .to_string()
    }

    fn keep_last(&self, last: serde_json::Value) {
        fs::create_dir_all(self.update_record()).unwrap();
        fs::write(self.update_record().join("last.json"), last.to_string()).unwrap();
    }
}

#[test]
fn a_new_release_that_never_settles_is_ended_at_the_limit_counted_and_then_put_back() {
    let rig = Rig::new("u-hung");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    for round in 1..=2 {
        let _ = fs::remove_file(rig.state.join("ready"));
        let code = rig.started_once(&[NEW, ("FAKE_SERVER_HANG", "1"), TRIAL_LIMIT]);
        assert_eq!(code, Some(75), "round {round}: {}", rig.run_said());
        assert!(rig.state.join("ready").exists(), "round {round}");
        assert!(
            gone(&rig.server_pid()),
            "round {round}: the server was ended"
        );
        assert_eq!(rig.starts(), Some(round), "round {round}");
        assert!(
            rig.run_said().contains("did not settle within"),
            "round {round}: {}",
            rig.run_said()
        );
    }
    let code = rig.started_once(&[NEW, ("FAKE_SERVER_HANG", "1"), TRIAL_LIMIT]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(!rig.server_started());
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes()
    );
    assert_eq!(rig.last().0, "rolled_back");
}

#[test]
fn a_new_release_that_settles_is_not_ended_by_the_limit() {
    let rig = Rig::new("u-settles");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    let mut child = rig.run_server(&[
        NEW,
        ("FAKE_SERVER_SETTLES", "1"),
        ("FAKE_SERVER_TRAP", "0"),
        TRIAL_LIMIT,
    ]);
    wait_for(&rig.state.join("ready"));
    std::thread::sleep(Duration::from_millis(4000));
    assert!(
        child.try_wait().unwrap().is_none(),
        "a settled release runs past the limit: {}",
        rig.run_said()
    );
    assert!(alive(&rig.server_pid()));
    signal(&child, "TERM");
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(0), "{}", rig.run_said());
}

/// An upgrade limit short enough for a test; release builds read no such knob.
const UPGRADE_LIMIT: (&str, &str) = ("MARFA_TEST_UPGRADE_LIMIT_MS", "3000");

#[test]
fn a_database_upgrade_longer_than_the_limit_is_not_ended_and_the_release_settles() {
    let rig = Rig::new("u-upgrade-long");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    let mut child = rig.run_server(&[
        NEW,
        ("FAKE_SERVER_UPGRADE", "40"),
        ("FAKE_SERVER_SETTLES", "1"),
        ("FAKE_SERVER_TRAP", "0"),
        TRIAL_LIMIT,
        ("MARFA_TEST_UPGRADE_LIMIT_MS", "60000"),
    ]);
    wait_for(&rig.state.join("ready"));
    std::thread::sleep(Duration::from_millis(2000));
    assert!(
        child.try_wait().unwrap().is_none(),
        "an upgrade is not timed by the settle limit: {}",
        rig.run_said()
    );
    assert!(alive(&rig.server_pid()));
    assert_eq!(rig.starts(), None, "it settled");
    signal(&child, "TERM");
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(0), "{}", rig.run_said());
}

#[test]
fn an_upgrade_that_never_ends_and_a_start_that_never_settles_after_one_are_each_ended() {
    let rig = Rig::new("u-upgrade-hung");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    let upgrading = "did not finish upgrading the database within 3 seconds";
    let upgraded = "did not settle within 1500 ms of upgrading the database";
    for (round, tenths, said) in [(1, "600", upgrading), (2, "5", upgraded)] {
        let _ = fs::remove_file(rig.state.join("ready"));
        let code = rig.started_once(&[
            NEW,
            ("FAKE_SERVER_UPGRADE", tenths),
            ("FAKE_SERVER_HANG", "1"),
            TRIAL_LIMIT,
            UPGRADE_LIMIT,
        ]);
        assert_eq!(code, Some(75), "round {round}: {}", rig.run_said());
        assert!(
            rig.run_said().contains(said),
            "round {round}: {}",
            rig.run_said()
        );
        assert!(gone(&rig.server_pid()), "round {round}");
        assert_eq!(rig.starts(), Some(round), "round {round}");
    }
    let code = rig.started_once(&[NEW]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(!rig.server_started());
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes()
    );
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "rolled_back");
    assert!(
        reason.contains("0.0.1 ended 2 times") && reason.contains(upgraded),
        "the reason names the limit: {reason}"
    );
}

#[test]
fn a_mark_left_by_an_earlier_start_does_not_lengthen_the_limit() {
    let rig = Rig::new("u-upgrade-stale");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    fs::write(rig.update_record().join("upgrade.json"), "\"began\"").unwrap();
    let code = rig.started_once(&[
        NEW,
        ("FAKE_SERVER_HANG", "1"),
        TRIAL_LIMIT,
        ("MARFA_TEST_UPGRADE_LIMIT_MS", "60000"),
    ]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(
        rig.run_said()
            .contains("did not settle within 1500 ms of starting"),
        "{}",
        rig.run_said()
    );
    assert_eq!(rig.starts(), Some(1));
}

#[test]
fn a_new_server_that_does_not_say_its_release_is_counted_and_then_put_back() {
    let rig = Rig::new("u-silent");
    rig.swapped("0.0.0", "0.0.1", 0, OPENS_SCHEMA_1);
    for (round, fault) in [
        (1, ("FAKE_VERSION_EXIT", "1")),
        (2, ("FAKE_VERSION_HANG", "1")),
    ] {
        let code = rig.started_once(&[NEW, fault]);
        assert_eq!(code, Some(75), "round {round}: {}", rig.run_said());
        assert!(!rig.server_started(), "round {round}");
        assert_eq!(rig.starts(), Some(round), "round {round}");
    }
    let code = rig.started_once(&[NEW, ("FAKE_VERSION_EXIT", "1")]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes()
    );
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "rolled_back");
    assert!(reason.contains("0.0.0 was put back"), "{reason}");
}

#[test]
fn a_start_waits_for_the_last_server_to_let_go_and_counts_nothing_while_it_holds_on() {
    let rig = Rig::new("u-held");
    rig.swapped("0.0.0", "0.0.1", 1, OPENS_SCHEMA_1);
    let control = rig.dir.join("data/control");
    fs::create_dir_all(&control).unwrap();
    let lock = fs::File::create(control.join("marfa.sock.lock")).unwrap();
    lock.try_lock().unwrap();
    let wait = ("MARFA_TEST_LET_GO_MS", "1000");
    let code = rig.started_once(&[NEW, ("FAKE_SERVER_EXIT", "1"), wait]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(!rig.server_started());
    assert_eq!(
        rig.starts(),
        Some(1),
        "a start that never ran is not counted"
    );
    assert!(rig.run_said().contains("still holds"), "{}", rig.run_said());

    let letting_go = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        drop(lock);
    });
    let wait = ("MARFA_TEST_LET_GO_MS", "10000");
    let code = rig.started_once(&[NEW, ("FAKE_SERVER_EXIT", "1"), wait]);
    letting_go.join().unwrap();
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(
        rig.server_started(),
        "the witness: once it lets go, the start runs"
    );
    assert_eq!(rig.starts(), Some(2));
}

#[test]
fn nothing_is_put_back_while_the_last_server_still_holds_the_database() {
    let rig = Rig::new("u-held-back");
    rig.swapped("0.0.0", "0.0.1", 2, OPENS_SCHEMA_1);
    let new_server = rig.program("marfa-server");
    let old_marfa = rig.program("marfa");
    let lock = fs::File::create(rig.dir.join("data/marfa.db.server-lock")).unwrap();
    lock.try_lock().unwrap();
    let wait = ("MARFA_TEST_LET_GO_MS", "1000");
    let code = rig.started_once(&[NEW, wait]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(rig.run_said().contains("still holds"), "{}", rig.run_said());
    assert_eq!(rig.program("marfa-server"), new_server, "nothing was moved");
    assert_eq!(rig.program("marfa"), old_marfa);
    assert!(rig.programs().join(".marfa.next").exists());
    assert_eq!(rig.starts(), Some(2));
    assert!(!rig.update_record().join("last.json").exists());

    drop(lock);
    let code = rig.started_once(&[NEW, wait]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert_eq!(
        rig.program("marfa-server"),
        old_server(OPENS_SCHEMA_1).as_bytes(),
        "the witness: once it lets go, the old release is put back"
    );
    assert_eq!(rig.last().0, "rolled_back");
}

#[test]
fn a_put_back_that_cannot_rename_ends_the_update_and_runs_the_new_release_again() {
    let rig = Rig::new("u-no-rename");
    rig.swapped("0.0.0", "0.0.1", 2, OPENS_SCHEMA_1);
    let new_server = rig.program("marfa-server");
    let _locked = marfa_acl::testing::locked(rig.programs(), 0o555);
    let code = rig.started_once(&[NEW]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    assert!(rig.program("marfa-server") == new_server);
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "failed");
    assert!(
        reason.contains("0.0.0 could not be put back") && reason.contains("Install release"),
        "{reason}"
    );
    for round in 1..=2 {
        let code = rig.started_once(&[NEW, ("FAKE_SERVER_EXIT", "0")]);
        assert_eq!(code, Some(0), "round {round}: {}", rig.run_said());
        assert!(rig.server_started(), "round {round}: the new release runs");
    }
    assert_eq!(rig.last(), (outcome, reason), "the outcome stays as it was");
}

#[cfg(target_os = "macos")]
#[test]
fn a_put_back_that_cannot_replace_the_server_finishes_the_swap_instead() {
    struct Unchangeable(PathBuf);
    impl Drop for Unchangeable {
        fn drop(&mut self) {
            let _ = Command::new("chflags").arg("nouchg").arg(&self.0).status();
        }
    }
    let rig = Rig::new("u-uchg");
    rig.swapped("0.0.0", "0.0.1", 2, OPENS_SCHEMA_1);
    let new_server = rig.program("marfa-server");
    let held = Unchangeable(rig.programs().join("marfa-server"));
    assert!(
        Command::new("chflags")
            .arg("uchg")
            .arg(&held.0)
            .status()
            .unwrap()
            .success()
    );
    let code = rig.started_once(&[NEW]);
    assert_eq!(code, Some(75), "{}", rig.run_said());
    drop(held);
    assert!(rig.program("marfa-server") == new_server);
    assert!(
        rig.program("marfa") == b"the new marfa",
        "the swap was finished: {}",
        rig.run_said()
    );
    assert_eq!(rig.starts(), None);
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "failed");
    assert!(reason.contains("0.0.0 could not be put back"), "{reason}");
}

#[test]
fn a_second_try_of_a_release_put_back_before_gets_an_outcome_of_its_own() {
    let rig = Rig::new("u-again");
    rig.swapped("0.0.0", "0.0.1", 1, OPENS_SCHEMA_1);
    rig.keep_last(serde_json::json!({
        "outcome": "rolled_back",
        "release": "0.0.1",
        "finished_at": "2030-01-01T00:00:00.000Z",
        "reason": "the first try",
        "attempt": "01990000-0000-7000-8000-000000000000",
    }));
    // The old server is back in place, and the second try's record was never cleared.
    assert_eq!(rig.started_once(&[]), Some(0), "{}", rig.run_said());
    assert_eq!(rig.starts(), None);
    let (outcome, reason) = rig.last();
    assert_eq!(outcome, "rolled_back");
    assert!(reason.contains("did not finish"), "{reason}");
}

/// A service manager may start `marfa server run` under a umask that opens new folders to the
/// account's group, and the server refuses a folder on the way to its data that another account
/// can write to.
#[test]
fn an_install_and_a_run_under_an_open_umask_keep_the_folders_on_the_way_private() {
    let rig = Rig::new("u-umask");
    rig.isolate();
    rig.umask.set(Some(0o002));
    rig.native_installed(&["--access", "local"]);
    let mut child = rig.run_server(&[]);
    let status = ended(&mut child, 20).expect("run did not end");
    assert_eq!(status.code(), Some(0), "{}", rig.run_said());
    let mode = |path: &Path| {
        format!(
            "{:o}",
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        )
    };
    assert_eq!(
        mode(&rig.state.join("server-env")),
        "664",
        "the witness: the server started under the umask"
    );
    let record = rig.update_record();
    let data = rig.dir.join("data");
    let made = [&rig.dir, &data, &record, &record.join("supervisor.lock")].map(|path| mode(path));
    assert_eq!(made, ["700", "700", "700", "600"]);
}

#[test]
fn only_the_run_that_holds_the_lock_tells_the_server_it_may_update_itself() {
    let rig = Rig::new("u-fresh");
    rig.native_installed(&["--access", "local"]);
    assert!(!rig.update_record().exists(), "no update has run here");
    let mut first = rig.run_server(&[("FAKE_SERVER_TRAP", "0")]);
    wait_for(&rig.state.join("ready"));
    let marked = |env: &str| {
        env.lines()
            .any(|line| line.starts_with("MARFA_INSTALL_DIR="))
    };
    let env = fs::read_to_string(rig.state.join("server-env")).unwrap();
    assert!(marked(&env), "the witness: {env}");
    fs::remove_file(rig.state.join("server-env")).unwrap();
    let mut second = rig.run_server(&[("FAKE_SERVER_EXIT", "1")]);
    ended(&mut second, 20).expect("the second run did not end");
    let env = fs::read_to_string(rig.state.join("server-env")).unwrap();
    assert!(!marked(&env), "{env}");
    signal(&first, "TERM");
    ended(&mut first, 20).expect("run did not end");
}
