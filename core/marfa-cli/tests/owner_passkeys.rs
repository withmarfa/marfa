use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
fn command() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_marfa"));
    cmd.env_remove("MARFA_API_URL")
        .env_remove("MARFA_API_KEY")
        .env_remove("MARFA_DB");
    cmd
}
#[test]
fn every_passkey_command_refuses_remote_before_loading_credentials() {
    for args in [
        vec!["list"],
        vec!["rename", "p1", "--name", "Studio"],
        vec!["remove", "p1"],
        vec!["add", "--no-browser"],
    ] {
        let output = command()
            .args([
                "--json",
                "--url",
                "https://example.test",
                "owner",
                "passkeys",
            ])
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("requires --socket PATH"), "{stderr}");
    }
}
#[test]
fn add_uses_configured_url_without_a_browser_and_survives_opener_failure() {
    for no_browser in [true, false] {
        let folder = std::env::temp_dir().join(format!(
            "mp-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        let folder = std::fs::canonicalize(folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = folder.join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let opener = folder.join(if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        });
        let witness = folder.join("opened");
        std::fs::write(
            &opener,
            format!(
                "#!/bin/sh\nprintf '%s' \"$1\" > '{}'\nexit 1\n",
                witness.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o700)).unwrap();
        let url = "https://configured.example/auth/sign-in?prompt=login&return_to=%2Fauth%2Fowner%2Fpasskeys";
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut data = [0u8; 4096];
            let n = stream.read(&mut data).unwrap();
            let request = String::from_utf8_lossy(&data[..n]);
            assert!(
                request.starts_with("GET /_control/owner/passkeys/add-url HTTP/1.1"),
                "{request}"
            );
            assert!(!request.to_lowercase().contains("authorization:"));
            let body = serde_json::json!({"url":url}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Marfa-Contract: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",marfa_core::contract::CONTRACT_VERSION,body.len(),body).unwrap();
        });
        let mut cmd = command();
        cmd.args([
            "--socket",
            path.to_str().unwrap(),
            "owner",
            "passkeys",
            "add",
        ])
        .env("PATH", format!("{}:/usr/bin:/bin", folder.display()));
        if no_browser {
            cmd.arg("--no-browser");
        }
        let output = cmd.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        handle.join().unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains(url));
        if no_browser {
            assert!(!witness.exists());
        } else {
            assert_eq!(std::fs::read_to_string(witness).unwrap(), url);
            assert!(String::from_utf8_lossy(&output.stderr).contains("Could not open a browser"));
        }
        std::fs::remove_dir_all(folder).unwrap();
    }
}
