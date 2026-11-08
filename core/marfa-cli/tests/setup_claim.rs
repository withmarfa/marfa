//! `marfa setup claim` and `setup open` against a stand-in for the server's
//! private socket: the sign-in address moves only for an instance that is not
//! claimed, and only once the claim has what it needs.

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

struct Socket {
    folder: PathBuf,
    path: PathBuf,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Socket {
    fn new(name: &str, claimed: bool) -> Socket {
        let folder = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("msc-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = folder.join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handle = {
            let (requests, stop) = (requests.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    let mut data = [0u8; 8192];
                    let n = stream.read(&mut data).unwrap_or(0);
                    let request = String::from_utf8_lossy(&data[..n]).into_owned();
                    let line = request.lines().next().unwrap_or("").to_string();
                    let body = if line.contains("setup/status") {
                        format!("{{\"claimed\":{claimed}}}")
                    } else {
                        "{}".to_string()
                    };
                    requests.lock().unwrap().push(line);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Marfa-Contract: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        marfa_core::contract::CONTRACT_VERSION,
                        body.len(),
                        body
                    );
                }
            })
        };
        Socket {
            folder,
            path,
            requests,
            stop,
            handle: Some(handle),
        }
    }

    fn run(&self, args: &[&str]) -> (i32, String) {
        self.run_with(args, "")
    }

    fn run_with(&self, args: &[&str], stdin: &str) -> (i32, String) {
        let mut command = quiet::marfa();
        command
            .env_remove("MARFA_API_URL")
            .env_remove("MARFA_API_KEY")
            .env_remove("MARFA_DB")
            .arg("--socket")
            .arg(&self.path)
            .args(args)
            .env("PATH", format!("{}:/usr/bin:/bin", self.folder.display()));
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        (
            output.status.code().unwrap(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn wrote_config(&self) -> bool {
        self.requests()
            .iter()
            .any(|line| line.contains("/config") && !line.starts_with("GET"))
    }
}

impl Drop for Socket {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_dir_all(&self.folder);
    }
}

const CLAIM: [&str; 5] = [
    "setup",
    "claim",
    "--stdin",
    "--address",
    "https://marfa.example.com",
];
const OWNER: &str = r#"{"email":"a@example.com","password":"a long enough password"}"#;

#[test]
fn an_unclaimed_instance_takes_the_address_and_then_the_claim() {
    let socket = Socket::new("unclaimed", false);
    let (code, stderr) = socket.run_with(&CLAIM, OWNER);
    assert_eq!(code, 0, "{stderr}");
    let requests = socket.requests();
    let at = |needle: &str| requests.iter().position(|line| line.contains(needle));
    assert!(socket.wrote_config(), "{requests:?}\n{stderr}");
    assert!(
        at("setup/status") < at("setup/claim") && at("/config") < at("setup/claim"),
        "the address was not set before the claim: {requests:?}"
    );
}

#[test]
fn a_claimed_instance_keeps_the_address_its_owner_signs_in_at() {
    let socket = Socket::new("claimed", true);
    let (code, stderr) = socket.run_with(&CLAIM, OWNER);
    assert_eq!(code, 0, "{stderr}");
    assert!(
        socket
            .requests()
            .iter()
            .any(|line| line.contains("setup/claim")),
        "the claim never ran: {:?}",
        socket.requests()
    );
    assert!(
        !socket.wrote_config(),
        "a claimed instance was moved: {:?}",
        socket.requests()
    );
    socket.run(&[
        "setup",
        "open",
        "--no-browser",
        "--address",
        "https://marfa.example.com",
    ]);
    assert!(!socket.wrote_config(), "{:?}", socket.requests());
}

#[test]
fn input_that_cannot_claim_never_moves_the_address() {
    let socket = Socket::new("no-input", false);
    // No terminal and no `--stdin`: nothing to claim with.
    let (code, stderr) = socket.run(&[
        "setup",
        "claim",
        "--address",
        "https://marfa.example.com",
        "--email",
        "a@example.com",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(socket.requests().is_empty(), "{:?}", socket.requests());

    // An address the server would refuse.
    let (code, stderr) = socket.run_with(
        &[
            "setup",
            "claim",
            "--stdin",
            "--address",
            "http://marfa.example.com",
        ],
        OWNER,
    );
    assert_eq!(code, 2, "{stderr}");
    assert!(socket.requests().is_empty(), "{:?}", socket.requests());
}
