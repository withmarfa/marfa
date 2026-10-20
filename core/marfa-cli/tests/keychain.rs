//! macOS alone has keychain files.
#![cfg(target_os = "macos")]

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;
mod isolated;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{Receiver, channel};

use door::{Answer, Door};
use isolated::Isolated;

fn server() -> (String, Receiver<Option<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (sent, bearers) = channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut request = [0u8; 8192];
            let read = stream.read(&mut request).unwrap_or(0);
            let head = String::from_utf8_lossy(&request[..read]).into_owned();
            let bearer = head.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then(|| value.trim().trim_start_matches("Bearer ").to_string())
            });
            let _ = sent.send(bearer);
            let body = r#"{"data":[]}"#;
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nx-marfa-contract: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                marfa_core::contract::CONTRACT_VERSION,
                body.len()
            );
        }
    });
    (url, bearers)
}

/// Writes nothing, so a binary that ignores `MARFA_KEYCHAIN` fails here
/// before any test keeps a key in the person's keychain.
fn the_named_keychain_is_the_one_used(keychain: &Isolated, url: &str) {
    let forgot = keychain
        .marfa()
        .env("MARFA_KEYCHAIN", keychain.missing())
        .args(["--json", "--url", url, "keys", "forget"])
        .output()
        .unwrap();
    assert_eq!(
        forgot.status.code(),
        Some(4),
        "the binary did not keep to MARFA_KEYCHAIN: {}",
        String::from_utf8_lossy(&forgot.stderr)
    );
    assert!(String::from_utf8_lossy(&forgot.stderr).contains("no_keychain"));
}

#[test]
fn a_kept_key_lands_in_the_runs_keychain_and_never_the_persons() {
    let keychain = Isolated::new("keychain");
    let (url, _) = server();
    the_named_keychain_is_the_one_used(&keychain, &url);
    let kept = keychain
        .marfa()
        .args([
            "--json",
            "--url",
            &url,
            "--key",
            "marfa_k1_kept",
            "keys",
            "keep",
        ])
        .output()
        .unwrap();
    assert!(
        kept.status.success(),
        "{}",
        String::from_utf8_lossy(&kept.stderr)
    );
    assert!(
        keychain.holds(&url),
        "keys keep kept nothing in the named keychain"
    );
    assert!(keychain.holds("current"));
    assert!(
        !isolated::the_users_keychains_hold(&url),
        "keys keep reached the person's keychain"
    );

    let forgot = keychain
        .marfa()
        .args(["--json", "--url", &url, "keys", "forget"])
        .output()
        .unwrap();
    assert!(
        forgot.status.success(),
        "{}",
        String::from_utf8_lossy(&forgot.stderr)
    );
    assert!(!keychain.holds(&url));
    assert!(!keychain.holds("current"));
}

#[test]
fn a_named_keychain_keeps_its_credential_locks_beside_it_and_none_in_the_home() {
    let keychain = Isolated::new("locks");
    let origin = format!("https://locks-{}.invalid", std::process::id());
    let forgot = keychain
        .marfa()
        .args(["--json", "--url", &origin, "keys", "forget"])
        .output()
        .unwrap();
    assert!(
        forgot.status.success(),
        "{}",
        String::from_utf8_lossy(&forgot.stderr)
    );
    let mut beside = keychain.keychain_path().into_os_string();
    beside.push(".locks");
    let taken: Vec<_> = std::fs::read_dir(&beside)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    // The witness: `keys forget` took one lock, beside the keychain it names.
    assert_eq!(taken.len(), 1, "{taken:?}");
    assert!(
        !users_home()
            .join(".marfa-credential-locks")
            .join(&taken[0])
            .exists(),
        "a run under a named keychain took a lock in the home directory"
    );
}

/// From the operating system's record, as the binary finds it, not `HOME`.
fn users_home() -> std::path::PathBuf {
    use std::os::unix::ffi::OsStrExt;
    // Safe: the record is copied out before any other call can replace it.
    unsafe {
        let entry = libc::getpwuid(libc::geteuid());
        assert!(!entry.is_null() && !(*entry).pw_dir.is_null());
        std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
            std::ffi::CStr::from_ptr((*entry).pw_dir).to_bytes(),
        ))
    }
}

#[test]
fn the_environment_wins_over_a_kept_key() {
    let keychain = Isolated::new("environment");
    let (url, bearers) = server();
    the_named_keychain_is_the_one_used(&keychain, &url);
    let kept = keychain
        .marfa()
        .args([
            "--json",
            "--url",
            &url,
            "--key",
            "marfa_k1_kept",
            "keys",
            "keep",
        ])
        .output()
        .unwrap();
    assert!(
        kept.status.success(),
        "{}",
        String::from_utf8_lossy(&kept.stderr)
    );
    let _ = bearers.try_iter().count();

    let listed = keychain
        .marfa()
        .args(["--json", "items", "list"])
        .env("MARFA_API_URL", &url)
        .env("MARFA_API_KEY", "marfa_k1_environment")
        .output()
        .unwrap();
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let sent: Vec<_> = bearers.try_iter().collect();
    assert!(!sent.is_empty());
    assert!(
        sent.iter()
            .all(|bearer| bearer.as_deref() == Some("marfa_k1_environment")),
        "{sent:?}"
    );

    let (elsewhere, heard) = server();
    let listed = keychain
        .marfa()
        .args(["--json", "items", "list"])
        .env("MARFA_API_URL", &elsewhere)
        .env("MARFA_API_KEY", "marfa_k1_environment")
        .output()
        .unwrap();
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    assert!(heard.try_iter().next().is_some());
    assert_eq!(bearers.try_iter().count(), 0, "the kept server was reached");

    let listed = keychain
        .marfa()
        .args(["--json", "items", "list"])
        .env("MARFA_API_URL", &url)
        .output()
        .unwrap();
    assert!(
        listed.status.success(),
        "{}",
        String::from_utf8_lossy(&listed.stderr)
    );
    let sent: Vec<_> = bearers.try_iter().collect();
    assert!(
        sent.iter()
            .any(|bearer| bearer.as_deref() == Some("marfa_k1_kept")),
        "{sent:?}"
    );
}

fn discovery(origin: &str) -> String {
    serde_json::json!({
        "issuer": format!("{origin}/auth"),
        "token_endpoint": format!("{origin}/auth/oauth2/token"),
        "device_authorization_endpoint": format!("{origin}/auth/device/code"),
        "registration_endpoint": format!("{origin}/auth/oauth2/register"),
        "revocation_endpoint": format!("{origin}/auth/oauth2/revoke"),
        "userinfo_endpoint": format!("{origin}/auth/oauth2/userinfo"),
        "scopes_supported": ["openid", "offline_access", "*:read"]
    })
    .to_string()
}

/// A sign-in from the first request to the approved token: discovery, a
/// registration, a device code and the token the owner's approval releases.
fn sign_in_door() -> Door {
    Door::open_at(|origin| {
        vec![
            Answer::json("200 OK", &discovery(origin)),
            Answer::json("201 Created", r#"{"client_id":"registered"}"#),
            Answer::json(
                "200 OK",
                &serde_json::json!({
                    "device_code": "dc",
                    "user_code": "ABCD1234",
                    "verification_uri": format!("{origin}/auth/device"),
                    "verification_uri_complete": format!("{origin}/auth/device?user_code=ABCD1234"),
                    "expires_in": 600,
                    "interval": 1
                })
                .to_string(),
            ),
            Answer::json(
                "200 OK",
                r#"{"access_token":"marfa_at_1","refresh_token":"marfa_rt_1","expires_in":3600,"token_type":"Bearer","scope":"*:read"}"#,
            ),
        ]
    })
}

#[test]
fn print_token_leaves_a_fresh_keychain_file_unchanged() {
    let keychain = Isolated::new("print-token");
    let before = std::fs::read(keychain.keychain_path()).unwrap();

    let door = sign_in_door();
    let origin = door.url.clone();
    let printed = keychain
        .marfa()
        .args([
            "--json",
            "--url",
            &origin,
            "login",
            "--print-token",
            "--no-browser",
        ])
        .output()
        .unwrap();
    assert!(
        printed.status.success(),
        "{}",
        String::from_utf8_lossy(&printed.stderr)
    );
    assert!(String::from_utf8_lossy(&printed.stdout).contains("marfa_at_1"));
    assert_eq!(door.received().len(), 4);

    assert!(
        std::fs::read(keychain.keychain_path()).unwrap() == before,
        "login --print-token wrote to the keychain file"
    );
    for account in [origin.clone(), format!("client:{origin}"), "current".into()] {
        assert!(!keychain.holds(&account), "{account} reached the keychain");
    }
    let mut beside = keychain.keychain_path().into_os_string();
    beside.push(".locks");
    assert!(
        !std::path::Path::new(&beside).exists(),
        "login --print-token took a credential lock for a store it never uses"
    );

    // The witness: the same sign-in without the flag keeps the registration
    // and the token in the same file.
    let door = sign_in_door();
    let origin = door.url.clone();
    let kept = keychain
        .marfa()
        .args(["--json", "--url", &origin, "login", "--no-browser"])
        .output()
        .unwrap();
    assert!(
        kept.status.success(),
        "{}",
        String::from_utf8_lossy(&kept.stderr)
    );
    assert!(std::fs::read(keychain.keychain_path()).unwrap() != before);
    assert!(keychain.holds(&origin));
    assert!(keychain.holds(&format!("client:{origin}")));
    assert!(keychain.holds("current"));
}

fn envelope(output: &std::process::Output) -> serde_json::Value {
    let stderr = String::from_utf8_lossy(&output.stderr);
    serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"))
}

/// A keychain that names a server and holds a key for it, so a command that
/// reads it can be told from one that does not.
fn keychain_holding(name: &str, url: &str) -> Isolated {
    let keychain = Isolated::new(name);
    keychain.put("current", url);
    keychain.put(url, r#"{"kind":"key","key":"marfa_k1_kept"}"#);
    keychain
}

#[test]
fn a_keychain_that_is_off_is_never_read_or_written() {
    let (url, bearers) = server();
    let keychain = keychain_holding("off", &url);
    let before = std::fs::read(keychain.keychain_path()).unwrap();

    // The witness: left on, a bare command reads the current server and the
    // key kept for it.
    let on = keychain
        .marfa()
        .args(["--json", "items", "list"])
        .output()
        .unwrap();
    assert!(
        on.status.success(),
        "{}",
        String::from_utf8_lossy(&on.stderr)
    );
    assert!(
        bearers
            .try_iter()
            .any(|bearer| bearer.as_deref() == Some("marfa_k1_kept"))
    );
    // It took a lock beside the keychain, which only a run that reads the
    // keychain does.
    let mut beside = keychain.keychain_path().into_os_string();
    beside.push(".locks");
    assert!(std::path::Path::new(&beside).exists());
    std::fs::remove_dir_all(&beside).unwrap();

    let turned_off: [fn(&mut std::process::Command); 2] = [
        |command| {
            command.arg("--no-keychain");
        },
        |command| {
            command.env("MARFA_NO_KEYCHAIN", "1");
        },
    ];
    for flag in turned_off {
        // No server is named, so the kept one is not found.
        let mut bare = keychain.marfa();
        flag(&mut bare);
        let bare = bare.args(["--json", "items", "list"]).output().unwrap();
        assert_eq!(bare.status.code(), Some(2), "{bare:?}");
        assert_eq!(envelope(&bare)["error"]["code"], "no_server");

        // A named server has no credential to send, not the kept key.
        let mut named = keychain.marfa();
        flag(&mut named);
        let named = named
            .args(["--json", "--url", &url, "items", "list"])
            .output()
            .unwrap();
        assert_eq!(named.status.code(), Some(5), "{named:?}");
        let refusal = envelope(&named);
        assert_eq!(refusal["error"]["code"], "no_credential");
        let message = refusal["error"]["message"].as_str().unwrap();
        assert!(!message.contains("keys keep"), "{message}");
        assert_eq!(
            bearers.try_iter().count(),
            0,
            "the kept key was read and sent"
        );

        // Everything that would keep or remove something says how to pass a
        // key instead, and leaves the keychain as it was.
        for (command, instead) in [
            (&["keys", "keep"][..], "MARFA_API_KEY"),
            (&["keys", "forget"], "MARFA_API_KEY"),
            (&["logout"], "MARFA_API_KEY"),
            (&["login"], "--print-token"),
        ] {
            let mut refused = keychain.marfa();
            flag(&mut refused);
            let refused = refused
                .args(["--json", "--url", &url])
                .args(command)
                .output()
                .unwrap();
            assert_eq!(refused.status.code(), Some(2), "{command:?}: {refused:?}");
            let envelope = envelope(&refused);
            assert_eq!(envelope["error"]["code"], "usage", "{command:?}");
            assert!(
                envelope["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(instead),
                "{command:?}: {envelope}"
            );
        }
    }

    assert!(
        std::fs::read(keychain.keychain_path()).unwrap() == before,
        "a command with the keychain off changed it"
    );
    assert!(keychain.holds(&url));
    assert!(keychain.holds("current"));
    assert!(
        !std::path::Path::new(&beside).exists(),
        "a command with the keychain off took a credential lock"
    );
}

#[test]
fn a_false_word_leaves_the_keychain_on() {
    let (url, bearers) = server();
    let keychain = keychain_holding("false-word", &url);
    let listed = keychain
        .marfa()
        .env("MARFA_NO_KEYCHAIN", "0")
        .args(["--json", "items", "list"])
        .output()
        .unwrap();
    assert!(listed.status.success(), "{listed:?}");
    assert!(
        bearers
            .try_iter()
            .any(|bearer| bearer.as_deref() == Some("marfa_k1_kept"))
    );
}

#[test]
fn a_key_in_hand_does_not_send_the_command_to_the_keychains_server() {
    let (url, bearers) = server();
    let keychain = keychain_holding("key-alone", &url);
    let mut by_environment = keychain.marfa();
    by_environment
        .env("MARFA_API_KEY", "marfa_k1_environment")
        .args(["--json", "items", "list"]);
    let mut by_flag = keychain.marfa();
    by_flag.args(["--json", "--key", "marfa_k1_flag", "items", "list"]);
    for mut command in [by_environment, by_flag] {
        let listed = command.output().unwrap();
        assert_eq!(listed.status.code(), Some(2), "{listed:?}");
        assert_eq!(envelope(&listed)["error"]["code"], "no_server");
        assert_eq!(
            bearers.try_iter().count(),
            0,
            "the key went to the server the keychain made current"
        );
    }
}
