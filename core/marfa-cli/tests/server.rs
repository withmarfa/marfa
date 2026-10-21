//! `marfa server`, run as a process against a stand-in for Docker, so the
//! files it writes, the questions it does not ask, and what it refuses are
//! held without an engine. The stand-in keeps its state in files; a thread
//! plays the server's health endpoint once the stand-in has "started" it.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
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
      pull) touch "$S/image" ;;
      up) touch "$S/c-$name" "$S/vol-$name-data" ;;
      down) rm -f "$S/c-$name" ;;
    esac
    exit 0 ;;
  info) echo 27.0.0 ;;
  network)
    case "$2" in
      ls) n=$(named "$@"); [ -e "$S/net-$n" ] && echo "$n"; exit 0 ;;
      create) touch "$S/net-$3"; echo id ;;
      inspect) echo '[{"Subnet":"172.30.0.0/24","Gateway":"172.30.0.1"}]' ;;
      rm) rm -f "$S/net-$3" ;;
    esac ;;
  volume)
    case "$2" in
      ls) n=$(named "$@"); [ -e "$S/vol-$n" ] && echo "$n"; exit 0 ;;
      rm) rm -f "$S/vol-$3" ;;
    esac ;;
  container) n=$(named "$@"); [ -e "$S/c-$n" ] && echo "$n"; exit 0 ;;
  image) [ -e "$S/image" ] ;;
  inspect) echo '{"Status":"running"}' ;;
  exec)
    case "$*" in
      *"setup status"*) if [ -e "$S/claimed" ]; then echo '{"claimed":true}'; else echo '{"claimed":false}'; fi ;;
      *"setup open"*) echo '{"url":"http://localhost/setup#handoff=TICKET123","expires_at":"2030-01-01T00:00:00Z"}' ;;
    esac ;;
  logs) echo "a line of the server's log" ;;
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

/// A port below the range the system gives to outgoing connections, which
/// other tests' health checks would otherwise be holding.
fn free_port() -> u16 {
    static NEXT: AtomicU16 = AtomicU16::new(0);
    loop {
        let offset = NEXT.fetch_add(1, Ordering::Relaxed);
        let port = 20_000 + ((std::process::id() % 400) as u16) * 20 + offset % 20_000;
        let _held = SOCKETS.lock().unwrap();
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

const FAKE_LAUNCHCTL: &str = r#"#!/bin/sh
# A launchd that remembers what was loaded.
H="$MARFA_AUTOSTART_ROOT"
echo "$*" >> "$H/launchctl.log"
label=$(printf '%s' "$*" | sed -n 's/.*so\.marfa\.server\.\([a-z0-9_-]*\).*/\1/p')
case "$1" in
  print) [ -e "$H/loaded-$label" ] ;;
  bootstrap) label=$(basename "$3" .plist | sed 's/^so\.marfa\.server\.//'); touch "$H/loaded-$label" ;;
  bootout) rm -f "$H/loaded-$label" ;;
esac
"#;

struct Rig {
    root: PathBuf,
    dir: PathBuf,
    state: PathBuf,
    port: u16,
    stop: Arc<AtomicBool>,
    health: Option<JoinHandle<()>>,
}

impl Rig {
    fn new(name: &str) -> Rig {
        let root = std::env::temp_dir().join(format!("marfa-server-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let script = root.join("docker");
        fs::write(&script, FAKE_DOCKER).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let home = root.join("home");
        fs::create_dir_all(home.join("bin")).unwrap();
        let launchctl = home.join("bin/launchctl");
        fs::write(&launchctl, FAKE_LAUNCHCTL).unwrap();
        fs::set_permissions(&launchctl, fs::Permissions::from_mode(0o755)).unwrap();
        let port = free_port();
        let stop = Arc::new(AtomicBool::new(false));
        let health = {
            let (stop, state) = (stop.clone(), state.clone());
            std::thread::spawn(move || serve_health(port, &state, &stop))
        };
        Rig {
            dir: root.join("install"),
            root,
            state,
            port,
            stop,
            health: Some(health),
        }
    }

    fn marfa(&self, args: &[&str]) -> (i32, String, String) {
        let output = output_of(
            Command::new(env!("CARGO_BIN_EXE_marfa"))
                .arg("server")
                .args(args)
                .arg("--dir")
                .arg(&self.dir)
                .env("MARFA_DOCKER", self.root.join("docker"))
                .env("FAKE_DOCKER_STATE", &self.state)
                .env("MARFA_TAILSCALE", self.root.join("no-tailscale"))
                .env("MARFA_AUTOSTART_ROOT", self.root.join("home"))
                .env_remove("S3_SECRET_ACCESS_KEY"),
        );
        (
            output.status.code().unwrap(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    fn install(&self, extra: &[&str]) -> (i32, String, String) {
        let port = self.port.to_string();
        let mut args = vec![
            "install",
            "--release",
            "0.0.22",
            "--port",
            &port,
            "--yes",
            "--wait",
            "5",
        ];
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
        if let Some(health) = self.health.take() {
            let _ = health.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Answers `200` on the port once the stand-in has started a container.
fn serve_health(port: u16, state: &Path, stop: &AtomicBool) {
    let listener = loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let started = fs::read_dir(state)
            .map(|entries| {
                entries
                    .flatten()
                    .any(|e| e.file_name().to_string_lossy().starts_with("c-"))
            })
            .unwrap_or(false);
        if started && let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            break listener;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    listener.set_nonblocking(true).unwrap();
    while !stop.load(Ordering::Relaxed) {
        let accepted = {
            let _held = SOCKETS.lock().unwrap();
            listener.accept()
        };
        match accepted {
            Ok((mut stream, _)) => {
                let mut buffer = [0u8; 512];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                );
            }
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn secrets(rig: &Rig) -> [String; 2] {
    [
        rig.setting("API_KEY_SALT").unwrap(),
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
        "MARFA_RELEASE=0.0.22",
        "MARFA_ACCESS=local",
    ] {
        assert!(dotenv.lines().any(|l| l == line), "{line}\n{dotenv}");
    }
    assert_eq!(rig.setting("TRUSTED_PROXY_CIDRS"), None);
    assert_eq!(rig.setting("TRUSTED_PROXY_HEADER"), None);
    let log = rig.log();
    assert!(log.contains("network create marfa-net"), "{log}");
    assert!(log.lines().any(|l| l.contains(" up -d")), "{log}");
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
    let rig = Rig::new("proxy");
    let (code, _, stderr) = rig.install(&[
        "--access",
        "proxy",
        "--address",
        "https://marfa.example.com/",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        rig.setting("TRUSTED_PROXY_CIDRS").as_deref(),
        Some("172.30.0.0/24")
    );
    assert_eq!(rig.setting("TRUSTED_PROXY_HEADER"), None);
    assert_eq!(
        rig.setting("MARFA_AUTH_BASE_URL").as_deref(),
        Some("https://marfa.example.com")
    );

    let salt = secrets(&rig);
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--address",
        "https://marfa.example.com",
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.setting("TRUSTED_PROXY_CIDRS"), None);
    assert_eq!(
        rig.setting("TRUSTED_PROXY_HEADER").as_deref(),
        Some("CF-Connecting-IP")
    );
    assert_eq!(
        secrets(&rig),
        salt,
        "changing how it is reached remade a secret"
    );

    let (code, _, stderr) = rig.install(&["--access", "local"]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(rig.setting("TRUSTED_PROXY_HEADER"), None);
    assert_eq!(
        rig.setting("MARFA_AUTH_BASE_URL"),
        Some(format!("http://localhost:{}", rig.port))
    );
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
    let (code, _, stderr) = rig.install(&["--access", "tailscale"]);
    assert_eq!(code, 3, "{stderr}");
    assert!(stderr.contains("Tailscale"), "{stderr}");
    assert!(!rig.dir.join("marfa.env").exists());
}

#[test]
fn a_bucket_is_written_and_its_secret_key_comes_from_the_environment() {
    let rig = Rig::new("bucket");
    let port = rig.port.to_string();
    let output = output_of(
        Command::new(env!("CARGO_BIN_EXE_marfa"))
            .args([
                "server",
                "install",
                "--release",
                "0.0.22",
                "--access",
                "local",
                "--yes",
                "--wait",
                "5",
            ])
            .args([
                "--port",
                &port,
                "--s3-bucket",
                "my-bucket",
                "--s3-access-key-id",
                "AKIAEXAMPLE",
            ])
            .arg("--dir")
            .arg(&rig.dir)
            .env("MARFA_DOCKER", rig.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home())
            .env("S3_SECRET_ACCESS_KEY", "s3/secret+value"),
    );
    let said = String::from_utf8_lossy(&output.stdout).to_string()
        + &String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{said}");
    assert!(!said.contains("s3/secret+value"));
    assert_eq!(rig.setting("S3_BUCKET").as_deref(), Some("my-bucket"));
    assert_eq!(rig.setting("S3_PREFIX").as_deref(), Some("marfa"));
    assert_eq!(
        rig.setting("S3_SECRET_ACCESS_KEY").as_deref(),
        Some("s3/secret+value")
    );

    // Without the key, nothing can ask for it, so the command says what to set.
    let other = Rig::new("bucket-no-key");
    let (code, _, stderr) = other.install(&[
        "--access",
        "local",
        "--s3-bucket",
        "b",
        "--s3-access-key-id",
        "id",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("S3_SECRET_ACCESS_KEY"), "{stderr}");
    assert!(!other.dir.join("marfa.env").exists());
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
        let mut args = vec!["install", "--access", "local", "--yes", "--port", &port];
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
        "--release",
        "0.0.22",
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
        Command::new(env!("CARGO_BIN_EXE_marfa"))
            .args([
                "server",
                "install",
                "--release",
                "0.0.22",
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
fn an_upgrade_moves_forward_and_never_back() {
    let rig = Rig::new("upgrade");
    rig.installed(&["--access", "local"]);
    let (code, _, stderr) = rig.marfa(&["upgrade", "--release", "0.0.21", "--wait", "5"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("older"), "{stderr}");
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.22"));

    let salt = secrets(&rig);
    let (code, stdout, stderr) = rig.marfa(&["upgrade", "--release", "0.0.23", "--wait", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("0.0.22 to 0.0.23"), "{stdout}");
    assert!(rig.file(".env").contains("MARFA_RELEASE=0.0.23"));
    assert_eq!(secrets(&rig), salt);

    let (code, stdout, _) = rig.marfa(&["upgrade", "--release", "0.0.23", "--wait", "5"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Already on 0.0.23"), "{stdout}");
}

#[test]
fn status_reports_in_json() {
    let rig = Rig::new("status");
    rig.installed(&["--access", "local"]);
    let (code, stdout, stderr) = rig.marfa(&["status"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("running and healthy"), "{stdout}");
    let output = output_of(
        Command::new(env!("CARGO_BIN_EXE_marfa"))
            .args(["--json", "server", "status", "--dir"])
            .arg(&rig.dir)
            .env("MARFA_DOCKER", rig.root.join("docker"))
            .env("FAKE_DOCKER_STATE", &rig.state)
            .env("MARFA_AUTOSTART_ROOT", rig.home()),
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["release"], "0.0.22");
    assert_eq!(report["healthy"], true);
    assert_eq!(report["claimed"], false);
    assert!(!String::from_utf8_lossy(&output.stdout).contains(&secrets(&rig)[0]));
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

#[test]
fn start_brings_the_server_up_without_changing_anything() {
    let rig = Rig::new("start");
    rig.installed(&["--access", "local"]);
    let before = (rig.file("marfa.env"), rig.file(".env"));
    fs::remove_file(rig.state.join("c-marfa")).unwrap();
    let (code, stdout, stderr) = rig.marfa(&["start", "--wait", "5"]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stdout.contains("is running"), "{stdout}");
    assert!(rig.state.join("c-marfa").exists());
    assert_eq!(before, (rig.file("marfa.env"), rig.file(".env")));
    let (code, _, stderr) = rig.marfa(&["uninstall", "--delete-data", "--yes"]);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = rig.marfa(&["start", "--wait", "5"]);
    assert_eq!(code, 2, "{stderr}");
}

fn managed_elsewhere(rig: &Rig, body: &str) {
    fs::create_dir_all(&rig.dir).unwrap();
    fs::write(rig.dir.join("marfa.env"), body).unwrap();
}

const CLOUDFLARE_FILE: &str =
    "API_KEY_SALT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MARFA_AUTH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
MARFA_AUTH_BASE_URL=https://marfa.example.com
TRUSTED_PROXY_HEADER=CF-Connecting-IP
OTEL_RESOURCE_ATTRIBUTES=service.instance.id=mine
";

#[test]
fn a_settings_file_managed_elsewhere_is_used_as_it_is() {
    let rig = Rig::new("external");
    managed_elsewhere(&rig, CLOUDFLARE_FILE);
    let (code, stdout, stderr) = rig.install(&["--access", "cloudflare", "--external-settings"]);
    assert_eq!(code, 0, "{stderr}");
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
    let rendered = CLOUDFLARE_FILE.replace("mine", "other");
    fs::write(rig.dir.join("marfa.env"), &rendered).unwrap();
    rig.installed(&[]);
    assert_eq!(rig.file("marfa.env"), rendered);
    let (_, stdout, _) = rig.marfa(&["--json", "status"]);
    assert!(stdout.contains("\"settings\": \"external\""), "{stdout}");
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

    managed_elsewhere(
        &rig,
        "API_KEY_SALT=sssssssssssssssssssssssssssssssss\nMARFA_AUTH_BASE_URL=http://marfa.example.com\n",
    );
    let (code, _, stderr) = rig.install(&["--access", "cloudflare", "--external-settings"]);
    assert_eq!(code, 2, "{stderr}");
    for said in [
        "MARFA_AUTH_SECRET is not set",
        "must be an https address",
        "TRUSTED_PROXY_HEADER must be CF-Connecting-IP",
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

    managed_elsewhere(&rig, CLOUDFLARE_FILE);
    let (code, _, stderr) = rig.install(&[
        "--access",
        "cloudflare",
        "--external-settings",
        "--address",
        "https://elsewhere.example.com",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("change one"), "{stderr}");
}

#[test]
fn a_proxy_range_in_a_settings_file_must_cover_the_dockers_network() {
    let rig = Rig::new("external-range");
    let base = CLOUDFLARE_FILE.replace("TRUSTED_PROXY_HEADER=CF-Connecting-IP\n", "");
    managed_elsewhere(&rig, &format!("{base}TRUSTED_PROXY_CIDRS=10.0.0.0/8\n"));
    let (code, _, stderr) = rig.install(&["--access", "proxy", "--external-settings"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("172.30.0.0/24"), "{stderr}");
    managed_elsewhere(
        &rig,
        &format!("{base}TRUSTED_PROXY_CIDRS=10.0.0.0/8,172.30.0.0/16\n"),
    );
    let (code, _, stderr) = rig.install(&["--access", "proxy", "--external-settings"]);
    assert_eq!(code, 0, "{stderr}");
}
