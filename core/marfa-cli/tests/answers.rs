//! What the command line tells a person is what the server answered: an upload
//! refused before its body was read, a connection nothing answered, a refusal
//! only the private local command can mend, and a sign-in address change that
//! waits for a confirmation.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;

use door::{Answer, Door};

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("marfa-answers-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn run(home: &Path, url: &str, args: &[&str]) -> Ran {
    let output = quiet::marfa()
        .env("HOME", home)
        .env("MARFA_API_URL", url)
        .env("MARFA_API_KEY", "marfa_k1_fixture")
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_KEYCHAIN", home.join("none"))
        .env_remove("MARFA_DB")
        .env_remove("MARFA_PROFILE")
        .args(args)
        .output()
        .unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// A server that reads a request's head, then answers `answer` (or nothing)
/// and closes, as one does that refuses from the headers alone.
fn answers_from_the_head(answer: Option<String>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut head = Vec::new();
        let mut chunk = [0u8; 1024];
        while !head.windows(4).any(|window| window == b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => head.extend_from_slice(&chunk[..read]),
            }
        }
        if let Some(answer) = answer {
            let _ = stream.write_all(answer.as_bytes());
        }
    });
    url
}

fn refusal(status: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{}: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        marfa_core::http::CONTRACT_HEADER,
        marfa_core::contract::CONTRACT_VERSION,
        body.len()
    )
}

fn big_file(home: &Path) -> std::path::PathBuf {
    let path = home.join("big.bin");
    std::fs::write(&path, vec![7u8; 8 * 1024 * 1024]).unwrap();
    path
}

#[test]
fn an_upload_refused_before_its_body_is_read_reports_the_refusal() {
    let home = scratch("upload");
    let file = big_file(&home);
    let body = r#"{"error":{"code":"insufficient_storage","message":"The volume the blobs are kept on has no room for the upload.","details":{"reserve_bytes":134217728,"available_bytes":1515520}}}"#;
    let url = answers_from_the_head(Some(refusal("507 Insufficient Storage", body)));
    let ran = run(&home, &url, &["items", "add", file.to_str().unwrap()]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(
        ran.stderr.contains("507 insufficient_storage") && ran.stderr.contains("available_bytes"),
        "{}",
        ran.stderr
    );
    assert!(!ran.stderr.contains("Broken pipe"), "{}", ran.stderr);

    let url = answers_from_the_head(Some(refusal("507 Insufficient Storage", body)));
    let ran = run(
        &home,
        &url,
        &["--json", "items", "add", file.to_str().unwrap()],
    );
    let envelope: serde_json::Value =
        serde_json::from_str(ran.stderr.lines().last().unwrap()).unwrap();
    assert_eq!(envelope["error"]["server"]["status"], 507);
    assert_eq!(envelope["error"]["server"]["code"], "insufficient_storage");
    assert_eq!(
        envelope["error"]["server"]["details"]["available_bytes"],
        1515520
    );
    assert_eq!(envelope["exit"], 3);

    let unauthorized =
        r#"{"error":{"code":"unauthorized","message":"A valid credential is required."}}"#;
    let url = answers_from_the_head(Some(refusal("401 Unauthorized", unauthorized)));
    let ran = run(&home, &url, &["items", "add", file.to_str().unwrap()]);
    assert_eq!(ran.code, 5, "{}", ran.stderr);
    assert!(ran.stderr.contains("401 unauthorized"), "{}", ran.stderr);
}

#[test]
fn an_upload_cut_off_with_no_answer_still_says_the_network_failed() {
    let home = scratch("cut-off");
    let file = big_file(&home);
    let url = answers_from_the_head(None);
    let ran = run(&home, &url, &["items", "add", file.to_str().unwrap()]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(ran.stderr.contains("request to"), "{}", ran.stderr);
    assert!(ran.stderr.contains("failed"), "{}", ran.stderr);
    assert!(!ran.stderr.contains("the server refused"), "{}", ran.stderr);
}

fn closed_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

#[test]
fn a_refused_connection_to_this_machine_asks_whether_the_server_runs() {
    let home = scratch("refused");
    let url = closed_port();
    let ran = run(&home, &url, &["items", "list"]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(
        ran.stderr.contains("the connection was refused") && !ran.stderr.contains("os error"),
        "{}",
        ran.stderr
    );
    assert!(
        ran.stderr
            .contains("Is the server running? `marfa server status`"),
        "{}",
        ran.stderr
    );

    let ran = run(&home, &url, &["--json", "items", "list"]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(
        !ran.stderr.contains("marfa server status"),
        "a hint is for a person, not for --json: {}",
        ran.stderr
    );
    let envelope: serde_json::Value =
        serde_json::from_str(ran.stderr.lines().last().unwrap()).unwrap();
    assert_eq!(envelope["error"]["code"], "network");

    // The witness: a server that answered and then hung up is not "not running".
    let url = answers_from_the_head(None);
    let ran = run(&home, &url, &["items", "list"]);
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(
        !ran.stderr.contains("marfa server status"),
        "{}",
        ran.stderr
    );
}

fn local_only() -> Answer {
    Answer::json(
        "403 Forbidden",
        r#"{"error":{"code":"forbidden","message":"Only the private local command can do this.","details":{"needs":"local"}}}"#,
    )
}

fn install_serving(home: &Path, port: &str) -> std::path::PathBuf {
    let folder = home.join("marfa-server");
    let socket = folder.join("data").join("control").join("marfa.sock");
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    std::fs::write(&socket, "").unwrap();
    std::fs::write(
        folder.join(".env"),
        format!(
            "MARFA_NAME=marfa\nMARFA_RELEASE=0.0.1\nMARFA_PORT={port}\nMARFA_ACCESS=local\nMARFA_RUNTIME=native\nMARFA_SERVICE=launchd\n"
        ),
    )
    .unwrap();
    socket
}

#[test]
fn a_refusal_only_the_local_command_can_mend_names_the_command_to_run() {
    let home = scratch("local");
    let door = Door::open(vec![local_only()]);
    let ran = run(&home, &door.url, &["items", "trash", "list"]);
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(
        ran.stderr.contains("server's own machine") && !ran.stderr.contains("marfa --socket /"),
        "no install here, so no command: {}",
        ran.stderr
    );

    let home = scratch("local-install");
    let door = Door::open(vec![local_only()]);
    let port = door.url.rsplit(':').next().unwrap().to_string();
    let socket = install_serving(&home, &port);
    let ran = run(
        &home,
        &door.url,
        &[
            "--key",
            "marfa_k1_fixture",
            "items",
            "trash",
            "list",
            "--q",
            "a b",
        ],
    );
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(
        ran.stderr.contains(&format!(
            "marfa --socket {} items trash list --q 'a b'",
            socket.display()
        )),
        "{}",
        ran.stderr
    );
    assert!(!ran.stderr.contains("--key"), "{}", ran.stderr);

    // An install on another port is not the server that refused.
    let home = scratch("local-elsewhere");
    install_serving(&home, "1");
    let door = Door::open(vec![local_only()]);
    let ran = run(&home, &door.url, &["backups", "list"]);
    assert!(
        ran.stderr.contains("server's own machine") && !ran.stderr.contains("marfa --socket /"),
        "{}",
        ran.stderr
    );

    // A 403 that does not say it needs the local command gets no such hint.
    let home = scratch("local-other");
    install_serving(&home, &port);
    let door = Door::open(vec![Answer::json(
        "403 Forbidden",
        r#"{"error":{"code":"forbidden","message":"No."}}"#,
    )]);
    let ran = run(&home, &door.url, &["backups", "list"]);
    assert!(!ran.stderr.contains("--socket"), "{}", ran.stderr);

    let door = Door::open(vec![local_only()]);
    let ran = run(&home, &door.url, &["--json", "backups", "list"]);
    assert!(!ran.stderr.contains("--socket"), "{}", ran.stderr);
}

#[test]
fn a_sign_in_address_change_names_its_consequences_and_the_flag_that_confirms_it() {
    let home = scratch("address");
    let unconfirmed = r#"{"error":{"code":"sign_in_address_change_unconfirmed","message":"Changing the sign-in address needs your confirmation.","details":{"consequences":[{"code":"sessions_end","sentence":"Everyone signed in is signed out.","count":3}]}}}"#;
    let body = r#"{"sign_in_address":"https://moved.example"}"#;
    let door = Door::open(vec![
        Answer::json("409 Conflict", unconfirmed),
        Answer::json("200 OK", "{}"),
    ]);
    let ran = run(&home, &door.url, &["config", "update", "--body", body]);
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(
        ran.stderr.contains("Everyone signed in is signed out.")
            && ran.stderr.contains("--confirm-address-change"),
        "{}",
        ran.stderr
    );
    let ran = run(
        &home,
        &door.url,
        &[
            "config",
            "update",
            "--body",
            body,
            "--confirm-address-change",
        ],
    );
    assert_eq!(ran.code, 0, "{}{}", ran.stdout, ran.stderr);
    let sent = door.received();
    assert!(!sent[0].body.contains("confirm_sign_in_address_change"));
    let confirmed: serde_json::Value = serde_json::from_str(&sent[1].body).unwrap();
    assert_eq!(confirmed["confirm_sign_in_address_change"], true);
    assert_eq!(confirmed["sign_in_address"], "https://moved.example");
    assert_eq!(sent[1].method(), "PATCH");

    let ran = run(
        &home,
        "http://127.0.0.1:1",
        &[
            "config",
            "update",
            "--body",
            "[]",
            "--confirm-address-change",
        ],
    );
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(ran.stderr.contains("JSON object"), "{}", ran.stderr);
}
