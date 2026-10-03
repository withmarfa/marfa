#![cfg(target_os = "macos")]

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;
mod isolated;

use isolated::Isolated;
use std::io::{Read, Write};

fn keep_token(keychain: &Isolated, origin: &str) {
    keychain.put(origin, &serde_json::json!({
        "kind": "token", "access_token": "marfa_at_fixture", "refresh_token": "marfa_rt_fixture",
        "expires_at": null, "client_id": "fixture", "scope": "*:read",
        "token_endpoint": format!("{origin}/token"), "revocation_endpoint": null,
    }).to_string());
}

fn hydrate(keychain: &Isolated, origin: &str, code: &str, exit: i32) {
    let store = keychain.directory().join("copy.sqlite");
    let output = keychain
        .marfa()
        .args([
            "--json",
            "--url",
            origin,
            "device",
            "--db",
            store.to_str().unwrap(),
            "hydrate",
            "--types",
            "core.note",
            "--tier",
            "library",
        ])
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(exit),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    let envelope: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(envelope["error"]["code"], code);
    assert!(envelope["error"]["server"].is_null());
}

#[test]
fn device_renewal_reports_signed_out_without_inventing_server_status() {
    let keychain = Isolated::new("renewal-signed-out");
    let door = door::Door::open(vec![
        door::Answer::json(
            "401 Unauthorized",
            r#"{"error":{"code":"unauthorized","message":"expired"}}"#,
        ),
        door::Answer::json(
            "200 OK",
            &format!(r#"{{"contract":{}}}"#, marfa_client::CONTRACT_VERSION),
        ),
        door::Answer::json(
            "400 Bad Request",
            r#"{"error":{"code":"invalid_grant","message":"ended"}}"#,
        ),
    ]);
    keep_token(&keychain, &door.url);
    hydrate(&keychain, &door.url, "signed_out", 5);
    let received = door.received();
    assert_eq!(received.len(), 3);
    assert_eq!(received[2].path(), "/token");
}

#[test]
fn device_renewal_reports_local_keychain_failure_without_server_status() {
    let keychain = Isolated::new("renewal-no-keychain");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    keep_token(&keychain, &origin);
    let path = keychain.keychain_path();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buffer = [0; 8192];
        assert!(stream.read(&mut buffer).unwrap() > 0);
        std::fs::remove_file(path).unwrap();
        let body = r#"{"error":{"code":"unauthorized","message":"expired"}}"#;
        write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nX-Marfa-Contract: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", marfa_client::CONTRACT_VERSION, body.len()).unwrap();
    });
    hydrate(&keychain, &origin, "no_keychain", 4);
    server.join().unwrap();
}
