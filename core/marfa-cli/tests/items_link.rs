//! `marfa items link`: the link a server gives an item, printed on one line or
//! handed to the system's opener, and what it says when the server gave none.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use door::{Answer, Door};
use serde_json::{Value, json};

const ID: &str = "01a1011e-87bd-7ab7-bbab-538453d75381";
const WEB: &str = "https://marfa.example/i/01a1011e-87bd-7ab7-bbab-538453d75381";
const APP: &str =
    "marfa://01a1011e-87bd-7ab7-bbab-538453d75380/01a1011e-87bd-7ab7-bbab-538453d75381";

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("marfa-items-link-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn item(state: &str) -> Value {
    json!({"item": {
        "id": ID, "type": "core.note", "state": state, "version": 1,
        "web_url": WEB, "app_url": APP, "properties": {"title": "Shopping"}
    }})
}

fn run(url: &str, path: Option<&Path>, args: &[&str]) -> Ran {
    let home = scratch("home");
    let mut command = quiet::marfa();
    command
        .env("HOME", &home)
        .env("MARFA_API_URL", url)
        .env("MARFA_API_KEY", "marfa_k1_fixture")
        .env("MARFA_NO_KEYCHAIN", "1")
        .env_remove("MARFA_DB")
        .env_remove("MARFA_PROFILE");
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = command.args(["items", "link"]).args(args).output().unwrap();
    let _ = std::fs::remove_dir_all(home);
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// An opener that writes the address it was given into `witness`, then exits
/// `status`.
fn opener(folder: &Path, status: i32) -> PathBuf {
    let name = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let witness = folder.join("opened");
    let program = folder.join(name);
    std::fs::write(
        &program,
        format!(
            "#!/bin/sh\nprintf '%s' \"$1\" > '{}'\nexit {status}\n",
            witness.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    witness
}

#[test]
fn prints_the_web_url_alone_on_one_line_and_asks_for_the_item_in_any_state() {
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let ran = run(&door.url, None, &[ID]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, format!("{WEB}\n"));
    assert_eq!(ran.stderr, "");
    let asked = door.received();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0].line.starts_with(&format!("GET /items/{ID}?"))
            && asked[0].line.contains("state=any"),
        "{}",
        asked[0].line
    );
}

#[test]
fn prints_the_app_url_with_app() {
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let ran = run(&door.url, None, &[ID, "--app"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, format!("{APP}\n"));
}

#[test]
fn prints_both_links_with_json() {
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let output = {
        let ran = run(&door.url, None, &["--json", ID]);
        assert_eq!(ran.code, 0, "{}", ran.stderr);
        serde_json::from_str::<Value>(&ran.stdout).unwrap()
    };
    assert_eq!(output, json!({"web_url": WEB, "app_url": APP}));
}

#[test]
fn refuses_a_malformed_id_before_sending_any_request() {
    for bad in ["x", "01A1011E-87BD-7AB7-BBAB-538453D75381", "../items", ""] {
        let door = Door::open(Vec::new());
        let ran = run(&door.url, None, &[bad]);
        assert_eq!(ran.code, 1, "{bad}: {}", ran.stderr);
        assert_eq!(ran.stdout, "");
        assert!(ran.stderr.contains("Invalid item ID"), "{}", ran.stderr);
        assert!(door.received().is_empty(), "{bad} was sent");
    }
}

#[test]
fn says_what_items_get_says_of_an_id_no_item_holds() {
    let body = r#"{"error":{"code":"item_not_found","message":"Item not found"}}"#;
    let door = Door::open(vec![Answer::json("404 Not Found", body)]);
    let ran = run(&door.url, None, &[ID]);
    assert_eq!(ran.code, 1);
    assert_eq!(ran.stdout, "");
    assert!(ran.stderr.contains("item_not_found"), "{}", ran.stderr);
}

#[test]
fn prints_the_link_of_an_item_in_the_bin_and_says_so_on_standard_error() {
    let door = Door::open(vec![Answer::json("200 OK", &item("trashed").to_string())]);
    let ran = run(&door.url, None, &[ID]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, format!("{WEB}\n"));
    assert!(ran.stderr.contains("Recently Deleted"), "{}", ran.stderr);
}

#[test]
fn says_a_server_without_item_links_needs_a_newer_release_and_builds_none() {
    for args in [vec![ID], vec![ID, "--app"], vec!["--json", ID]] {
        let mut old = item("active");
        old["item"].as_object_mut().unwrap().remove("web_url");
        old["item"].as_object_mut().unwrap().remove("app_url");
        let door = Door::open(vec![Answer::json("200 OK", &old.to_string())]);
        let ran = run(&door.url, None, &args);
        assert_eq!(ran.code, 1, "{args:?}: {}", ran.stderr);
        assert_eq!(ran.stdout, "");
        assert!(ran.stderr.contains("newer release"), "{}", ran.stderr);
    }
}

#[test]
fn prints_a_localhost_link_as_the_server_gave_it() {
    let mut item = item("active");
    item["item"]["web_url"] = json!(format!("http://localhost:8600/i/{ID}"));
    let door = Door::open(vec![Answer::json("200 OK", &item.to_string())]);
    let ran = run(&door.url, None, &[ID]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, format!("http://localhost:8600/i/{ID}\n"));
}

#[test]
fn prints_nothing_the_server_gave_that_is_not_an_address_in_its_scheme() {
    for (field, value, args) in [
        ("web_url", "file:///etc/passwd", vec![ID]),
        ("web_url", "javascript:alert(1)", vec![ID]),
        ("web_url", "https://marfa.example/i/x\u{1b}[2J", vec![ID]),
        ("app_url", "https://marfa.example/i/x", vec![ID, "--app"]),
    ] {
        let mut item = item("active");
        item["item"][field] = json!(value);
        let door = Door::open(vec![Answer::json("200 OK", &item.to_string())]);
        let ran = run(&door.url, None, &args);
        assert_eq!(ran.code, 1, "{value:?}: {}", ran.stderr);
        assert_eq!(ran.stdout, "");
        assert!(ran.stderr.contains("other than"), "{}", ran.stderr);
    }
}

#[test]
fn opens_the_web_url_and_prints_nothing_with_open() {
    let folder = scratch("opener");
    let witness = opener(&folder, 0);
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let ran = run(&door.url, Some(&folder), &[ID, "--open"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, "");
    assert_eq!(std::fs::read_to_string(witness).unwrap(), WEB);
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn opens_the_marfa_link_with_app_and_open() {
    let folder = scratch("opener-app");
    let witness = opener(&folder, 0);
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let ran = run(&door.url, Some(&folder), &[ID, "--app", "--open"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout, "");
    assert_eq!(std::fs::read_to_string(witness).unwrap(), APP);
    std::fs::remove_dir_all(folder).unwrap();
}

#[test]
fn prints_the_link_and_fails_where_the_opener_refuses_or_is_absent() {
    let folder = scratch("opener-refuses");
    let witness = opener(&folder, 1);
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let refused = run(&door.url, Some(&folder), &[ID, "--open"]);
    assert_eq!(std::fs::read_to_string(witness).unwrap(), WEB);
    let empty = scratch("no-opener");
    let door = Door::open(vec![Answer::json("200 OK", &item("active").to_string())]);
    let absent = run(&door.url, Some(&empty), &[ID, "--open"]);
    for ran in [refused, absent] {
        assert_eq!(ran.code, 3, "{}", ran.stderr);
        assert_eq!(ran.stdout, format!("{WEB}\n"));
        assert!(ran.stderr.contains("could not open"), "{}", ran.stderr);
    }
    std::fs::remove_dir_all(folder).unwrap();
    std::fs::remove_dir_all(empty).unwrap();
}
