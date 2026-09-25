//! The binary's keychain, end to end: `keys keep` and `keys forget` with
//! `MARFA_KEYCHAIN` naming a keychain file of the test's own, so the entry
//! lands there and never in the person's keychain. macOS alone has keychain
//! files.
#![cfg(target_os = "macos")]

mod isolated;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{Receiver, channel};

use isolated::Isolated;

/// A server on a local port that answers every request alike, on the
/// contract this binary was built for, for as long as the test runs, and
/// hands back the bearer each request carried.
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
                marfa_client::CONTRACT_VERSION,
                body.len()
            );
        }
    });
    (url, bearers)
}

#[test]
fn a_kept_key_lands_in_the_runs_keychain_and_never_the_persons() {
    let keychain = Isolated::new("keychain");
    let (url, _) = server();
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
    // The witness: the named keychain holds the entry, asked the same way.
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

/// With the server and the key both in the environment, the key sent is the
/// environment's, whatever the keychain keeps for that server; the witness
/// is the kept key sent where the environment names only the server.
#[test]
fn the_environment_wins_over_a_kept_key() {
    let keychain = Isolated::new("environment");
    let (url, bearers) = server();
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
