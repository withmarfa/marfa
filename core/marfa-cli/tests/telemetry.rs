//! The `marfa` binary as a process, reporting to a collector and to a stub
//! PostHog that this file runs. No keychain is read: every command is given
//! both a server and a key, or needs neither.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Planted in every place a person's data could come from. None may reach a
/// collector.
const SECRET: &str = "s3cr3t-planted-value";

/// The project token of the stub PostHog. It belongs in the one field PostHog
/// reads it from, and nowhere else.
const TOKEN: &str = "phc_stub_project_token";

#[derive(Clone, Copy)]
enum Reply {
    Answer(u16),
    /// Takes the connection and the request and says nothing.
    Silence,
    Redirect,
    /// A Marfa server that fails: a 500 on its own contract, saying this.
    Fault(&'static str),
    /// A Marfa server refusing as it should: this status on its own contract.
    Refusal(u16),
}

/// What a Marfa server answers with `status`: its contract and an error.
fn marfa_answer(status: u16, code: &str, message: &str) -> String {
    let body = format!("{{\"error\":{{\"code\":\"{code}\",\"message\":\"{message}\"}}}}");
    format!(
        "HTTP/1.1 {status} X\r\nX-Marfa-Contract: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        marfa_core::contract::CONTRACT_VERSION,
        body.len()
    )
}

struct Collector {
    url: String,
    posts: Arc<Mutex<Vec<door::Received>>>,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl Collector {
    fn open(reply: Reply) -> Collector {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let posts = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (kept, counted, stopped) = (
            Arc::clone(&posts),
            Arc::clone(&connections),
            Arc::clone(&stop),
        );
        let redirect = url.clone();
        std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                counted.fetch_add(1, Ordering::SeqCst);
                let (kept, stopped, redirect) =
                    (Arc::clone(&kept), Arc::clone(&stopped), redirect.clone());
                std::thread::spawn(move || {
                    stream.set_nonblocking(false).unwrap();
                    let request = door::read_request(&mut stream);
                    kept.lock().unwrap().push(request);
                    let answer = match reply {
                        Reply::Answer(status) => {
                            format!(
                                "HTTP/1.1 {status} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                            )
                        }
                        Reply::Fault(message) => marfa_answer(500, "internal", message),
                        Reply::Refusal(status) => marfa_answer(status, "refused", "no"),
                        Reply::Redirect => format!(
                            "HTTP/1.1 307 X\r\nLocation: {redirect}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        ),
                        Reply::Silence => {
                            while !stopped.load(Ordering::SeqCst) {
                                std::thread::sleep(Duration::from_millis(20));
                            }
                            return;
                        }
                    };
                    let _ = stream.write_all(answer.as_bytes());
                });
            }
        });
        Collector {
            url,
            posts,
            connections,
            stop,
        }
    }

    fn received(&self) -> Vec<door::Received> {
        self.posts.lock().unwrap().clone()
    }

    fn spans(&self) -> Vec<Value> {
        self.received()
            .iter()
            .filter(|post| post.path().split('?').next() == Some("/v1/traces"))
            .flat_map(|post| {
                let body: Value = serde_json::from_str(&post.body).unwrap();
                body["resourceSpans"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|resource| resource["scopeSpans"].as_array().unwrap().clone())
                    .flat_map(|scope| scope["spans"].as_array().unwrap().clone())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// The `$exception` events posted to the capture path.
    fn events(&self) -> Vec<Value> {
        self.received()
            .iter()
            .filter(|post| post.path() == "/i/v0/e/")
            .map(|post| serde_json::from_str(&post.body).unwrap())
            .collect()
    }

    fn root(&self) -> Value {
        let roots: Vec<_> = self
            .spans()
            .into_iter()
            .filter(|span| span.get("parentSpanId").is_none())
            .collect();
        assert_eq!(roots.len(), 1, "{roots:?}");
        roots[0].clone()
    }
}

impl Drop for Collector {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
    took: Duration,
}

/// A path in an empty folder of its own, which goes when this does.
struct Scratch {
    path: PathBuf,
    _dir: tempfile::TempDir,
}

impl std::ops::Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

fn scratch(name: &str, file: &str) -> Scratch {
    let dir = tempfile::Builder::new()
        .prefix(&format!("marfa-telemetry-{name}-"))
        .tempdir()
        .unwrap();
    Scratch {
        path: dir.path().join(file),
        _dir: dir,
    }
}

fn closed_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

/// A Marfa server that answers every request with a 500, for the whole run.
fn faulty() -> &'static str {
    static SERVER: std::sync::OnceLock<Collector> = std::sync::OnceLock::new();
    &SERVER
        .get_or_init(|| Collector::open(Reply::Fault("it failed")))
        .url
}

/// The command a fault ends: it asks the server, and the server fails.
const FAULT: [&str; 4] = ["--json", "items", "get", "an-id"];

/// A command with a server that fails and a key that is no one's, so that
/// nothing reads a keychain.
fn command(env: &[(&str, &str)], args: &[&str]) -> Command {
    let mut command = quiet::marfa();
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env(
            "MARFA_KEYCHAIN",
            std::env::temp_dir().join(format!(
                "marfa-telemetry-no-keychain-{}",
                std::process::id()
            )),
        )
        .env("MARFA_API_URL", faulty())
        .env("MARFA_API_KEY", "marfa_k1_not_a_key")
        .args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    command
}

fn run(env: &[(&str, &str)], args: &[&str]) -> Ran {
    let started = Instant::now();
    let output = command(env, args).output().unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        took: started.elapsed(),
    }
}

/// A working copy that exists and was never hydrated.
fn store() -> Scratch {
    let path = scratch("store", "copy.sqlite");
    let made = run(&[], &["device", "--db", path.to_str().unwrap(), "status"]);
    assert_eq!(made.code, 0, "{}", made.stderr);
    path
}

fn attribute<'a>(of: &'a Value, key: &str) -> Option<&'a Value> {
    of["attributes"]
        .as_array()?
        .iter()
        .find(|attribute| attribute["key"] == key)
        .map(|attribute| &attribute["value"])
}

fn word<'a>(of: &'a Value, key: &str) -> &'a str {
    attribute(of, key).unwrap()["stringValue"].as_str().unwrap()
}

fn number(of: &Value, key: &str) -> i64 {
    attribute(of, key).unwrap()["intValue"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

fn report_to<'a>(
    collector: &'a Collector,
    extra: &[(&'a str, &'a str)],
) -> Vec<(&'a str, &'a str)> {
    let mut env = vec![("OTEL_EXPORTER_OTLP_ENDPOINT", collector.url.as_str())];
    env.extend_from_slice(extra);
    env
}

#[test]
fn a_failing_command_exports_one_trace_with_its_codes_and_the_core_span_beneath_the_root() {
    let collector = Collector::open(Reply::Answer(200));
    let store = store();
    let ran = run(
        &report_to(&collector, &[]),
        &[
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "catch-up",
        ],
    );
    assert_eq!(ran.code, 4, "{}", ran.stderr);
    assert!(ran.stderr.contains("\"no_cursor\""), "{}", ran.stderr);

    let posts = collector.received();
    assert_eq!(posts.len(), 1, "one run is one post");
    assert_eq!(posts[0].method(), "POST");
    assert_eq!(posts[0].header("content-type"), Some("application/json"));
    let spans = collector.spans();
    let root = collector.root();
    assert_eq!(root["name"], "marfa device catch-up");
    assert_eq!(root["status"]["code"], 2);
    assert_eq!(number(&root, "exit_code"), 4);
    let failed = &root["events"][0];
    assert_eq!(failed["name"], "error");
    assert_eq!(word(failed, "code"), "no_cursor");
    assert_eq!(number(failed, "exit_code"), 4);

    let catch_up = spans
        .iter()
        .find(|span| span["name"] == "catch_up")
        .unwrap();
    assert_eq!(catch_up["parentSpanId"], root["spanId"]);
    assert_eq!(word(catch_up, "outcome"), "error");
    assert_eq!(word(&catch_up["events"][0], "code"), "no_cursor");
    let traces: std::collections::HashSet<_> = spans.iter().map(|span| &span["traceId"]).collect();
    assert_eq!(traces.len(), 1);
    assert_eq!(root["traceId"].as_str().unwrap().len(), 32);
    assert_eq!(root["spanId"].as_str().unwrap().len(), 16);
}

#[test]
fn a_command_that_succeeds_exports_its_counts_and_no_error() {
    let collector = Collector::open(Reply::Answer(200));
    let store = store();
    let ran = run(
        &report_to(&collector, &[]),
        &[
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "search",
            "anything",
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let root = collector.root();
    assert_eq!(root["name"], "marfa device search");
    assert_eq!(number(&root, "exit_code"), 0);
    assert!(root.get("status").is_none());
    assert!(root["events"].as_array().unwrap().is_empty());
    let search = collector
        .spans()
        .into_iter()
        .find(|span| span["name"] == "search")
        .unwrap();
    assert_eq!(search["parentSpanId"], root["spanId"]);
    assert_eq!(word(&search, "outcome"), "ok");
    assert_eq!(number(&search, "hits"), 0);
}

#[test]
fn a_command_that_fails_before_any_core_call_and_one_the_network_fails_both_export_their_codes() {
    let collector = Collector::open(Reply::Answer(200));
    let env = report_to(&collector, &[]);

    let refused = run(&env, &["--socket", "/nowhere/control.sock", "login"]);
    assert_eq!(refused.code, 2, "{}", refused.stderr);
    let root = collector.root();
    assert_eq!(root["name"], "marfa login");
    assert_eq!(word(&root["events"][0], "code"), "usage");
    assert_eq!(number(&root["events"][0], "exit_code"), 2);

    let before = collector.spans().len();
    let closed = closed_port();
    let mut offline = env.clone();
    offline.push(("MARFA_API_URL", closed.as_str()));
    let down = run(&offline, &["--json", "items", "get", "an-id"]);
    assert_eq!(down.code, 3, "{}", down.stderr);
    let spans = collector.spans();
    let root = spans[before..]
        .iter()
        .find(|span| span.get("parentSpanId").is_none())
        .unwrap();
    assert_eq!(root["name"], "marfa items get");
    assert_eq!(word(&root["events"][0], "code"), "network");
    assert_eq!(number(root, "exit_code"), 3);
    assert_eq!(
        spans.len() - before,
        1,
        "no core span below a request the binary sends itself"
    );
}

#[test]
fn output_that_goes_nowhere_ends_the_run_cleanly_and_is_exported_as_done() {
    let collector = Collector::open(Reply::Answer(200));
    let mut fds = [0; 2];
    // SAFETY: `fds` holds two descriptors; the read end is closed at once, so
    // the first write to the other fails with a broken pipe.
    let write = unsafe {
        assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
        libc::close(fds[0]);
        <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[1])
    };
    let status = command(&report_to(&collector, &[]), &["operations"])
        .stdout(Stdio::from(write))
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(status.status.code(), Some(0));
    assert_eq!(status.stderr, b"");
    let root = collector.root();
    assert_eq!(root["name"], "marfa operations");
    assert_eq!(number(&root, "exit_code"), 0);
    assert!(root.get("status").is_none());
    assert!(root["events"].as_array().unwrap().is_empty());
}

#[test]
fn nothing_planted_in_the_command_line_the_environment_or_the_data_reaches_the_collector() {
    let collector = Collector::open(Reply::Answer(200));
    let store = store();
    let address = format!("http://user:{SECRET}@127.0.0.1:9/path?token={SECRET}");
    let key = format!("marfa_k1_{SECRET}");
    let held = format!("item-{SECRET}");
    let env = report_to(
        &collector,
        &[
            ("MARFA_API_KEY", key.as_str()),
            (
                "OTEL_EXPORTER_OTLP_HEADERS",
                "x-token=header-value-not-secret",
            ),
        ],
    );

    // Untidy input: the secret in the address, the key, the store's path and
    // an id, on a command the copy refuses by naming the id.
    let refused = run(
        &env,
        &[
            "--json",
            "--url",
            &address,
            "--key",
            &key,
            "device",
            "--db",
            store.to_str().unwrap(),
            "items",
            "get",
            &held,
        ],
    );
    assert_eq!(refused.code, 1, "{}", refused.stderr);
    // The witness: the secret is in what the command itself says, so an
    // exported message would have carried it.
    assert!(refused.stderr.contains(SECRET), "{}", refused.stderr);

    // Content in a search, a request that goes out and fails, and a write.
    let search = run(
        &env,
        &[
            "--json",
            "--url",
            &address,
            "--key",
            &key,
            "device",
            "--db",
            store.to_str().unwrap(),
            "search",
            &format!("content {SECRET}"),
        ],
    );
    assert_eq!(search.code, 0, "{}", search.stderr);
    let create = run(
        &env,
        &[
            "--json",
            "--url",
            &address,
            "--key",
            &key,
            "items",
            "create",
            "--type",
            "core.note",
            "--prop",
            &format!("title={SECRET}"),
            "--properties",
            &format!("{{\"body\":\"{SECRET}\"}}"),
            "--tag",
            SECRET,
        ],
    );
    assert_eq!(create.code, 3, "{}", create.stderr);

    let posts = collector.received();
    assert_eq!(posts.len(), 3, "each run reported");
    let names: Vec<String> = collector
        .spans()
        .iter()
        .filter(|span| span.get("parentSpanId").is_none())
        .map(|span| span["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        names,
        [
            "marfa device items get",
            "marfa device search",
            "marfa items create"
        ]
    );
    for post in &posts {
        for planted in [
            SECRET,
            "user:",
            "127.0.0.1:9",
            store.to_str().unwrap(),
            "/path?",
        ] {
            assert!(
                !post.body.contains(planted),
                "{planted} reached the collector: {}",
                post.body
            );
        }
    }
    // The headers the person set go to the collector and nowhere else.
    assert!(
        posts
            .iter()
            .all(|post| post.header("x-token") == Some("header-value-not-secret"))
    );
}

#[test]
fn an_unreachable_collector_changes_neither_the_exit_code_nor_the_output() {
    let store = store();
    let args = [
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "catch-up",
    ];
    let without = run(&[], &args);
    assert_eq!(without.code, 4);
    for dead in [closed_port(), "http://127.0.0.1:9".to_string()] {
        let with = run(&[("OTEL_EXPORTER_OTLP_ENDPOINT", dead.as_str())], &args);
        assert_eq!(with.code, without.code);
        assert_eq!(with.stdout, without.stdout);
        assert_eq!(with.stderr, without.stderr);
        assert!(with.took < Duration::from_secs(3), "{:?}", with.took);
    }
}

#[test]
fn a_collector_that_never_answers_holds_the_exit_to_the_timeout_and_no_longer() {
    let silent = Collector::open(Reply::Silence);
    let store = store();
    let args = [
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "catch-up",
    ];
    let without = run(&[], &args);
    let report = |extra: &[(&str, &str)]| {
        let mut env = vec![("OTEL_EXPORTER_OTLP_ENDPOINT", silent.url.as_str())];
        env.extend_from_slice(extra);
        run(&env, &args)
    };

    let short = report(&[("OTEL_EXPORTER_OTLP_TIMEOUT", "1500")]);
    assert_eq!(
        (short.code, &short.stdout, &short.stderr),
        (without.code, &without.stdout, &without.stderr)
    );
    // The witness that it waited: the run reached the collector, and took the timeout.
    assert_eq!(silent.received().len(), 1);
    assert!(
        short.took >= Duration::from_millis(1450),
        "{:?}",
        short.took
    );
    assert!(short.took < Duration::from_secs(10), "{:?}", short.took);
    assert!(
        without.took < Duration::from_millis(1000),
        "{:?}",
        without.took
    );

    // With no setting, the wait is a couple of seconds.
    let default = report(&[]);
    assert_eq!(default.code, without.code);
    assert!(
        default.took >= Duration::from_millis(1900),
        "{:?}",
        default.took
    );
    assert!(default.took < Duration::from_secs(15), "{:?}", default.took);
}

#[test]
fn a_collector_that_refuses_or_redirects_changes_nothing() {
    let store = store();
    let args = [
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "catch-up",
    ];
    let without = run(&[], &args);
    for reply in [
        Reply::Answer(401),
        Reply::Answer(404),
        Reply::Answer(500),
        Reply::Answer(503),
        Reply::Redirect,
    ] {
        let collector = Collector::open(reply);
        // A timeout far longer than any run, so only a run that waited on the
        // collector can come near it, however loaded the machine.
        let with = run(
            &report_to(&collector, &[("OTEL_EXPORTER_OTLP_TIMEOUT", "30000")]),
            &args,
        );
        assert_eq!(with.code, without.code);
        assert_eq!(with.stdout, without.stdout);
        assert_eq!(with.stderr, without.stderr);
        assert!(with.took < Duration::from_secs(15), "{:?}", with.took);
        // The witness: it was sent, once, and a redirect was not followed.
        assert_eq!(collector.received().len(), 1);
        assert_eq!(collector.received()[0].path(), "/v1/traces");
    }
}

#[test]
fn with_no_endpoint_nothing_is_attempted_and_the_output_is_the_same_as_with_one() {
    let store = store();
    let witness = Collector::open(Reply::Answer(200));
    for args in [
        vec![
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "catch-up",
        ],
        vec![
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "search",
            "x",
        ],
        vec!["--json", "operations"],
    ] {
        let plain = run(&[], &args);
        let reported = run(&report_to(&witness, &[]), &args);
        assert_eq!(reported.code, plain.code, "{args:?}");
        assert_eq!(reported.stdout, plain.stdout, "{args:?}");
        assert_eq!(reported.stderr, plain.stderr, "{args:?}");
    }
    // The witness: the same three runs did report when told where.
    assert_eq!(witness.received().len(), 3);

    // Everything that leaves telemetry off, with the collector named too.
    let quiet = Collector::open(Reply::Answer(200));
    let args = [
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "catch-up",
    ];
    let plain = run(&[], &args);
    for off in [
        vec![("OTEL_SDK_DISABLED", "true")],
        vec![("OTEL_TRACES_SAMPLER", "always_off")],
        vec![
            ("OTEL_TRACES_SAMPLER", "parentbased_traceidratio"),
            ("OTEL_TRACES_SAMPLER_ARG", "0"),
        ],
    ] {
        let ran = run(&report_to(&quiet, &off), &args);
        assert_eq!(
            (ran.code, ran.stdout, ran.stderr),
            (plain.code, plain.stdout.clone(), plain.stderr.clone())
        );
    }
    assert_eq!(quiet.connections.load(Ordering::SeqCst), 0);
    // And the same collector is reached once the sampler keeps the trace.
    let kept = run(
        &report_to(
            &quiet,
            &[
                ("OTEL_TRACES_SAMPLER", "traceidratio"),
                ("OTEL_TRACES_SAMPLER_ARG", "1"),
            ],
        ),
        &args,
    );
    assert_eq!(kept.code, plain.code);
    assert_eq!(quiet.received().len(), 1);
}

#[test]
fn an_endpoint_that_cannot_be_used_is_ignored_with_one_line_that_does_not_show_it() {
    let store = store();
    let args = [
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "catch-up",
    ];
    let plain = run(&[], &args);
    for (variable, bad) in [
        ("OTEL_EXPORTER_OTLP_ENDPOINT", format!("not a url {SECRET}")),
        (
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            format!("ftp://user:{SECRET}@host/"),
        ),
    ] {
        // With --json, the telemetry line is not printed.
        let ran = run(&[(variable, bad.as_str())], &args);
        assert_eq!(ran.code, plain.code);
        assert_eq!(ran.stdout, plain.stdout);
        assert_eq!(ran.stderr, plain.stderr);
        // Without it, one line that names the variable and not its value.
        let words = ["items", "get", "an-id"];
        let plain_words = run(&[], &words);
        let said = run(&[(variable, bad.as_str())], &words);
        assert_eq!(said.code, plain_words.code);
        assert_eq!(said.stdout, plain_words.stdout);
        assert_eq!(
            said.stderr,
            format!(
                "marfa: {variable} is not an http or https address, so this run sends no traces\n{}",
                plain_words.stderr
            )
        );
        assert!(!said.stderr.contains(SECRET));
    }
    // A header or a timeout that cannot be used is left out without a word.
    let collector = Collector::open(Reply::Answer(200));
    let odd = run(
        &report_to(
            &collector,
            &[
                ("OTEL_EXPORTER_OTLP_HEADERS", "no pair,=x,a b=c"),
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "soon"),
            ],
        ),
        &args,
    );
    assert_eq!(
        (odd.code, odd.stdout, odd.stderr),
        (plain.code, plain.stdout.clone(), plain.stderr.clone())
    );
    assert_eq!(collector.received().len(), 1);
}

#[test]
fn runs_at_the_same_time_each_export_a_trace_of_their_own() {
    let collector = Collector::open(Reply::Answer(200));
    let store = store();
    let args = [
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "search",
        "x",
    ];
    let children: Vec<_> = (0..6)
        .map(|_| {
            command(&report_to(&collector, &[]), &args)
                .stdout(Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    for mut child in children {
        assert!(child.wait().unwrap().success());
    }
    let spans = collector.spans();
    let roots: Vec<_> = spans
        .iter()
        .filter(|span| span.get("parentSpanId").is_none())
        .collect();
    assert_eq!(roots.len(), 6);
    let traces: std::collections::HashSet<_> = roots
        .iter()
        .map(|span| span["traceId"].as_str().unwrap())
        .collect();
    assert_eq!(traces.len(), 6, "a trace for each process");
    assert_eq!(spans.len(), 12, "a search span below each root");
}

/// A server that answers `/events` with a stream that never ends.
fn event_stream() -> (String, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = Arc::clone(&stop);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let stopped = Arc::clone(&stopped);
            std::thread::spawn(move || {
                door::read_request(&mut stream);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n{}: {}\r\nConnection: close\r\n\r\nid: 1\nevent: ping\ndata: {{}}\n\n",
                    marfa_core::http::CONTRACT_HEADER,
                    marfa_core::contract::CONTRACT_VERSION
                );
                let _ = stream.write_all(head.as_bytes());
                while !stopped.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(20));
                }
            });
        }
    });
    (url, stop)
}

/// Starts `events` against a stream that never ends, waits for its first
/// frame, runs `while_open`, and sends Ctrl-C. Returns how the command ended,
/// which it does by itself; the stream's server is stopped when it has.
fn events_until_interrupted(
    env: &[(&str, &str)],
    while_open: impl FnOnce(),
) -> std::process::ExitStatus {
    let (server, stop) = event_stream();
    let mut env = env.to_vec();
    env.push(("MARFA_API_URL", server.as_str()));
    let mut child = command(&env, &["events"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let watchdog = child.id();
    let guard = Arc::new(AtomicBool::new(false));
    let guarded = Arc::clone(&guard);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        if !guarded.load(Ordering::SeqCst) {
            // SAFETY: ends a child this test started and no longer waits on.
            unsafe { libc::kill(watchdog as i32, libc::SIGKILL) };
        }
    });
    // The first frame is out: the stream is open and the command is in its loop.
    let mut first = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first)
        .unwrap();
    assert!(first.contains("ping"), "{first:?}");
    while_open();

    // SAFETY: signals the child this test started.
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    let status = child.wait().unwrap();
    guard.store(true, Ordering::SeqCst);
    stop.store(true, Ordering::SeqCst);
    status
}

#[test]
fn an_interrupt_ends_a_stream_that_runs_until_stopped_after_its_trace_is_sent() {
    let collector = Collector::open(Reply::Answer(200));
    let status = events_until_interrupted(&report_to(&collector, &[]), || {
        assert!(
            collector.received().is_empty(),
            "nothing is sent before the run ends"
        );
    });
    assert_eq!(
        status.code(),
        Some(130),
        "ended by itself, with the status an interrupt gives"
    );

    let root = collector.root();
    assert_eq!(root["name"], "marfa events");
    assert_eq!(number(&root, "exit_code"), 130);
    assert!(
        root.get("status").is_none(),
        "an interrupt is how this command ends"
    );
    assert!(root["events"].as_array().unwrap().is_empty());
}

#[test]
fn a_query_in_the_base_address_stays_a_query_and_the_path_gets_the_traces_path() {
    let collector = Collector::open(Reply::Answer(200));
    let base = format!("{}/?token=abc", collector.url);
    let ran = run(
        &[("OTEL_EXPORTER_OTLP_ENDPOINT", base.as_str())],
        &["operations"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let posts = collector.received();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0].path(), "/v1/traces?token=abc");
}

/// Starts `args` with a server that takes the connection and never answers,
/// waits until it has, sends Ctrl-C and returns how the command ended and
/// how long that took. The command is killed if it outlasts the wait.
fn interrupted_while_the_server_is_silent(
    args: &[&str],
    env: &[(&str, &str)],
) -> (std::process::ExitStatus, Duration, String) {
    use std::io::Read;
    let silent = Collector::open(Reply::Silence);
    let mut child = command(env, args)
        .env("MARFA_API_URL", silent.url.as_str())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while silent.connections.load(Ordering::SeqCst) == 0 {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the command never asked the server"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Held a moment, so the command is in the wait the signal has to end.
    std::thread::sleep(Duration::from_millis(300));
    // SAFETY: signals the child this test started.
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    let signalled = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if signalled.elapsed() > Duration::from_secs(8) {
            child.kill().unwrap();
            let status = child.wait().unwrap();
            panic!("Ctrl-C did not end the command within 8 seconds ({status:?})");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    (status, signalled.elapsed(), stderr)
}

#[test]
fn a_first_interrupt_ends_a_stream_still_being_asked_for_as_the_signal_does() {
    use std::os::unix::process::ExitStatusExt;
    let (status, took, stderr) = interrupted_while_the_server_is_silent(&["events"], &[]);
    // Killed by the signal, as ever, not left waiting for the server.
    assert_eq!(status.signal(), Some(libc::SIGINT), "{status:?} {stderr}");
    assert!(took < Duration::from_secs(2), "{took:?}");
}

#[test]
fn a_first_interrupt_ends_a_hydration_waiting_on_the_server_and_it_is_not_a_failed_run() {
    let collector = Collector::open(Reply::Answer(200));
    let store = scratch("hydrate", "copy.sqlite");
    let (status, took, stderr) = interrupted_while_the_server_is_silent(
        &[
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "hydrate",
            "--types",
            "core.note",
            "--tier",
            "library",
        ],
        &report_to(&collector, &[]),
    );
    assert_eq!(status.code(), Some(3), "{stderr}");
    assert!(stderr.contains("\"canceled\""), "{stderr}");
    assert!(took < Duration::from_secs(5), "{took:?}");

    let root = collector.root();
    assert_eq!(root["name"], "marfa device hydrate");
    assert_eq!(number(&root, "exit_code"), 3);
    // A refused run carries both, as the first test shows.
    assert!(
        root.get("status").is_none(),
        "a stopped run has an error status"
    );
    assert!(
        root["events"].as_array().unwrap().is_empty(),
        "a stopped run has an error event"
    );
}

// ---- Exceptions to PostHog ----

fn exceptions_to<'a>(collector: &'a Collector, posthog: &'a Collector) -> Vec<(&'a str, &'a str)> {
    report_to(
        collector,
        &[
            ("MARFA_POSTHOG_HOST", posthog.url.as_str()),
            ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
        ],
    )
}

fn same_output(ran: &Ran, plain: &Ran, what: &str) {
    assert_eq!(
        (ran.code, &ran.stdout, &ran.stderr),
        (plain.code, &plain.stdout, &plain.stderr),
        "{what}"
    );
}

const HOST_ALONE: &str = "marfa: MARFA_POSTHOG_HOST is set without MARFA_POSTHOG_PROJECT_TOKEN, so this run sends no exception report\n";
const TOKEN_ALONE: &str = "marfa: MARFA_POSTHOG_PROJECT_TOKEN is set without MARFA_POSTHOG_HOST, so this run sends no exception report\n";
const NOT_HTTPS: &str = "marfa: MARFA_POSTHOG_HOST is not an https address, or an http address on this machine, without a user name or password, so this run sends no exception report\n";

#[test]
fn a_failing_command_sends_one_exception_with_its_codes_a_fixed_sentence_and_no_person() {
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let env = exceptions_to(&collector, &posthog);
    let ran = run(&env, &FAULT);
    assert_eq!(ran.code, 3, "{}", ran.stderr);

    let posts = posthog.received();
    assert_eq!(posts.len(), 1, "one failed run is one post");
    let post = &posts[0];
    assert_eq!(post.method(), "POST");
    assert_eq!(post.path(), "/i/v0/e/");
    assert_eq!(post.header("content-type"), Some("application/json"));
    let events = posthog.events();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event["event"], "$exception");
    assert_eq!(event["api_key"], TOKEN);
    let id = event["distinct_id"].as_str().unwrap();
    assert_eq!(id.len(), 32);
    let properties = &event["properties"];
    assert_eq!(properties["$process_person_profile"], false);
    assert_eq!(properties["$geoip_disable"], true);
    assert_eq!(properties["command"], "items get");
    assert_eq!(properties["error_code"], "server");
    assert_eq!(properties["exit_code"], 3);
    assert_eq!(properties["service.name"], "marfa-cli");
    assert_eq!(properties["$exception_level"], "error");
    let exception = &properties["$exception_list"][0];
    assert_eq!(exception["type"], "server");
    assert_eq!(
        exception["value"],
        "the server failed to complete the request"
    );
    assert_eq!(exception["mechanism"]["handled"], true);
    assert!(
        exception.get("stacktrace").is_none(),
        "a CliError has no frames to report"
    );

    // The token is in the field PostHog reads it from and nowhere else.
    assert_eq!(post.body.matches(TOKEN).count(), 1, "{}", post.body);
    assert!(post.headers.iter().all(|(_, value)| !value.contains(TOKEN)));
    assert!(!post.line.contains(TOKEN));
    // The trace went where it always did, and carried none of this.
    assert_eq!(collector.root()["name"], "marfa items get");
    assert!(
        collector
            .received()
            .iter()
            .all(|post| !post.body.contains(TOKEN) && post.path() == "/v1/traces")
    );

    // A process of its own has an id of its own, and the service name is the trace's.
    let mut named = exceptions_to(&collector, &posthog);
    named.push(("OTEL_SERVICE_NAME", "my-service"));
    run(&named, &FAULT);
    let events = posthog.events();
    assert_eq!(events.len(), 2);
    assert_ne!(events[1]["distinct_id"].as_str().unwrap(), id);
    assert_eq!(events[1]["properties"]["service.name"], "my-service");
}

#[test]
fn resource_attributes_the_operator_names_reach_the_trace_and_the_exception() {
    let named = "deployment.environment=rehearsal,team=a%20b,service.version=9.9.9";

    // The witness: with no attributes named, the run names none of these.
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    run(&exceptions_to(&collector, &posthog), &FAULT);
    let plain: Value = serde_json::from_str(&collector.received()[0].body).unwrap();
    let plain = &plain["resourceSpans"][0]["resource"];
    assert!(attribute(plain, "deployment.environment").is_none());
    assert!(attribute(plain, "team").is_none());
    assert_ne!(word(plain, "service.version"), "9.9.9");
    assert_eq!(word(plain, "service.name"), "marfa-cli");

    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let mut env = exceptions_to(&collector, &posthog);
    env.push(("OTEL_RESOURCE_ATTRIBUTES", named));
    run(&env, &FAULT);

    let trace: Value = serde_json::from_str(&collector.received()[0].body).unwrap();
    let resource = &trace["resourceSpans"][0]["resource"];
    assert_eq!(word(resource, "deployment.environment"), "rehearsal");
    assert_eq!(word(resource, "team"), "a b");
    assert_eq!(word(resource, "service.version"), "9.9.9");
    assert_eq!(word(resource, "service.name"), "marfa-cli");

    let events = posthog.events();
    assert_eq!(events.len(), 1);
    let properties = &events[0]["properties"];
    assert_eq!(properties["deployment.environment"], "rehearsal");
    assert_eq!(properties["team"], "a b");
    assert_eq!(properties["service.version"], "9.9.9");
    assert_eq!(properties["service.name"], "marfa-cli");
}

#[test]
fn a_resource_attribute_list_with_a_bad_pair_names_nothing_and_the_run_is_unchanged() {
    let collector = Collector::open(Reply::Answer(200));
    let mut env = report_to(&collector, &[]);
    env.push((
        "OTEL_RESOURCE_ATTRIBUTES",
        "deployment.environment=rehearsal,broken",
    ));
    let ran = run(&env, &FAULT);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    let trace: Value = serde_json::from_str(&collector.received()[0].body).unwrap();
    assert!(
        attribute(
            &trace["resourceSpans"][0]["resource"],
            "deployment.environment"
        )
        .is_none()
    );
}

#[test]
fn nothing_planted_in_the_command_line_the_environment_or_the_data_reaches_posthog() {
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let store = store();
    // A server that fails, and says the secret in its message.
    let broken = Collector::open(Reply::Fault(SECRET));
    let hostport = broken.url.trim_start_matches("http://");
    let address = format!("http://user:{SECRET}@{hostport}/path?token={SECRET}");
    let key = format!("marfa_k1_{SECRET}");
    let held = format!("item-{SECRET}");
    let folder = scratch("folder", SECRET);
    let registry = scratch("registry", "folders.json");
    let mut env = exceptions_to(&collector, &posthog);
    env.push(("MARFA_API_KEY", key.as_str()));
    env.push(("MARFA_API_URL", address.as_str()));
    env.push(("MARFA_FOLDER_REGISTRY", registry.to_str().unwrap()));

    // A copy that names the id it refused, a request that goes out and fails
    // with the address and the content in it, and a folder that names its path.
    let refused = run(
        &env,
        &[
            "--json",
            "--key",
            &key,
            "device",
            "--db",
            store.to_str().unwrap(),
            "items",
            "get",
            &held,
        ],
    );
    assert_eq!(refused.code, 1, "{}", refused.stderr);
    let create = run(
        &env,
        &[
            "--json",
            "--key",
            &key,
            "items",
            "create",
            "--type",
            "core.note",
            "--prop",
            &format!("title={SECRET}"),
            "--properties",
            &format!("{{\"body\":\"{SECRET}\"}}"),
            "--tag",
            SECRET,
        ],
    );
    assert_eq!(create.code, 3, "{}", create.stderr);
    let watch = run(&env, &["folders", "watch", folder.to_str().unwrap()]);
    assert_eq!(watch.code, 1, "{}", watch.stderr);
    // A panic whose message carries content.
    let message = format!("boom {SECRET}");
    let mut panicking = env.clone();
    panicking.push(("MARFA_TEST_PANIC", message.as_str()));
    let panicked = run(&panicking, &["operations"]);
    assert_eq!(panicked.code, 101, "{}", panicked.stderr);
    assert!(panicked.stderr.contains(SECRET), "{}", panicked.stderr);
    // The witness: the secret is in what each command says on stderr, so an
    // exception carrying the message would have carried it.
    assert!(refused.stderr.contains(SECRET), "{}", refused.stderr);
    assert!(watch.stderr.contains(SECRET), "{}", watch.stderr);

    let posts = posthog.received();
    // The refusals said the secret and reported nothing: only the fault and the
    // panic did.
    assert_eq!(posts.len(), 2, "each fault reported");
    let events = posthog.events();
    let commands: Vec<_> = events
        .iter()
        .map(|event| event["properties"]["command"].as_str().unwrap())
        .collect();
    assert_eq!(commands, ["items create", "operations"]);
    let codes: Vec<_> = events
        .iter()
        .map(|event| event["properties"]["exit_code"].as_i64().unwrap())
        .collect();
    assert_eq!(codes, [3, 101]);
    for post in &posts {
        for planted in [
            SECRET,
            "user:",
            hostport,
            store.to_str().unwrap(),
            folder.to_str().unwrap(),
            "/path?",
            "marfa_k1_",
            "core.note",
            "main.rs",
            "panicked",
        ] {
            assert!(
                !post.body.contains(planted) && !post.line.contains(planted),
                "{planted} reached PostHog: {}",
                post.body
            );
        }
        assert!(
            post.headers
                .iter()
                .all(|(_, value)| !value.contains(SECRET))
        );
    }
    // Nor did the token reach the collector, or the key reach either.
    assert!(
        collector
            .received()
            .iter()
            .all(|post| !post.body.contains(TOKEN) && !post.body.contains(SECRET))
    );
}

#[test]
fn without_both_posthog_settings_or_with_the_sdk_disabled_no_exception_is_sent_and_the_output_is_the_same()
 {
    let args = FAULT;
    let plain = run(&[], &args);
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let host = posthog.url.as_str();

    for (what, env) in [
        (
            "no token",
            report_to(&collector, &[("MARFA_POSTHOG_HOST", host)]),
        ),
        (
            "no host",
            report_to(&collector, &[("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN)]),
        ),
        (
            "a blank token",
            report_to(
                &collector,
                &[
                    ("MARFA_POSTHOG_HOST", host),
                    ("MARFA_POSTHOG_PROJECT_TOKEN", "  "),
                ],
            ),
        ),
        (
            "the sdk disabled",
            report_to(
                &collector,
                &[
                    ("MARFA_POSTHOG_HOST", host),
                    ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
                    ("OTEL_SDK_DISABLED", "true"),
                ],
            ),
        ),
        (
            "the sdk disabled and no endpoint",
            vec![
                ("MARFA_POSTHOG_HOST", host),
                ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
                ("OTEL_SDK_DISABLED", "true"),
            ],
        ),
    ] {
        let ran = run(&env, &args);
        same_output(&ran, &plain, what);
    }
    assert_eq!(posthog.connections.load(Ordering::SeqCst), 0);

    // The witness: both PostHog settings, the same command, and it is sent.
    let ran = run(&exceptions_to(&collector, &posthog), &args);
    same_output(&ran, &plain, "both set");
    assert_eq!(posthog.events().len(), 1);
}

fn only_posthog<'a>(
    posthog: &'a Collector,
    extra: &[(&'a str, &'a str)],
) -> Vec<(&'a str, &'a str)> {
    let mut env = vec![
        ("MARFA_POSTHOG_HOST", posthog.url.as_str()),
        ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
    ];
    env.extend_from_slice(extra);
    env
}

#[test]
fn a_failing_command_sends_its_exception_whatever_the_otlp_settings_are() {
    let store = store();
    let args = FAULT;
    let plain = run(&[], &args);
    let posthog = Collector::open(Reply::Answer(200));

    // No OTLP setting at all, as in a shell an agent host has cleared.
    let ran = run(&only_posthog(&posthog, &[]), &args);
    same_output(&ran, &plain, "no endpoint");
    let events = posthog.events();
    assert_eq!(events.len(), 1, "one failed run is one post");
    assert_eq!(posthog.received()[0].path(), "/i/v0/e/");
    let properties = &events[0]["properties"];
    assert_eq!(events[0]["event"], "$exception");
    assert_eq!(properties["error_code"], "server");
    assert_eq!(properties["service.name"], "marfa-cli");

    // The identity and the time budget are read without an endpoint too.
    let ran = run(
        &only_posthog(
            &posthog,
            &[
                ("OTEL_SERVICE_NAME", "my-service"),
                (
                    "OTEL_RESOURCE_ATTRIBUTES",
                    "deployment.environment=rehearsal",
                ),
                ("OTEL_EXPORTER_OTLP_TIMEOUT", "1500"),
            ],
        ),
        &args,
    );
    same_output(&ran, &plain, "named without an endpoint");
    let events = posthog.events();
    assert_eq!(events.len(), 2);
    let properties = &events[1]["properties"];
    assert_eq!(properties["service.name"], "my-service");
    assert_eq!(properties["deployment.environment"], "rehearsal");
    assert_eq!(posthog.received().len(), 2);

    // A run that did not fail sends nothing, with the same settings.
    let done = run(
        &only_posthog(&posthog, &[]),
        &[
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "search",
            "x",
        ],
    );
    assert_eq!(done.code, 0, "{}", done.stderr);
    assert_eq!(posthog.received().len(), 2);
}

#[test]
fn an_endpoint_that_cannot_be_used_turns_off_the_traces_and_not_the_exception() {
    let words = ["items", "get", "an-id"];
    let plain = run(&[], &words);
    let posthog = Collector::open(Reply::Answer(200));
    let bad = format!("not a url {SECRET}");

    let ran = run(
        &only_posthog(&posthog, &[("OTEL_EXPORTER_OTLP_ENDPOINT", bad.as_str())]),
        &words,
    );
    assert_eq!(ran.code, plain.code);
    assert_eq!(ran.stdout, plain.stdout);
    assert_eq!(
        ran.stderr,
        format!(
            "marfa: OTEL_EXPORTER_OTLP_ENDPOINT is not an http or https address, so this run sends no traces\n{}",
            plain.stderr
        )
    );
    assert!(!ran.stderr.contains(SECRET));
    assert_eq!(posthog.events().len(), 1);

    // The other way round: a host that cannot be used leaves the trace alone.
    let collector = Collector::open(Reply::Answer(200));
    let env = report_to(
        &collector,
        &[
            ("MARFA_POSTHOG_HOST", "ftp://posthog.example"),
            ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
        ],
    );
    run(&env, &words);
    assert_eq!(collector.received().len(), 1);
    assert_eq!(posthog.events().len(), 1);
}

#[test]
fn a_host_without_a_token_or_a_token_without_a_host_is_said_once_without_its_value() {
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let words = ["items", "get", "an-id"];
    let plain = run(&[], &words);
    let plain_json = run(&[], &FAULT);
    let value = format!("{}/{SECRET}", posthog.url);

    for (said, extra) in [
        (HOST_ALONE, ("MARFA_POSTHOG_HOST", value.as_str())),
        (TOKEN_ALONE, ("MARFA_POSTHOG_PROJECT_TOKEN", SECRET)),
    ] {
        let env = report_to(&collector, &[extra]);
        let ran = run(&env, &words);
        assert_eq!((ran.code, &ran.stdout), (plain.code, &plain.stdout));
        assert_eq!(ran.stderr, format!("{said}{}", plain.stderr));
        assert!(!ran.stderr.contains(SECRET));
        // Under --json the line is not printed.
        let json = run(&env, &FAULT);
        same_output(&json, &plain_json, "--json");
    }
    assert_eq!(posthog.connections.load(Ordering::SeqCst), 0);
    // The trace is not touched by it: one for each of the four runs.
    assert_eq!(collector.received().len(), 4);
}

#[test]
fn a_host_that_is_not_https_and_not_this_machine_stays_off_and_is_said_once() {
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let words = ["items", "get", "an-id"];
    let plain = run(&[], &words);
    let plain_json = run(&[], &FAULT);
    // The same listener, reached by a name that is not loopback: a gate that
    // let it through would reach the stub.
    let elsewhere = posthog.url.replace("127.0.0.1", "0.0.0.0");
    assert_ne!(elsewhere, posthog.url);
    let secret_host = format!("{elsewhere}/{SECRET}?key={SECRET}");

    for host in [
        elsewhere.as_str(),
        secret_host.as_str(),
        "ftp://posthog.example",
        "posthog.example",
    ] {
        let env = report_to(
            &collector,
            &[
                ("MARFA_POSTHOG_HOST", host),
                ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
            ],
        );
        let ran = run(&env, &words);
        assert_eq!(
            (ran.code, &ran.stdout),
            (plain.code, &plain.stdout),
            "{host}"
        );
        assert_eq!(ran.stderr, format!("{NOT_HTTPS}{}", plain.stderr), "{host}");
        assert!(!ran.stderr.contains(SECRET));
        same_output(&run(&env, &FAULT), &plain_json, host);
    }
    assert_eq!(posthog.connections.load(Ordering::SeqCst), 0);

    // The witness: this machine, over plain http, is reached.
    let ran = run(&exceptions_to(&collector, &posthog), &words);
    assert_eq!(ran.stderr, plain.stderr);
    assert_eq!(posthog.events().len(), 1);
}

#[test]
fn a_posthog_that_is_down_silent_or_refusing_changes_neither_the_exit_nor_the_output() {
    let args = FAULT;
    let plain = run(&[], &args);
    let collector = Collector::open(Reply::Answer(200));

    for dead in [closed_port(), "http://127.0.0.1:9".to_string()] {
        let env = report_to(
            &collector,
            &[
                ("MARFA_POSTHOG_HOST", dead.as_str()),
                ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
            ],
        );
        let ran = run(&env, &args);
        same_output(&ran, &plain, &dead);
        assert!(ran.took < Duration::from_secs(3), "{:?}", ran.took);
    }

    for reply in [
        Reply::Answer(401),
        Reply::Answer(404),
        Reply::Answer(500),
        Reply::Answer(503),
        Reply::Redirect,
    ] {
        let posthog = Collector::open(reply);
        let ran = run(&exceptions_to(&collector, &posthog), &args);
        same_output(&ran, &plain, "a refusal");
        assert!(ran.took < Duration::from_secs(3), "{:?}", ran.took);
        // The witness: it was sent, once, and a redirect was not followed
        // with the token in its body.
        assert_eq!(posthog.received().len(), 1);
        assert_eq!(posthog.received()[0].path(), "/i/v0/e/");
    }

    let silent = Collector::open(Reply::Silence);
    let mut env = exceptions_to(&collector, &silent);
    env.push(("OTEL_EXPORTER_OTLP_TIMEOUT", "600"));
    let short = run(&env, &args);
    same_output(&short, &plain, "a silent PostHog");
    // The witness that it waited: the run reached the listener, and took the timeout.
    assert_eq!(silent.received().len(), 1);
    assert!(short.took >= Duration::from_millis(550), "{:?}", short.took);
    assert!(short.took < Duration::from_secs(3), "{:?}", short.took);

    // With no setting the wait is a couple of seconds, as the trace's is.
    let default = run(&exceptions_to(&collector, &silent), &args);
    same_output(&default, &plain, "a silent PostHog, by default");
    assert!(
        default.took >= Duration::from_millis(1900),
        "{:?}",
        default.took
    );
    assert!(default.took < Duration::from_secs(15), "{:?}", default.took);
}

#[test]
fn a_silent_collector_and_a_silent_posthog_are_waited_for_together() {
    let args = FAULT;
    let plain = run(&[], &args);
    let collector = Collector::open(Reply::Silence);
    let posthog = Collector::open(Reply::Silence);
    let mut env = exceptions_to(&collector, &posthog);
    env.push(("OTEL_EXPORTER_OTLP_TIMEOUT", "1000"));
    let ran = run(&env, &args);
    same_output(&ran, &plain, "both silent");
    assert_eq!(collector.received().len(), 1);
    assert_eq!(posthog.received().len(), 1);
    assert!(ran.took >= Duration::from_millis(950), "{:?}", ran.took);
    assert!(
        ran.took < Duration::from_millis(1800),
        "one after the other would take two: {:?}",
        ran.took
    );
}

#[test]
fn a_refusal_by_design_sends_nothing_and_a_fault_sends_one() {
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let env = exceptions_to(&collector, &posthog);
    let ask = ["--json", "items", "get", "an-id"];

    // The server refuses as it should: not found, in conflict, invalid, not
    // permitted, a credential it does not accept, too large, rate limited.
    for (status, exit) in [
        (404, 1),
        (409, 1),
        (422, 1),
        (403, 1),
        (401, 5),
        (413, 1),
        (429, 3),
    ] {
        let server = Collector::open(Reply::Refusal(status));
        let mut refused = env.clone();
        refused.push(("MARFA_API_URL", server.url.as_str()));
        let ran = run(&refused, &ask);
        assert_eq!(ran.code, exit, "{status}: {}", ran.stderr);
        assert!(
            !server.received().is_empty(),
            "{status}: the server was asked"
        );
    }

    // The CLI refuses a command line, a missing docs page and a missing
    // credential itself.
    let usage = run(&env, &["--socket", "/nowhere/control.sock", "login"]);
    assert_eq!(usage.code, 2, "{}", usage.stderr);
    let docs = Collector::open(Reply::Answer(404));
    let mut page = env.clone();
    page.push(("MARFA_DOCS_URL", docs.url.as_str()));
    let missing = run(&page, &["--json", "docs", "no-such-page"]);
    assert_eq!(missing.code, 1, "{}", missing.stderr);
    assert!(
        missing.stderr.contains("docs_page_not_found"),
        "{}",
        missing.stderr
    );
    assert!(!docs.received().is_empty(), "the docs site was asked");
    let mut keyless = env.clone();
    keyless.push(("MARFA_API_KEY", ""));
    let nothing = run(&keyless, &["--json", "items", "get", "an-id"]);
    assert_eq!(nothing.code, 5, "{}", nothing.stderr);

    // Nor does the environment failing: the server's address is nobody's.
    let down = closed_port();
    let mut offline = env.clone();
    offline.push(("MARFA_API_URL", down.as_str()));
    let ran = run(&offline, &ask);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(ran.stderr.contains("\"network\""), "{}", ran.stderr);

    assert_eq!(posthog.connections.load(Ordering::SeqCst), 0);
    // The witness: the same settings send for a server that fails.
    assert_eq!(run(&env, &ask).code, 3);
    assert_eq!(posthog.events().len(), 1);
    let sent = &posthog.events()[0]["properties"];
    assert_eq!(sent["error_code"], "server");
}

#[test]
fn a_run_that_did_not_fail_sends_nothing() {
    let store = store();
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let env = exceptions_to(&collector, &posthog);

    let done = run(
        &env,
        &[
            "--json",
            "device",
            "--db",
            store.to_str().unwrap(),
            "search",
            "x",
        ],
    );
    assert_eq!(done.code, 0, "{}", done.stderr);

    // Stopped by Ctrl-C: how a command that runs until it is stopped ends.
    let stopped = events_until_interrupted(&env, || {});
    assert_eq!(stopped.code(), Some(130));

    // Stopped by Ctrl-C while it waited on the server: a canceled hydration.
    let copy = scratch("hydrate", "copy.sqlite");
    let (status, _, stderr) = interrupted_while_the_server_is_silent(
        &[
            "--json",
            "device",
            "--db",
            copy.to_str().unwrap(),
            "hydrate",
            "--types",
            "core.note",
            "--tier",
            "library",
        ],
        &env,
    );
    assert_eq!(status.code(), Some(3), "{stderr}");
    assert!(stderr.contains("\"canceled\""), "{stderr}");

    assert_eq!(posthog.connections.load(Ordering::SeqCst), 0);
    // The witness: the same settings send for a run that failed.
    assert_eq!(run(&env, &FAULT).code, 3);
    assert_eq!(posthog.events().len(), 1);
}

#[test]
fn an_interrupted_run_sends_nothing_to_a_posthog_that_would_never_answer() {
    let silent = Collector::open(Reply::Silence);
    let collector = Collector::open(Reply::Answer(200));
    let status = events_until_interrupted(&exceptions_to(&collector, &silent), || {});
    assert_eq!(status.code(), Some(130));
    assert_eq!(silent.connections.load(Ordering::SeqCst), 0);
    assert_eq!(collector.root()["name"], "marfa events");
}

#[test]
fn the_sampler_decides_the_trace_and_not_the_exception() {
    let args = FAULT;
    let plain = run(&[], &args);
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    for sampler in [
        vec![("OTEL_TRACES_SAMPLER", "always_off")],
        vec![
            ("OTEL_TRACES_SAMPLER", "traceidratio"),
            ("OTEL_TRACES_SAMPLER_ARG", "0"),
        ],
    ] {
        let mut env = exceptions_to(&collector, &posthog);
        env.extend(sampler);
        let ran = run(&env, &args);
        same_output(&ran, &plain, "sampled out");
    }
    assert_eq!(collector.connections.load(Ordering::SeqCst), 0, "no trace");
    assert_eq!(posthog.events().len(), 2, "an exception for each run");
}

#[test]
fn a_panic_sends_one_event_of_a_fixed_type_and_the_exit_and_message_are_unchanged() {
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let message = format!("boom {SECRET}");
    let plain = run(&[("MARFA_TEST_PANIC", message.as_str())], &["operations"]);
    assert_eq!(plain.code, 101, "{}", plain.stderr);
    assert!(plain.stderr.contains(&message), "{}", plain.stderr);

    let mut env = exceptions_to(&collector, &posthog);
    env.push(("MARFA_TEST_PANIC", message.as_str()));
    let ran = run(&env, &["operations"]);
    // The thread's number is the one thing that differs between two runs.
    let unnumbered = |text: &str| {
        let start = text.find("' (").unwrap() + 3;
        let end = start + text[start..].find(')').unwrap();
        format!("{}{}", &text[..start], &text[end..])
    };
    assert_eq!(ran.code, plain.code);
    assert_eq!(ran.stdout, plain.stdout);
    assert_eq!(unnumbered(&ran.stderr), unnumbered(&plain.stderr));

    let events = posthog.events();
    assert_eq!(events.len(), 1);
    let properties = &events[0]["properties"];
    assert_eq!(properties["command"], "operations");
    assert_eq!(properties["exit_code"], 101);
    assert_eq!(properties["error_code"], "panic");
    let exception = &properties["$exception_list"][0];
    assert_eq!(exception["type"], "panic");
    assert_eq!(
        exception["value"],
        "the command stopped on an internal fault"
    );
    // The trace is ended as failed, with the same code and no text.
    let root = collector.root();
    assert_eq!(root["name"], "marfa operations");
    assert_eq!(root["status"]["code"], 2);
    assert_eq!(number(&root, "exit_code"), 101);
    assert_eq!(word(&root["events"][0], "code"), "panic");
    assert!(!collector.received()[0].body.contains(SECRET));
    assert!(!posthog.received()[0].body.contains(SECRET));
}

#[test]
fn a_proxy_in_the_environment_is_not_used_for_a_post_to_this_machine() {
    let proxy = Collector::open(Reply::Answer(502));
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let mut env = exceptions_to(&collector, &posthog);
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        env.push((name, proxy.url.as_str()));
    }
    env.push(("MARFA_TEST_PANIC", "a fault with no request to send"));
    let ran = run(&env, &["--json", "operations"]);
    assert_eq!(ran.code, 101, "{}", ran.stderr);
    // Both posts reached the local servers, in the clear to this machine only.
    assert_eq!(posthog.events().len(), 1);
    assert_eq!(collector.root()["name"], "marfa operations");
    assert_eq!(
        proxy.connections.load(Ordering::SeqCst),
        0,
        "a proxy saw a post: {:?}",
        proxy.received()
    );
}

#[test]
fn a_proxy_in_the_environment_is_still_used_for_a_post_to_another_host() {
    let proxy = Collector::open(Reply::Answer(502));
    let args = FAULT;
    let plain = run(&[], &args);
    let env = [
        ("OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.example"),
        ("MARFA_POSTHOG_HOST", "https://posthog.example"),
        ("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN),
        ("HTTPS_PROXY", proxy.url.as_str()),
        ("https_proxy", proxy.url.as_str()),
        // The server under test is on this machine.
        ("NO_PROXY", "127.0.0.1"),
    ];
    let ran = run(&env, &args);
    same_output(&ran, &plain, "a refusing proxy");
    let tunnels: Vec<String> = proxy
        .received()
        .iter()
        .map(|post| post.line.clone())
        .collect();
    assert!(
        tunnels
            .iter()
            .any(|line| line.starts_with("CONNECT posthog.example:443 ")),
        "{tunnels:?}"
    );
    assert!(!tunnels.iter().any(|line| line.contains(TOKEN)));
}

// ---- A test run in a shell that has telemetry settings ----

/// The test runner (`.cargo/config.toml`) around a failing `marfa` command,
/// started in a parent environment that names a collector and PostHog the way a
/// developer's shell would. `through_runner` false runs the same command with no
/// runner, which is the witness that the settings do reach it.
#[cfg(unix)]
fn failing_command_in_a_shell_with_telemetry(
    collector: &Collector,
    posthog: &Collector,
    through_runner: bool,
) -> Ran {
    use std::os::unix::fs::PermissionsExt;

    let folder = tempfile::Builder::new()
        .prefix("marfa-telemetry-runner-")
        .tempdir()
        .unwrap();
    // The runner limits only the binaries cargo puts in a `deps` folder.
    let deps = folder.path().join("deps");
    std::fs::create_dir(&deps).unwrap();
    let probe = deps.join("probe");
    std::fs::write(
        &probe,
        "#!/bin/sh\nexec \"$MARFA_BIN\" --json items get an-id\n",
    )
    .unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).unwrap();

    let runner = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/test-limits.sh");
    let mut command = if through_runner {
        let mut command = Command::new(runner);
        command.arg(&probe);
        command
    } else {
        Command::new(&probe)
    };
    let started = Instant::now();
    let output = command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("TMPDIR", folder.path())
        .env("MARFA_BIN", env!("CARGO_BIN_EXE_marfa"))
        .env("MARFA_KEYCHAIN", folder.path().join("no-keychain"))
        .env("MARFA_API_URL", faulty())
        .env("MARFA_API_KEY", "marfa_k1_not_a_key")
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", &collector.url)
        .env("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer planted")
        .env("OTEL_SERVICE_NAME", "a-developers-shell")
        .env("MARFA_POSTHOG_HOST", &posthog.url)
        .env("MARFA_POSTHOG_PROJECT_TOKEN", TOKEN)
        .output()
        .unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        took: started.elapsed(),
    }
}

#[cfg(unix)]
#[test]
fn a_test_run_in_a_shell_with_telemetry_settings_sends_nothing_from_a_failing_command() {
    // The witness: with no runner, the same command in the same shell reports
    // the failure to both.
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let bare = failing_command_in_a_shell_with_telemetry(&collector, &posthog, false);
    assert_eq!(bare.code, 3, "{}", bare.stderr);
    assert!(!collector.spans().is_empty(), "the trace was sent");
    assert_eq!(posthog.events().len(), 1, "the exception was sent");

    // Through the runner every test binary runs under, nothing reaches either.
    let collector = Collector::open(Reply::Answer(200));
    let posthog = Collector::open(Reply::Answer(200));
    let ran = failing_command_in_a_shell_with_telemetry(&collector, &posthog, true);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(ran.stderr.contains("\"server\""), "{}", ran.stderr);
    assert_eq!(collector.connections.load(Ordering::SeqCst), 0);
    assert_eq!(posthog.connections.load(Ordering::SeqCst), 0);
    assert!(collector.received().is_empty() && posthog.received().is_empty());
}
