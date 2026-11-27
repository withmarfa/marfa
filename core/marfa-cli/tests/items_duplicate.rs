//! Duplicate prompts for `marfa items add` under a pseudo-terminal.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

#[allow(dead_code)]
#[path = "support/terminal.rs"]
mod terminal;

use std::process::Command;
use std::sync::Mutex;

use door::{Answer, Door};
use tempfile::TempDir;

const BYTES: &[u8] = b"harbor bytes";
// `printf 'harbor bytes' | shasum -a 256`
const HASH: &str = "sha256:72dfc57e7ecdfd0271155ac4bbf67d3cdd46f04a95334d785f2ef172aa45e265";

static SPAWNING: Mutex<()> = Mutex::new(());

fn held() -> Answer {
    Answer::json(
        "200 OK",
        &format!(
            r#"{{"data":[{{"hash":"{HASH}","items":[{{"id":"old-item","type":"core.file","title":"Harbor"}}],"more":false}}]}}"#
        ),
    )
}

fn upload_and_item() -> Vec<Answer> {
    vec![
        Answer::json(
            "201 Created",
            &format!(r#"{{"hash":"{HASH}","mime_type":"image/png","size_bytes":12}}"#),
        ),
        Answer::json(
            "201 Created",
            r#"{"item":{"id":"new-item","type":"core.file.image"}}"#,
        ),
    ]
}

fn marfa(url: &str, extra: &[&str]) -> (Command, TempDir) {
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join("harbor.png");
    std::fs::write(&file, BYTES).unwrap();
    let mut command = quiet::marfa();
    command
        .env("HOME", home.path())
        .env("MARFA_API_URL", url)
        .env("MARFA_API_KEY", "marfa_k1_fixture")
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("TERM", "xterm-256color")
        .env_remove("NO_COLOR")
        .env_remove("MARFA_DB")
        .env_remove("MARFA_PROFILE")
        .args(["items", "add"])
        .args(extra)
        .arg(&file);
    (command, home)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn at_a_terminal_a_match_is_named_and_yes_adds_it_anyway() {
    let mut answers = vec![held()];
    answers.extend(upload_and_item());
    let door = Door::open(answers);
    let (mut command, _home) = marfa(&door.url, &[]);
    let ran = terminal::run_typed(&mut command, "y\n", &SPAWNING);
    let seen = text(&ran.stderr);
    assert_eq!(ran.code, 0, "{seen}");
    assert!(seen.contains("Harbor (core.file, old-item)"), "{seen}");
    assert!(seen.contains("Add it anyway? [y/N]"), "{seen}");
    assert!(text(&ran.stdout).contains("added"), "{}", text(&ran.stdout));
    let received = door.received();
    assert_eq!(received.len(), 3);
    assert_eq!(received[0].path(), "/items/blobs");
    assert_eq!(received[1].path(), "/blobs");
    assert_eq!(received[2].path(), "/items");
}

#[test]
fn at_a_terminal_anything_but_yes_adds_nothing_and_names_the_item_that_holds_it() {
    for (name, typed) in [("no", "n\n"), ("empty", "\n"), ("other", "maybe\n")] {
        let door = Door::open(vec![held()]);
        let (mut command, _home) = marfa(&door.url, &[]);
        let ran = terminal::run_typed(&mut command, typed, &SPAWNING);
        assert_eq!(ran.code, 0, "{name}: {}", text(&ran.stderr));
        let said = text(&ran.stdout);
        assert!(said.contains("not added"), "{name}: {said}");
        assert!(said.contains("old-item"), "{name}: {said}");
        assert_eq!(door.received().len(), 1, "{name}: something was uploaded");
    }
}

#[test]
fn json_at_a_terminal_never_asks_and_carries_the_matches() {
    let mut answers = vec![held()];
    answers.extend(upload_and_item());
    let door = Door::open(answers);
    let (mut command, _home) = marfa(&door.url, &[]);
    command.arg("--json");
    let ran = terminal::run_typed(&mut command, "", &SPAWNING);
    let seen = text(&ran.stderr);
    assert_eq!(ran.code, 0, "{seen}");
    assert!(!seen.contains("[y/N]"), "{seen}");
    assert!(seen.contains("already in Marfa as"), "{seen}");
    assert!(!seen.contains('\u{1b}'), "{seen:?}");
    let out: serde_json::Value = serde_json::from_str(&text(&ran.stdout)).unwrap();
    assert_eq!(out["duplicates"]["items"][0]["id"], "old-item");
    assert_eq!(out["duplicates"]["more"], false);
    assert_eq!(out["item"]["id"], "new-item");
    assert_eq!(door.received().len(), 3);
}
