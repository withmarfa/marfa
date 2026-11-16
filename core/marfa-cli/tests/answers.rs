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
    run_with(home, url, args, &[])
}

fn run_with(home: &Path, url: &str, args: &[&str], more: &[(&str, &Path)]) -> Ran {
    let output = quiet::marfa()
        .envs(more.iter().copied())
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
        ran.stderr.contains(
            "no install in the default folder, or run by a service on this machine, serves it"
        ) && ran.stderr.contains("marfa server status --dir <folder>"),
        "no install serves it, so the command names no folder: {}",
        ran.stderr
    );

    // An install in the default folder that serves the address is the one to ask.
    let port = url.rsplit(':').next().unwrap();
    install_serving(&home, port);
    let ran = run(&home, &url, &["items", "list"]);
    assert!(
        ran.stderr.contains("`marfa server status` shows it")
            && ran.stderr.contains("`marfa server start` starts it")
            && !ran.stderr.contains("--dir"),
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
        r#"{"error":{"code":"app_sign_in_required","message":"Only a person signed in to an app, or the private local command, can do this."}}"#,
    )
}

fn install_serving(home: &Path, port: &str) -> std::path::PathBuf {
    install_in(&home.join("marfa-server"), port, true)
}

/// An install in `folder`, with its socket where it is running.
fn install_in(folder: &Path, port: &str, running: bool) -> std::path::PathBuf {
    let socket = folder.join("data").join("control").join("marfa.sock");
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    if running {
        std::fs::write(&socket, "").unwrap();
    }
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
fn a_refusal_no_key_can_mend_names_the_local_command_to_run() {
    let home = scratch("local");
    let door = Door::open(vec![local_only()]);
    let ran = run(&home, &door.url, &["items", "bin", "list"]);
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
            "bin",
            "list",
            "--query",
            "a b",
        ],
    );
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert!(
        ran.stderr.contains(&format!(
            "marfa --socket {} items bin list --query 'a b'",
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

    // A 403 that does not say a person must act gets no such hint.
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

    // An app's sign-in too old for the act is told to sign in again.
    let door = Door::open(vec![Answer::json(
        "401 Unauthorized",
        r#"{"error":{"code":"insufficient_user_authentication","message":"Sign in again.","details":{"max_age":300}}}"#,
    )]);
    let ran = run(&home, &door.url, &["backups", "list"]);
    assert!(
        ran.stderr.contains("sign-in from the last five minutes"),
        "{}",
        ran.stderr
    );
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

/// A launchd agent for a server installed in `folder`, as the installer writes it, where the
/// stand-in root's login agents are kept.
fn register(root: &Path, name: &str, folder: &Path) {
    let agents = root.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(
        agents.join(format!("so.marfa.server.{name}.plist")),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n<key>Label</key>\n<string>so.marfa.server.{name}</string>\n<key>ProgramArguments</key>\n<array>\n<string>/usr/local/bin/marfa</string>\n<string>server</string>\n<string>run</string>\n<string>--dir</string>\n<string>{}</string>\n</array>\n</dict>\n</plist>\n",
            folder.display()
        ),
    )
    .unwrap();
}

#[test]
fn an_install_in_another_folder_is_found_from_the_service_that_runs_it() {
    let home = scratch("elsewhere-home");
    let root = scratch("elsewhere-root");
    let folder = scratch("elsewhere-folder").join("my server");
    std::fs::create_dir_all(&folder).unwrap();
    register(&root, "work", &folder);
    let more = [("MARFA_AUTOSTART_ROOT", root.as_path())];

    // Stopped: the hint names the folder, and each command works as printed.
    let url = closed_port();
    let port = url.rsplit(':').next().unwrap().to_string();
    install_in(&folder, &port, false);
    let ran = run_with(&home, &url, &["items", "list"], &more);
    let quoted = format!("'{}'", folder.display());
    assert!(
        ran.stderr
            .contains(&format!("`marfa server status --dir {quoted}` shows it"))
            && ran
                .stderr
                .contains(&format!("`marfa server start --dir {quoted}` starts it")),
        "{}",
        ran.stderr
    );
    // The witness: the same refusal with no service registered finds nothing.
    let ran = run(&home, &url, &["items", "list"]);
    assert!(
        !ran.stderr.contains(&format!("--dir {quoted}")),
        "{}",
        ran.stderr
    );

    // Running: the refused local command is printed with the real socket.
    let door = Door::open(vec![local_only()]);
    let port = door.url.rsplit(':').next().unwrap().to_string();
    let socket = install_in(&folder, &port, true);
    let ran = run_with(&home, &door.url, &["backups", "list"], &more);
    assert!(
        ran.stderr.contains(&format!(
            "marfa --socket '{}' backups list",
            socket.display()
        )),
        "{}",
        ran.stderr
    );
    let door = Door::open(vec![local_only()]);
    let ran = run(&home, &door.url, &["backups", "list"]);
    assert!(!ran.stderr.contains("--socket '"), "{}", ran.stderr);

    // An install that serves the address with no socket yet says where to start it.
    let door = Door::open(vec![local_only()]);
    let port = door.url.rsplit(':').next().unwrap().to_string();
    install_in(&folder, &port, false);
    let _ = std::fs::remove_file(folder.join("data/control/marfa.sock"));
    let ran = run_with(&home, &door.url, &["backups", "list"], &more);
    assert!(
        ran.stderr.contains("its socket is not there")
            && ran
                .stderr
                .contains(&format!("marfa server start --dir {quoted}")),
        "{}",
        ran.stderr
    );
}
