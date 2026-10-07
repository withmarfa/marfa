//! `marfa docs` as a process: the built binary against a scripted site, with
//! no server, no store and a keychain that does not exist, so anything that
//! reached for a credential would fail.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

use std::process::Command;

use door::{Answer, Door};

fn answer(status: &'static str, content_type: &'static str, body: &str) -> Answer {
    Answer {
        status,
        content_type,
        body: body.to_string(),
        headers: Vec::new(),
    }
}

const HITS: &str = r#"{"hits":[{"title":"Files","url":"https://docs.marfa.so/get-started/files","snippets":["Keep  files\nin a folder.","second"]}]}"#;
const PAGES: &str = r#"{"pages":[{"title":"Files","url":"https://docs.marfa.so/get-started/files","description":"Keep files.","breadcrumbs":["Get started"]},{"title":"Bare","url":"https://docs.marfa.so/bare","description":null,"breadcrumbs":[]}]}"#;

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

fn command(site: &str, args: &[&str]) -> Command {
    let nowhere =
        std::env::temp_dir().join(format!("marfa-docs-no-keychain-{}", std::process::id()));
    let mut command = Command::new(env!("CARGO_BIN_EXE_marfa"));
    command
        .env_remove("MARFA_API_URL")
        .env_remove("MARFA_API_KEY")
        .env_remove("MARFA_DB")
        .env("MARFA_KEYCHAIN", nowhere)
        .env("MARFA_DOCS_URL", site)
        .args(args);
    command
}

fn marfa(site: &str, args: &[&str]) -> Ran {
    let output = command(site, args).output().unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn envelope(stderr: &str) -> serde_json::Value {
    serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"))
}

fn closed_port() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

#[test]
fn a_search_prints_each_hit_and_its_first_snippet_or_the_sites_json() {
    let door = Door::open(vec![
        answer("200 OK", "application/json", HITS),
        answer("200 OK", "application/json", HITS),
    ]);
    let plain = marfa(&door.url, &["docs", "search", "keep files", "--limit", "3"]);
    assert_eq!(plain.code, 0, "{}", plain.stderr);
    assert_eq!(
        plain.stdout,
        "Files  https://docs.marfa.so/get-started/files\n  Keep files in a folder.\n"
    );
    let json = marfa(&door.url, &["--json", "docs", "search", "keep files"]);
    assert_eq!(json.code, 0, "{}", json.stderr);
    let printed: serde_json::Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(
        printed,
        serde_json::from_str::<serde_json::Value>(HITS).unwrap()
    );
    let received = door.received();
    assert_eq!(received[0].path(), "/api/docs/search?q=keep+files&limit=3");
    assert_eq!(received[1].path(), "/api/docs/search?q=keep+files");
    assert!(received.iter().all(|r| r.header("authorization").is_none()));
}

#[test]
fn the_topics_print_their_descriptions_or_the_sites_json() {
    let door = Door::open(vec![
        answer("200 OK", "application/json", PAGES),
        answer("200 OK", "application/json", PAGES),
    ]);
    let plain = marfa(&door.url, &["docs", "topics"]);
    assert_eq!(plain.code, 0, "{}", plain.stderr);
    assert_eq!(
        plain.stdout,
        "Files  https://docs.marfa.so/get-started/files\n  Keep files.\nBare  https://docs.marfa.so/bare\n"
    );
    let json = marfa(&door.url, &["docs", "topics", "--json"]);
    let printed: serde_json::Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(
        printed,
        serde_json::from_str::<serde_json::Value>(PAGES).unwrap()
    );
    let received = door.received();
    assert!(received.iter().all(|r| r.path() == "/api/docs/topics"));
}

#[test]
fn a_page_prints_exactly_as_served_in_every_form_it_can_be_named() {
    let body = "# Files\n\nKeep files.\n\n\n";
    let names = [
        "get-started/files",
        "/get-started/files",
        "get-started/files.md",
        "https://docs.marfa.so/get-started/files",
        "/docs/get-started/files",
    ];
    let door = Door::open(
        (0..names.len() + 1)
            .map(|_| answer("200 OK", "text/markdown; charset=utf-8", body))
            .collect(),
    );
    for name in names {
        let ran = marfa(&door.url, &["docs", name]);
        assert_eq!(ran.code, 0, "{name}: {}", ran.stderr);
        assert_eq!(ran.stdout, body, "{name}");
    }
    let json = marfa(&door.url, &["--json", "docs", "get-started/files"]);
    let record: serde_json::Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(
        record,
        serde_json::json!({
            "path": "get-started/files",
            "url": format!("{}/get-started/files.md", door.url),
            "markdown": body,
        })
    );
    let received = door.received();
    assert!(received.iter().all(|r| r.path() == "/get-started/files.md"));
    assert!(received.iter().all(|r| r.header("authorization").is_none()));
}

#[test]
fn a_missing_page_leaves_by_one_naming_the_page() {
    let door = Door::open(vec![
        answer("404 Not Found", "text/plain", "not found"),
        answer("404 Not Found", "text/plain", "not found"),
    ]);
    let plain = marfa(&door.url, &["docs", "nope/page"]);
    assert_eq!(plain.code, 1);
    assert_eq!(plain.stdout, "");
    assert!(
        plain.stderr.starts_with("marfa: no docs page at nope/page"),
        "{}",
        plain.stderr
    );
    let json = marfa(&door.url, &["--json", "docs", "nope/page"]);
    assert_eq!(json.code, 1);
    assert_eq!(json.stdout, "");
    let envelope = envelope(&json.stderr);
    assert_eq!(envelope["error"]["code"], "docs_page_not_found");
    assert_eq!(envelope["exit"], 1);
    door.received();
}

#[test]
fn a_site_that_cannot_be_reached_or_faults_leaves_by_three_naming_the_address() {
    let address = closed_port();
    let ran = marfa(&address, &["--json", "docs", "topics"]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert_eq!(ran.stdout, "");
    let envelope = envelope(&ran.stderr);
    assert_eq!(envelope["error"]["code"], "docs_unreachable");
    assert!(
        envelope["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&address)
    );

    let door = Door::open(vec![answer(
        "503 Service Unavailable",
        "text/plain",
        "down",
    )]);
    let ran = marfa(&door.url, &["--json", "docs", "search", "x"]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert_eq!(envelope_code(&ran.stderr), "docs_unreachable");
    door.received();
}

fn envelope_code(stderr: &str) -> String {
    envelope(stderr)["error"]["code"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn an_answer_that_is_not_the_json_expected_leaves_by_three() {
    let door = Door::open(vec![answer("200 OK", "application/json", "<html>")]);
    let ran = marfa(&door.url, &["--json", "docs", "search", "x"]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert_eq!(envelope_code(&ran.stderr), "decoding");
    door.received();
}

/// A site that records whether anything arrived.
struct Silent {
    url: String,
    listener: std::net::TcpListener,
}

impl Silent {
    fn open() -> Silent {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        Silent {
            url: format!("http://{}", listener.local_addr().unwrap()),
            listener,
        }
    }

    fn was_asked(&self) -> bool {
        match self.listener.accept() {
            Ok(_) => true,
            Err(error) => {
                assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
                false
            }
        }
    }
}

#[test]
fn a_page_served_as_html_is_never_printed() {
    let door = Door::open(vec![
        answer(
            "200 OK",
            "text/html; charset=utf-8",
            "<html>catch-all</html>",
        ),
        answer("200 OK", "application/json", "<html>catch-all</html>"),
    ]);
    for args in [&["docs", "files"][..], &["docs", "topics"][..]] {
        let ran = marfa(&door.url, &[&["--json"], args].concat());
        assert_eq!(ran.code, 3, "{args:?}: {}", ran.stderr);
        assert_eq!(ran.stdout, "");
        assert_eq!(envelope_code(&ran.stderr), "decoding");
        assert!(!ran.stderr.contains("catch-all"), "{}", ran.stderr);
    }
    door.received();
}

#[test]
fn the_command_line_is_checked_before_anything_is_sent() {
    let site = Silent::open();
    for (args, code, name) in [
        (&["docs"][..], 2, None),
        (&["docs", "search"][..], 2, None),
        (&["docs", "search", ""][..], 2, None),
        (&["docs", "search", "x", "--limit", "0"][..], 2, None),
        (&["docs", "search", "x", "--limit", "51"][..], 2, None),
        (&["docs", "search", "x", "--limit", "many"][..], 2, None),
        (
            &["--key", "marfa_k1_x", "docs", "topics"][..],
            2,
            Some("usage"),
        ),
        (&["--key", "marfa_k1_x", "docs", "x"][..], 2, Some("usage")),
        (
            &["--url", "http://127.0.0.1:1", "docs", "topics"][..],
            2,
            Some("usage"),
        ),
        (&["docs", "../outside"][..], 1, Some("invalid")),
        (&["docs", "a b"][..], 1, Some("invalid")),
        (&["docs", "a/%2e%2e/b"][..], 1, Some("invalid")),
        (&["docs", "/"][..], 1, Some("invalid")),
    ] {
        let mut with_json = vec!["--json"];
        with_json.extend(args);
        let ran = marfa(&site.url, &with_json);
        assert_eq!(ran.code, code, "{args:?}: {}", ran.stderr);
        assert_eq!(ran.stdout, "", "{args:?}");
        if let Some(name) = name {
            assert_eq!(envelope_code(&ran.stderr), name, "{args:?}");
        }
    }
    assert!(!site.was_asked(), "a request reached the site");
    // The witness: the same site is reached when the command line is right.
    // It never answers, so the command is stopped once it has asked.
    let mut waiting = command(&site.url, &["docs", "topics"]).spawn().unwrap();
    let started = std::time::Instant::now();
    while !site.was_asked() {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the site was never reached"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    waiting.kill().unwrap();
    waiting.wait().unwrap();
    for address in ["not a url", "ftp://127.0.0.1/docs", "127.0.0.1:8600"] {
        let ran = marfa(address, &["--json", "docs", "topics"]);
        assert_eq!(ran.code, 1, "{address}: {}", ran.stderr);
        assert_eq!(ran.stdout, "");
        assert_eq!(envelope_code(&ran.stderr), "invalid", "{address}");
    }
    // The limit's bounds are held by the parser, so the edges are taken.
    let door = Door::open(vec![
        answer("200 OK", "application/json", HITS),
        answer("200 OK", "application/json", HITS),
    ]);
    for limit in ["1", "50"] {
        assert_eq!(
            marfa(&door.url, &["docs", "search", "x", "--limit", limit]).code,
            0
        );
    }
    let received = door.received();
    assert_eq!(received[0].path(), "/api/docs/search?q=x&limit=1");
    assert_eq!(received[1].path(), "/api/docs/search?q=x&limit=50");
}

#[test]
fn an_empty_address_variable_takes_the_public_site() {
    // Nothing reaches the public site here: the check is that the empty
    // variable is not refused as an address.
    let ran = marfa("", &["--json", "docs", "../outside"]);
    assert_eq!(ran.code, 1);
    assert_eq!(envelope_code(&ran.stderr), "invalid");
    assert!(
        envelope(&ran.stderr)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not a docs page")
    );
}
