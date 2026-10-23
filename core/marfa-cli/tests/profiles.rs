//! Profiles as a process: which server and which key a command uses when a
//! profile, the command line and the environment each name one, and that a
//! key never reaches a server it was not named for.

mod isolated;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Output;
use std::sync::{Arc, Mutex};

use isolated::Isolated;

const PROFILE_KEY: &str = "marfa_k1_profile_key_5d1c";
const OUTSIDE_KEY: &str = "marfa_k1_outside_key_9b2e";
const FAILING_STDOUT: &str = "marfa_k1_failing_stdout_3a7f";

/// A server that answers every request alike and keeps the method, the path
/// and the bearer of each.
/// Each request's line and its bearer.
type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;

struct Server {
    url: String,
    seen: Seen,
}

impl Server {
    fn answering(status: &'static str, body: &'static str) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
        let kept = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 16384];
                let read = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]).into_owned();
                let line = head.lines().next().unwrap_or_default().to_string();
                let bearer = head.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().trim_start_matches("Bearer ").to_string())
                });
                kept.lock().unwrap().push((line, bearer));
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\nx-marfa-contract: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    marfa_core::contract::CONTRACT_VERSION,
                    body.len()
                );
            }
        });
        Server { url, seen }
    }

    fn not_found() -> Server {
        Server::answering(
            "404 Not Found",
            r#"{"error":{"code":"not_found","message":"no such item"}}"#,
        )
    }

    fn bearers(&self) -> Vec<Option<String>> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(_, bearer)| bearer.clone())
            .collect()
    }

    fn lines(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(line, _)| line.clone())
            .collect()
    }

    fn reset(&self) {
        self.seen.lock().unwrap().clear();
    }
}

/// A home folder of the test's own, with a profile file where the binary
/// looks for one on this system.
struct Home {
    keychain: Isolated,
    home: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        let keychain = Isolated::new(&format!("profiles-{name}"));
        let home = keychain.directory().join("home");
        std::fs::create_dir_all(&home).unwrap();
        Home { keychain, home }
    }

    fn file(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.home
                .join("Library/Application Support/Marfa/profiles.toml")
        } else {
            self.home.join(".config/marfa/profiles.toml")
        }
    }

    fn write(&self, text: &str) -> PathBuf {
        let file = self.file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let _ = std::fs::remove_file(&file);
        std::fs::write(&file, text).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        file
    }

    /// `demo` sends a key command's key to `profiled`, `kept` uses the
    /// keychain's credential for `kept_at`, and `broken` has a key command
    /// that fails after printing to stdout.
    fn profiles(&self, profiled: &Server, kept_at: &str) {
        self.write(&format!(
            "# Test servers.\n\n[demo]\nurl = \"{}\"\nkey_command = [\"printf\", \"%s\\n\", \"{PROFILE_KEY}\"]\n\n[kept]\nurl = \"{kept_at}\"\n\n[broken]\nurl = \"{}\"\nkey_command = [\"sh\", \"-c\", \"printf {FAILING_STDOUT}; echo the vault is locked >&2; exit 7\"]\n",
            profiled.url, profiled.url
        ));
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Output {
        let mut command = self.keychain.marfa();
        command
            .env_remove("MARFA_PROFILE")
            .env_remove("MARFA_NO_KEYCHAIN")
            .env_remove("XDG_CONFIG_HOME")
            .env("HOME", &self.home)
            .args(args);
        for (name, value) in env {
            command.env(name, value);
        }
        command.output().unwrap()
    }
}

fn envelope(output: &Output) -> serde_json::Value {
    let stderr = String::from_utf8_lossy(&output.stderr);
    serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"))
}

fn refused(output: &Output) -> (i32, String, String) {
    let envelope = envelope(output);
    (
        output.status.code().unwrap(),
        envelope["error"]["code"].as_str().unwrap().to_string(),
        envelope["error"]["message"].as_str().unwrap().to_string(),
    )
}

fn shown(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

const GET: &[&str] = &["--json", "items", "get", "i1"];

fn with(prefix: &[&str], args: &[&str]) -> Vec<String> {
    prefix
        .iter()
        .chain(args)
        .map(|word| word.to_string())
        .collect()
}

fn args(words: &[String]) -> Vec<&str> {
    words.iter().map(String::as_str).collect()
}

#[test]
fn the_server_and_key_come_from_the_profile_the_flags_or_the_environment_in_that_order() {
    let home = Home::new("matrix");
    let profiled = Server::not_found();
    let outside = Server::not_found();
    home.profiles(&profiled, &outside.url);
    let profile = Some(PROFILE_KEY.to_string());
    let outside_key = Some(OUTSIDE_KEY.to_string());
    let everything = [
        ("MARFA_API_URL", outside.url.as_str()),
        ("MARFA_API_KEY", OUTSIDE_KEY),
        ("MARFA_PROFILE", "kept"),
    ];

    // --profile reads none of the three variables.
    let output = home.run(&args(&with(&["--profile", "demo"], GET)), &everything);
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    assert_eq!(profiled.bearers(), vec![profile.clone()]);
    assert!(outside.bearers().is_empty());
    profiled.reset();

    // --url or --key beside --profile is refused before anything is sent.
    for beside in [
        &["--url", outside.url.as_str()][..],
        &["--key", OUTSIDE_KEY][..],
    ] {
        let mut words = with(&["--profile", "demo"], beside);
        words.extend(GET.iter().map(|word| word.to_string()));
        let output = home.run(&args(&words), &[]);
        let (code, error, message) = refused(&output);
        assert_eq!((code, error.as_str()), (2, "usage"), "{message}");
        assert!(message.contains("--profile"), "{message}");
    }

    // --url and --key are today's rules, and MARFA_PROFILE is not read.
    let output = home.run(
        &args(&with(&["--url", &outside.url, "--key", OUTSIDE_KEY], GET)),
        &[("MARFA_PROFILE", "demo")],
    );
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    let output = home.run(
        &args(&with(&["--url", &outside.url], GET)),
        &[("MARFA_PROFILE", "demo"), ("MARFA_API_KEY", OUTSIDE_KEY)],
    );
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    assert_eq!(
        outside.bearers(),
        vec![outside_key.clone(), outside_key.clone()]
    );
    outside.reset();

    // MARFA_PROFILE alone.
    let output = home.run(GET, &[("MARFA_PROFILE", "demo")]);
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    assert_eq!(profiled.bearers(), vec![profile.clone()]);
    profiled.reset();

    // MARFA_PROFILE beside MARFA_API_URL or MARFA_API_KEY is refused, naming both.
    for (name, value) in [
        ("MARFA_API_URL", outside.url.as_str()),
        ("MARFA_API_KEY", OUTSIDE_KEY),
    ] {
        let output = home.run(GET, &[("MARFA_PROFILE", "demo"), (name, value)]);
        let (code, error, message) = refused(&output);
        assert_eq!((code, error.as_str()), (2, "usage"), "{message}");
        assert!(
            message.contains("MARFA_PROFILE") && message.contains(name),
            "{message}"
        );
        assert!(!message.contains(OUTSIDE_KEY), "{message}");
    }

    // An empty MARFA_PROFILE is unset.
    let output = home.run(
        GET,
        &[
            ("MARFA_PROFILE", ""),
            ("MARFA_API_URL", outside.url.as_str()),
            ("MARFA_API_KEY", OUTSIDE_KEY),
        ],
    );
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    assert_eq!(outside.bearers(), vec![outside_key]);
    outside.reset();

    // A key with no server stays refused.
    let output = home.run(GET, &[("MARFA_API_KEY", OUTSIDE_KEY)]);
    assert_eq!(refused(&output).1, "no_server");

    assert!(profiled.bearers().is_empty());
    assert!(outside.bearers().is_empty());
}

#[test]
fn a_profile_whose_key_is_in_the_keychain_never_takes_a_key_from_elsewhere() {
    let home = Home::new("keychain-off");
    let profiled = Server::not_found();
    let kept_at = Server::not_found();
    home.profiles(&profiled, &kept_at.url);
    let output = home.run(
        &args(&with(&["--profile", "kept"], GET)),
        &[("MARFA_NO_KEYCHAIN", "1"), ("MARFA_API_KEY", OUTSIDE_KEY)],
    );
    let (code, error, message) = refused(&output);
    assert_eq!((code, error.as_str()), (5, "no_credential"), "{message}");
    assert!(message.contains("profile kept"), "{message}");
    assert!(message.contains("key_command"), "{message}");
    assert!(kept_at.bearers().is_empty());

    // Witness: the same command without the profile sends the outside key.
    let output = home.run(
        &args(&with(&["--url", &kept_at.url], GET)),
        &[("MARFA_NO_KEYCHAIN", "1"), ("MARFA_API_KEY", OUTSIDE_KEY)],
    );
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    assert_eq!(kept_at.bearers(), vec![Some(OUTSIDE_KEY.to_string())]);
}

#[cfg(target_os = "macos")]
#[test]
fn a_profile_whose_key_is_in_the_keychain_sends_the_credential_kept_for_its_server() {
    let home = Home::new("keychain-on");
    let profiled = Server::not_found();
    let kept_at = Server::not_found();
    home.profiles(&profiled, &kept_at.url);
    home.keychain.put(
        &kept_at.url,
        r#"{"kind":"key","key":"marfa_k1_kept_for_this_server"}"#,
    );
    let output = home.run(
        &args(&with(&["--profile", "kept"], GET)),
        &[("MARFA_API_KEY", OUTSIDE_KEY)],
    );
    assert_eq!(refused(&output).0, 1, "{}", shown(&output));
    assert_eq!(
        kept_at.bearers(),
        vec![Some("marfa_k1_kept_for_this_server".to_string())]
    );
    assert!(profiled.bearers().is_empty());
}

#[test]
fn a_key_command_key_is_never_shown_even_when_the_server_refuses_it() {
    let home = Home::new("leak");
    let refusing = Server::answering(
        "401 Unauthorized",
        r#"{"error":{"code":"unauthorized","message":"the key is not valid"}}"#,
    );
    home.profiles(&refusing, &refusing.url);
    for json in [true, false] {
        let mut words = vec!["--profile", "demo", "items", "get", "i1"];
        if json {
            words.insert(0, "--json");
        }
        let output = home.run(&words, &[("MARFA_NO_KEYCHAIN", "1")]);
        assert_eq!(output.status.code(), Some(5), "{}", shown(&output));
        assert!(!shown(&output).contains(PROFILE_KEY), "{}", shown(&output));
    }
    // Witness: the key was produced and sent.
    assert_eq!(
        refusing.bearers(),
        vec![Some(PROFILE_KEY.to_string()), Some(PROFILE_KEY.to_string())]
    );
}

#[test]
fn a_failing_key_command_is_refused_without_what_it_printed() {
    let home = Home::new("failing");
    let profiled = Server::not_found();
    home.profiles(&profiled, &profiled.url);
    let output = home.run(
        &args(&with(&["--profile", "broken"], GET)),
        &[("MARFA_NO_KEYCHAIN", "1")],
    );
    let (code, error, message) = refused(&output);
    assert_eq!((code, error.as_str()), (5, "key_command"), "{message}");
    assert!(message.contains("profile broken (sh)"), "{message}");
    assert!(
        message.contains("status 7: the vault is locked"),
        "{message}"
    );
    assert!(
        !shown(&output).contains(FAILING_STDOUT),
        "{}",
        shown(&output)
    );
    assert!(profiled.bearers().is_empty());
}

#[test]
fn a_write_names_its_server_and_profile_first_and_a_read_does_not() {
    let home = Home::new("writes");
    let profiled = Server::not_found();
    home.profiles(&profiled, &profiled.url);
    let env = [("MARFA_NO_KEYCHAIN", "1")];
    let line = format!("marfa: writing to {} (profile demo)", profiled.url);
    for read in [
        &["--profile", "demo", "items", "get", "i1"][..],
        &["--profile", "demo", "items", "bulk-get", "i1"][..],
    ] {
        let output = home.run(read, &env);
        assert_eq!(output.status.code(), Some(1), "{}", shown(&output));
        assert!(
            !String::from_utf8_lossy(&output.stderr).contains("writing to"),
            "{}",
            shown(&output)
        );
    }
    let output = home.run(&["--profile", "demo", "items", "delete", "i1"], &env);
    assert_eq!(output.status.code(), Some(1), "{}", shown(&output));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(stderr.lines().next(), Some(line.as_str()), "{stderr}");
    assert_eq!(stderr.matches("writing to").count(), 1, "{stderr}");
    // Every request reached the server, the write included.
    assert_eq!(
        profiled
            .lines()
            .iter()
            .map(|line| line.split(' ').next().unwrap())
            .collect::<Vec<_>>(),
        vec!["GET", "POST", "DELETE"]
    );

    // Without a profile, the line names the server alone.
    let output = home.run(
        &["--url", &profiled.url, "items", "delete", "i1"],
        &[("MARFA_NO_KEYCHAIN", "1"), ("MARFA_API_KEY", OUTSIDE_KEY)],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        stderr.lines().next(),
        Some(format!("marfa: writing to {}", profiled.url).as_str()),
        "{stderr}"
    );
    // Under --json, stderr holds the refusal alone.
    let output = home.run(
        &["--json", "--profile", "demo", "items", "delete", "i1"],
        &env,
    );
    assert_eq!(refused(&output).1, "not_found");
}

#[test]
fn whoami_names_the_profile_and_where_its_key_came_from_and_never_the_key() {
    let home = Home::new("whoami");
    let root = Server::answering("200 OK", r#"{"name":"marfa"}"#);
    home.profiles(&root, &root.url);
    let output = home.run(
        &["--json", "--profile", "demo", "whoami"],
        &[("MARFA_NO_KEYCHAIN", "1")],
    );
    assert!(output.status.success(), "{}", shown(&output));
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["profile"], "demo");
    assert_eq!(report["credential"]["from"], "key_command");
    assert_eq!(report["credential"]["kind"], "key");
    assert!(!shown(&output).contains(PROFILE_KEY));
    let output = home.run(
        &["--profile", "demo", "whoami"],
        &[("MARFA_NO_KEYCHAIN", "1")],
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("(profile demo)"), "{text}");
    assert!(
        text.contains("a key from the profile's key_command"),
        "{text}"
    );
    assert!(!shown(&output).contains(PROFILE_KEY));
}

#[test]
fn a_missing_file_an_unknown_name_or_a_file_others_can_change_is_refused() {
    let home = Home::new("refusals");
    let profiled = Server::not_found();
    let output = home.run(&args(&with(&["--profile", "demo"], GET)), &[]);
    let (code, error, message) = refused(&output);
    assert_eq!((code, error.as_str()), (2, "usage"), "{message}");
    assert!(
        message.contains(&home.file().display().to_string()),
        "{message}"
    );

    home.profiles(&profiled, &profiled.url);
    let output = home.run(&args(&with(&["--profile", "other"], GET)), &[]);
    let (code, _, message) = refused(&output);
    assert_eq!(code, 2, "{message}");
    assert!(message.contains("it has broken, demo, kept"), "{message}");
    assert!(
        !message.contains(PROFILE_KEY) && !message.contains("printf"),
        "{message}"
    );

    std::fs::set_permissions(home.file(), std::fs::Permissions::from_mode(0o664)).unwrap();
    let output = home.run(&args(&with(&["--profile", "demo"], GET)), &[]);
    let (code, _, message) = refused(&output);
    assert_eq!(code, 2, "{message}");
    assert!(message.contains("chmod go-w"), "{message}");
    assert!(!message.contains(PROFILE_KEY), "{message}");
    assert!(profiled.bearers().is_empty());
}

#[test]
fn commands_that_take_no_server_refuse_the_flag_and_ignore_the_variable() {
    let home = Home::new("doors");
    let profiled = Server::not_found();
    home.profiles(&profiled, &profiled.url);
    for words in [
        &["server", "status"][..],
        &["types", "scaffold", "user.recipe"],
        &["docs", "topics"],
        &["folders", "autostart", "status"],
        &["login"],
        &["logout"],
        &["keys", "keep"],
        &["keys", "forget"],
    ] {
        let mut all = vec!["--json", "--profile", "demo"];
        all.extend_from_slice(words);
        let output = home.run(&all, &[]);
        let (code, error, message) = refused(&output);
        assert_eq!((code, error.as_str()), (2, "usage"), "{words:?}: {message}");
    }
    let output = home.run(
        &[
            "--json",
            "--socket",
            "/marfa-test-missing/control.sock",
            "--profile",
            "demo",
            "items",
            "list",
        ],
        &[],
    );
    assert_eq!(output.status.code(), Some(2), "{}", shown(&output));
    let output = home.run(
        &[
            "--json",
            "--socket",
            "/marfa-test-missing/control.sock",
            "items",
            "list",
        ],
        &[("MARFA_PROFILE", "demo")],
    );
    let (code, _, message) = refused(&output);
    assert_eq!(code, 2, "{message}");
    assert!(message.contains("MARFA_PROFILE"), "{message}");

    // A command that needs no server runs with a profile named that does not exist.
    let output = home.run(&["--json", "operations"], &[("MARFA_PROFILE", "missing")]);
    assert!(output.status.success(), "{}", shown(&output));
    assert!(profiled.bearers().is_empty());
}

#[test]
fn login_signs_in_to_the_profiles_server() {
    let home = Home::new("login");
    let refusing = Server::answering(
        "404 Not Found",
        r#"{"error":{"code":"not_found","message":"no such door"}}"#,
    );
    home.write(&format!("[kept]\nurl = \"{}\"\n", refusing.url));
    let output = home.run(
        &[
            "--json",
            "--profile",
            "kept",
            "login",
            "--print-token",
            "--no-browser",
        ],
        &[("MARFA_API_URL", "http://127.0.0.1:9")],
    );
    assert!(!output.status.success(), "{}", shown(&output));
    // The sign-in asked the profile's server, not the one the variable names.
    assert!(!refusing.lines().is_empty(), "{}", shown(&output));
}

#[test]
fn ctrl_c_while_a_key_command_runs_stops_it_with_marfa() {
    use std::os::unix::process::ExitStatusExt;

    let home = Home::new("interrupt");
    let server = Server::not_found();
    let started = home.home.join("key-command.pid");
    home.write(&format!(
        "[slow]\nurl = \"{}\"\nkey_command = [\"sh\", \"-c\", \"echo $$ > '{}'; exec sleep 30\"]\n",
        server.url,
        started.display()
    ));
    let mut marfa = home
        .keychain
        .marfa()
        .env_remove("MARFA_PROFILE")
        .env_remove("MARFA_NO_KEYCHAIN")
        .env_remove("XDG_CONFIG_HOME")
        .env("HOME", &home.home)
        .args(["--profile", "slow", "items", "get", "i1"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let waited = std::time::Instant::now();
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(&started)
            .ok()
            .and_then(|text| text.trim().parse::<libc::pid_t>().ok())
        {
            break pid;
        }
        assert!(
            waited.elapsed() < std::time::Duration::from_secs(10),
            "the key command never started"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    // SAFETY: probing and signaling processes this test started.
    let alive = |pid: libc::pid_t| unsafe { libc::kill(pid, 0) } == 0;
    assert!(
        alive(pid),
        "the key command is running before the interrupt"
    );

    unsafe { libc::kill(marfa.id() as libc::pid_t, libc::SIGINT) };
    let status = marfa.wait().unwrap();
    assert_eq!(status.signal(), Some(libc::SIGINT), "{status:?}");
    let ended = std::time::Instant::now();
    while alive(pid) && ended.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let left = alive(pid);
    if left {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    assert!(!left, "the key command outlived marfa");
    assert!(server.lines().is_empty(), "{:?}", server.lines());
}
