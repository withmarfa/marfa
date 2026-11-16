//! macOS alone has keychain files.
#![cfg(target_os = "macos")]

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;
mod isolated;

use std::io::Write;
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
            let bearer = door::read_request(&mut stream)
                .header("authorization")
                .map(|value| value.trim_start_matches("Bearer ").to_string());
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
        "issuer": origin,
        "token_endpoint": format!("{origin}/oauth/token"),
        "device_authorization_endpoint": format!("{origin}/oauth/device-authorization"),
        "registration_endpoint": format!("{origin}/oauth/register"),
        "revocation_endpoint": format!("{origin}/oauth/revoke"),
        "userinfo_endpoint": format!("{origin}/oauth/userinfo"),
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

#[test]
fn signing_out_and_forgetting_use_the_kept_server_though_a_key_is_exported() {
    // Neither sends the key, so a key exported for other commands does not
    // stop them finding the server the keychain made current.
    let url = "http://127.0.0.1:9";
    let keychain = keychain_holding("exported-logout", url);
    let output = keychain
        .marfa()
        .env("MARFA_API_KEY", "marfa_k1_environment")
        .args(["--json", "logout"])
        .output()
        .unwrap();
    // The kept credential is a key, which a sign-out declines to touch, and
    // saying so means it read the kept server.
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(
        envelope(&output)["error"]["message"]
            .as_str()
            .unwrap()
            .contains(url)
    );
    assert!(keychain.holds(url));

    let output = keychain
        .marfa()
        .env("MARFA_API_KEY", "marfa_k1_environment")
        .args(["--json", "keys", "forget"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert!(!keychain.holds(url));
}

/// `logout` with the keychain off, for the token it is handed.
fn logout_off(keychain: &Isolated, url: &str, token: &str, extra: &[&str]) -> std::process::Output {
    keychain
        .marfa()
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_API_KEY", token)
        .args(["--json", "--url", url, "logout"])
        .args(extra)
        .output()
        .unwrap()
}

#[test]
fn logging_out_with_the_keychain_off_revokes_the_token_it_is_handed() {
    let keychain = keychain_holding("logout-off", "https://elsewhere.example");
    let before = std::fs::read(keychain.keychain_path()).unwrap();

    // An access token: discovery, the revocation, then the server refuses the token.
    let door = Door::open_at(|origin| {
        vec![
            Answer::json("200 OK", &discovery(origin)),
            Answer::json("200 OK", "{}"),
            Answer::json(
                "401 Unauthorized",
                r#"{"error":{"code":"unauthorized","message":"No."}}"#,
            ),
        ]
    });
    let ran = logout_off(
        &keychain,
        &door.url,
        "marfa_at_handed",
        &["--client-id", "registered"],
    );
    assert!(ran.status.success(), "{ran:?}");
    let said: serde_json::Value = serde_json::from_slice(&ran.stdout).unwrap();
    assert_eq!(said["accepted"], false, "{said}");
    let sent = door.received();
    assert_eq!(sent.len(), 3);
    assert!(sent[1].path().ends_with("/revoke"), "{}", sent[1].path());
    assert_eq!(sent[1].method(), "POST");
    for part in [
        "token=marfa_at_handed",
        "token_type_hint=access_token",
        "client_id=registered",
    ] {
        assert!(sent[1].body.contains(part), "{}", sent[1].body);
    }
    assert!(sent[1].header("authorization").is_none());

    // The witness: a client that is not the token's leaves it working, which is said.
    let door = Door::open_at(|origin| {
        vec![
            Answer::json("200 OK", &discovery(origin)),
            Answer::json("200 OK", "{}"),
            Answer::json("200 OK", "{}"),
        ]
    });
    let ran = logout_off(
        &keychain,
        &door.url,
        "marfa_at_handed",
        &["--client-id", "other"],
    );
    assert_eq!(ran.status.code(), Some(1), "{ran:?}");
    assert!(
        String::from_utf8_lossy(&ran.stderr).contains("still accepts the token"),
        "{ran:?}"
    );

    // A refresh token has nothing to try it with, so it is only sent.
    let door = Door::open_at(|origin| {
        vec![
            Answer::json("200 OK", &discovery(origin)),
            Answer::json("200 OK", "{}"),
        ]
    });
    let ran = logout_off(
        &keychain,
        &door.url,
        "marfa_rt_handed",
        &["--client-id", "registered"],
    );
    assert!(ran.status.success(), "{ran:?}");
    let said: serde_json::Value = serde_json::from_slice(&ran.stdout).unwrap();
    assert!(said["accepted"].is_null(), "{said}");
    let sent = door.received();
    assert_eq!(sent.len(), 2);
    assert!(sent[1].body.contains("token_type_hint=refresh_token"));

    // Neither a key nor a token without its client is sent anywhere.
    let door = Door::open(vec![]);
    let ran = logout_off(&keychain, &door.url, "marfa_k1_key", &["--client-id", "x"]);
    assert_eq!(ran.status.code(), Some(1), "{ran:?}");
    let ran = logout_off(&keychain, &door.url, "marfa_at_handed", &[]);
    assert_eq!(ran.status.code(), Some(2), "{ran:?}");
    assert!(String::from_utf8_lossy(&ran.stderr).contains("--client-id"));
    assert_eq!(door.received().len(), 0);

    assert!(
        std::fs::read(keychain.keychain_path()).unwrap() == before,
        "a logout with the keychain off changed it"
    );
}

#[test]
fn logging_out_with_the_keychain_off_sends_a_token_only_where_a_key_would_go() {
    use std::os::unix::fs::PermissionsExt;

    let keychain = keychain_holding("logout-off-guards", "https://elsewhere.example");
    let door = Door::open(vec![]);

    // A profile has a credential of its own, so the environment's token is not handed on.
    let home = keychain.directory().join("home");
    let profiles = home.join("Library/Application Support/Marfa/profiles.toml");
    std::fs::create_dir_all(profiles.parent().unwrap()).unwrap();
    std::fs::write(&profiles, format!("[demo]\nurl = \"{}\"\n", door.url)).unwrap();
    std::fs::set_permissions(&profiles, std::fs::Permissions::from_mode(0o600)).unwrap();
    let ran = keychain
        .marfa()
        .env("HOME", &home)
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_API_KEY", "marfa_at_handed")
        .args([
            "--json",
            "--profile",
            "demo",
            "logout",
            "--client-id",
            "registered",
        ])
        .output()
        .unwrap();
    assert_eq!(ran.status.code(), Some(2), "{ran:?}");
    assert!(
        String::from_utf8_lossy(&ran.stderr).contains("a profile's credential is its own"),
        "{ran:?}"
    );

    // MARFA_API_KEY is the server MARFA_API_URL names, not the one --url does.
    let ran = keychain
        .marfa()
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_API_KEY", "marfa_at_handed")
        .env("MARFA_API_URL", "https://other.example")
        .args([
            "--json",
            "--url",
            &door.url,
            "logout",
            "--client-id",
            "registered",
        ])
        .output()
        .unwrap();
    assert_eq!(ran.status.code(), Some(2), "{ran:?}");
    assert!(
        String::from_utf8_lossy(&ran.stderr).contains("MARFA_API_KEY is for the server"),
        "{ran:?}"
    );
    assert_eq!(
        door.received().len(),
        0,
        "a token was sent to the wrong server"
    );

    // The witness: with MARFA_API_URL naming the same server, the token is sent.
    let door = Door::open_at(|origin| {
        vec![
            Answer::json("200 OK", &discovery(origin)),
            Answer::json("200 OK", "{}"),
        ]
    });
    let ran = keychain
        .marfa()
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_API_KEY", "marfa_rt_handed")
        .env("MARFA_API_URL", &door.url)
        .args([
            "--json",
            "--url",
            &door.url,
            "logout",
            "--client-id",
            "registered",
        ])
        .output()
        .unwrap();
    assert!(ran.status.success(), "{ran:?}");
    assert_eq!(door.received().len(), 2);
}
