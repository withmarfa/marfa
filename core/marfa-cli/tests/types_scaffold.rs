//! `marfa types scaffold` as a process: it prints a definition from its
//! arguments, and reaches for no server, store, key or keychain.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

/// A server that answers every request and keeps what it was asked.
struct Listener {
    url: String,
    asked: Arc<Mutex<Vec<String>>>,
}

impl Listener {
    fn open() -> Listener {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let kept = Arc::clone(&asked);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let received = door::read_request(&mut stream);
                kept.lock().unwrap().push(received.line);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{}: {}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]",
                    marfa_core::http::CONTRACT_HEADER,
                    marfa_core::contract::CONTRACT_VERSION,
                );
            }
        });
        Listener { url, asked }
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "marfa-types-scaffold-{}-{name}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The binary with no server, key or working copy named, and a keychain that
/// does not exist, so anything that reached for a credential would fail.
fn marfa(args: &[&str], env: &[(&str, &str)]) -> Ran {
    let nowhere = std::env::temp_dir().join(format!(
        "marfa-types-scaffold-no-keychain-{}",
        std::process::id()
    ));
    let mut command = Command::new(env!("CARGO_BIN_EXE_marfa"));
    command
        .env_remove("MARFA_API_URL")
        .env_remove("MARFA_API_KEY")
        .env_remove("MARFA_DB")
        .env("MARFA_KEYCHAIN", nowhere)
        .args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn envelope(stderr: &str) -> Value {
    serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"))
}

const RECIPE: [&str; 12] = [
    "types",
    "scaffold",
    "user.recipe",
    "--field",
    "title:string",
    "--field",
    "servings:integer",
    "--field",
    "effort:enum:easy,hard",
    "--field",
    "sources:array:url",
    "--required",
];

fn recipe(extra: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = RECIPE.iter().map(|word| word.to_string()).collect();
    args.push("title".into());
    args.extend(extra.iter().map(|word| word.to_string()));
    args
}

fn run_recipe(extra: &[&str], env: &[(&str, &str)]) -> Ran {
    let args = recipe(extra);
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    marfa(&words, env)
}

fn expected() -> Value {
    json!({
        "id": "user.recipe",
        "fields": {
            "title": { "type": "string", "required": true },
            "servings": { "type": "integer" },
            "effort": { "type": "enum", "enum_values": ["easy", "hard"] },
            "sources": { "type": "array", "items_type": "url" },
        }
    })
}

#[test]
fn it_prints_the_definition_the_same_way_with_and_without_json() {
    let plain = run_recipe(&[], &[]);
    assert_eq!(plain.code, 0, "{}", plain.stderr);
    assert_eq!(plain.stderr, "");
    assert_eq!(
        serde_json::from_str::<Value>(&plain.stdout).unwrap(),
        expected()
    );
    let json = run_recipe(&["--json"], &[]);
    assert_eq!(json.code, 0, "{}", json.stderr);
    assert_eq!(json.stdout, plain.stdout);
    // The fields keep the order they were given in.
    let names: Vec<&str> = ["title", "servings", "effort", "sources"].to_vec();
    let at: Vec<usize> = names
        .iter()
        .map(|name| plain.stdout.find(&format!("\"{name}\"")).unwrap())
        .collect();
    assert!(
        at.windows(2).all(|pair| pair[0] < pair[1]),
        "{}",
        plain.stdout
    );
}

#[test]
fn it_takes_a_parent_and_a_description() {
    let ran = marfa(
        &[
            "types",
            "scaffold",
            "app.notes.entry",
            "--parent",
            "core.note",
            "--description",
            "An entry",
        ],
        &[],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        serde_json::from_str::<Value>(&ran.stdout).unwrap(),
        json!({
            "id": "app.notes.entry",
            "description": "An entry",
            "parent": "core.note",
            "fields": {}
        })
    );
}

#[test]
fn it_sends_nothing_where_a_command_that_sends_does_when_a_server_is_named() {
    let server = Listener::open();
    let env = [
        ("MARFA_API_URL", server.url.as_str()),
        ("MARFA_API_KEY", "marfa_k1_x"),
    ];
    // Witness: with this server and key a command that sends reaches the
    // server.
    let sent = marfa(&["--json", "types", "list"], &env);
    assert_eq!(sent.code, 0, "{}", sent.stderr);
    assert_eq!(server.asked(), ["GET /types HTTP/1.1"]);

    let scaffolded = run_recipe(&[], &env);
    assert_eq!(scaffolded.code, 0, "{}", scaffolded.stderr);
    assert_eq!(
        serde_json::from_str::<Value>(&scaffolded.stdout).unwrap(),
        expected()
    );
    for refused in [
        marfa(&["types", "scaffold", "core.recipe"], &env),
        marfa(&["types", "scaffold", "user.recipe", "--field", "a"], &env),
        marfa(
            &["--url", &server.url, "types", "scaffold", "user.recipe"],
            &env,
        ),
        marfa(
            &["--key", "marfa_k1_x", "types", "scaffold", "user.recipe"],
            &env,
        ),
    ] {
        assert_ne!(refused.code, 0);
        assert_eq!(refused.stdout, "");
    }
    assert_eq!(server.asked(), ["GET /types HTTP/1.1"]);
}

#[test]
fn an_id_outside_the_grammar_or_under_a_reserved_root_is_refused_with_the_reason() {
    for (id, reason) in [
        ("recipe", "lowercase dotted segments"),
        ("User.recipe", "lowercase dotted segments"),
        ("app.recipe", "exactly three under `app.`"),
        ("keys.recipe", "none under a root Marfa reserves"),
        ("core.recipe", "is Marfa's"),
        ("system.recipe", "is Marfa's"),
        ("marfa.recipe", "is Marfa's"),
    ] {
        let ran = marfa(&["--json", "types", "scaffold", id], &[]);
        assert_eq!(ran.code, 1, "{id}: {}", ran.stderr);
        assert_eq!(ran.stdout, "", "{id}");
        let refusal = envelope(&ran.stderr);
        assert_eq!(refusal["error"]["code"], "invalid", "{id}");
        assert!(
            refusal["error"]["message"]
                .as_str()
                .unwrap()
                .contains(reason),
            "{id}: {}",
            ran.stderr
        );
        assert_eq!(refusal["exit"], 1);
    }
    // Witness: the grammar's edges, which the same command takes.
    for id in [
        "user.recipe",
        "app.notes.entry",
        "acme.recipe",
        "keys-pub.recipe",
    ] {
        let ran = marfa(&["types", "scaffold", id], &[]);
        assert_eq!(ran.code, 0, "{id}: {}", ran.stderr);
    }
}

#[test]
fn a_field_the_server_would_refuse_is_refused_here_with_the_reason() {
    for (field, reason) in [
        ("state:string", "every item has"),
        ("a:blob", "not a field type"),
        ("a:enum", "allowed values"),
        ("a:array", "type of its elements"),
        ("a:array:thumbnail", "array of thumbnails"),
        ("title:thumbnail:x", "third part"),
        ("a", "NAME:TYPE"),
    ] {
        let ran = marfa(
            &[
                "--json",
                "types",
                "scaffold",
                "user.recipe",
                "--field",
                field,
            ],
            &[],
        );
        assert_eq!(ran.stdout, "", "{field}");
        let refusal = envelope(&ran.stderr);
        assert!(
            refusal["error"]["message"]
                .as_str()
                .unwrap()
                .contains(reason),
            "{field}: {}",
            ran.stderr
        );
    }
    let unnamed = marfa(
        &[
            "--json",
            "types",
            "scaffold",
            "user.recipe",
            "--required",
            "title",
        ],
        &[],
    );
    assert_eq!(unnamed.code, 2, "{}", unnamed.stderr);
    assert_eq!(envelope(&unnamed.stderr)["error"]["code"], "usage");
    let twice = marfa(
        &[
            "--json",
            "types",
            "scaffold",
            "user.recipe",
            "--field",
            "a:string",
            "--field",
            "a:number",
        ],
        &[],
    );
    assert_eq!(twice.code, 1, "{}", twice.stderr);
    assert_eq!(envelope(&twice.stderr)["error"]["code"], "invalid");
}

#[test]
fn a_working_copy_declares_what_it_printed_unchanged() {
    let folder = scratch("declare");
    let store = folder.join("store.sqlite");
    let store = store.to_str().unwrap();
    let made = marfa(&["device", "--db", store, "status"], &[]);
    assert_eq!(made.code, 0, "{}", made.stderr);
    let printed = run_recipe(&[], &[]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    let declared = marfa(
        &[
            "device",
            "--db",
            store,
            "types",
            "declare",
            "--definitions",
            &printed.stdout,
        ],
        &[],
    );
    assert_eq!(declared.code, 0, "{}", declared.stderr);
    let held = marfa(
        &["--json", "device", "--db", store, "types", "declared"],
        &[],
    );
    assert_eq!(held.code, 0, "{}", held.stderr);
    let held: Value = serde_json::from_str(&held.stdout).unwrap();
    assert_eq!(held[0]["id"], "user.recipe");
    assert_eq!(held[0]["fields"], expected()["fields"]);
    // Witness: the same copy refuses a definition the command would not print.
    let refused = marfa(
        &[
            "device",
            "--db",
            store,
            "types",
            "declare",
            "--definitions",
            r#"{"id":"core.recipe","fields":{}}"#,
        ],
        &[],
    );
    assert_eq!(refused.code, 1, "{}", refused.stderr);
    std::fs::remove_dir_all(folder).unwrap();
}
