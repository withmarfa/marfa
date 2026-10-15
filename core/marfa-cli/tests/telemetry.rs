//! The `marfa` binary as a process, reporting to a collector this file runs.
//! No keychain is read: every command is given both a server and a key, or
//! needs neither.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

/// Planted in every place a person's data could come from. None may reach a
/// collector.
const SECRET: &str = "s3cr3t-planted-value";

#[derive(Clone, Copy)]
enum Reply {
    Answer(u16),
    /// Takes the connection and the request and says nothing.
    Silence,
    Redirect,
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

fn scratch(name: &str) -> PathBuf {
    static RUNS: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "marfa-telemetry-{}-{name}-{}",
        std::process::id(),
        RUNS.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn closed_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

/// A command with a server that is not there and a key that is no one's, so
/// that nothing reads a keychain.
fn command(env: &[(&str, &str)], args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_marfa"));
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("MARFA_KEYCHAIN", scratch("keychain").join("none"))
        .env("MARFA_API_URL", closed_port())
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
fn store() -> PathBuf {
    let path = scratch("store").join("copy.sqlite");
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
    let down = run(&env, &["--json", "items", "get", "an-id"]);
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

    let short = report(&[("OTEL_EXPORTER_OTLP_TIMEOUT", "600")]);
    assert_eq!(
        (short.code, &short.stdout, &short.stderr),
        (without.code, &without.stdout, &without.stderr)
    );
    // The witness that it waited: the run reached the collector, and took the timeout.
    assert_eq!(silent.received().len(), 1);
    assert!(short.took >= Duration::from_millis(550), "{:?}", short.took);
    assert!(short.took < Duration::from_secs(3), "{:?}", short.took);
    assert!(
        without.took < Duration::from_millis(500),
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
    assert!(default.took < Duration::from_secs(6), "{:?}", default.took);
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
        let with = run(&report_to(&collector, &[]), &args);
        assert_eq!(with.code, without.code);
        assert_eq!(with.stdout, without.stdout);
        assert_eq!(with.stderr, without.stderr);
        assert!(with.took < Duration::from_secs(3), "{:?}", with.took);
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
        // With --json, standard error stays one JSON object: no line at all.
        let ran = run(&[(variable, bad.as_str())], &args);
        assert_eq!(ran.code, plain.code);
        assert_eq!(ran.stdout, plain.stdout);
        assert_eq!(ran.stderr, plain.stderr);
        // Without it, one line that names the variable and not its value.
        let words = ["device", "--db", store.to_str().unwrap(), "catch-up"];
        let plain_words = run(&[], &words);
        let said = run(&[(variable, bad.as_str())], &words);
        assert_eq!(said.code, plain_words.code);
        assert_eq!(said.stdout, plain_words.stdout);
        assert_eq!(
            said.stderr,
            format!(
                "marfa: {variable} is not an http or https address, so this run sends no telemetry\n{}",
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

#[test]
fn an_interrupt_ends_a_stream_that_runs_until_stopped_after_its_trace_is_sent() {
    let (server, stop) = event_stream();
    let collector = Collector::open(Reply::Answer(200));
    let mut child = command(
        &report_to(&collector, &[("MARFA_API_URL", server.as_str())]),
        &["events"],
    )
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
    assert!(
        collector.received().is_empty(),
        "nothing is sent before the run ends"
    );

    // SAFETY: signals the child this test started.
    assert_eq!(unsafe { libc::kill(child.id() as i32, libc::SIGINT) }, 0);
    let status = child.wait().unwrap();
    guard.store(true, Ordering::SeqCst);
    stop.store(true, Ordering::SeqCst);
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
    let store = scratch("hydrate").join("copy.sqlite");
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
