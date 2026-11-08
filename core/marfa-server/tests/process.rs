//! The real program: its exit, files, sockets and signals.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tempfile::TempDir;

const MAX_BODY: usize = 1024 * 1024;

/// The socket's folders must hold no symbolic link, as macOS's temporary
/// folder does.
fn control_socket(dir: &Path) -> PathBuf {
    dir.canonicalize().unwrap().join("control").join("s.sock")
}

fn program(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_marfa-server"));
    command
        .env_clear()
        .env("MARFA_PORT", "0")
        .env("MARFA_LISTEN_HOST", "127.0.0.1")
        .env("MARFA_TEST_HOOKS", "true")
        .env("MARFA_DATABASE_PATH", dir.join("marfa.db"))
        .env("MARFA_BLOB_PATH", dir.join("blobs"))
        .env("MARFA_CONTROL_SOCKET", control_socket(dir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

struct Server {
    child: Child,
    socket: PathBuf,
    port: u16,
    log: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start(dir: &Path) -> Server {
        let mut child = program(dir).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let log = Arc::new(Mutex::new(Vec::new()));
        let (found, port) = std::sync::mpsc::channel();
        let lines = log.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some((_, rest)) = line.split_once("listening on port ") {
                    let digits = rest.chars().take_while(char::is_ascii_digit);
                    let _ = found.send(digits.collect::<String>().parse::<u16>().unwrap());
                }
                lines.lock().unwrap().push(line);
            }
        });
        let port = port.recv_timeout(Duration::from_secs(20)).unwrap();
        Server {
            child,
            socket: dir.join("control").join("s.sock"),
            port,
            log,
        }
    }

    fn signal(&self, name: &str) {
        let pid = self.child.id().to_string();
        let sent = Command::new("kill").args([name, &pid]).status().unwrap();
        assert!(sent.success());
    }

    fn wait(&mut self) -> ExitStatus {
        let limit = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < limit, "the server did not stop");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn public(&self, request: &[u8]) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        exchange(&mut stream, request)
    }

    fn control(&self, request: &[u8]) -> String {
        let mut stream = UnixStream::connect(&self.socket).unwrap();
        exchange(&mut stream, request)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn exchange(stream: &mut (impl Read + Write), request: &[u8]) -> String {
    // A refused body is answered without being read to its end.
    let _ = stream.write_all(request);
    let mut answer = Vec::new();
    let _ = stream.read_to_end(&mut answer);
    String::from_utf8_lossy(&answer).into_owned()
}

fn request(method: &str, path: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    out.extend_from_slice(body);
    out
}

fn status(answer: &str) -> u16 {
    answer
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or_else(|| panic!("not an answer: {answer:?}"))
}

fn has_code(answer: &str, code: &str) -> bool {
    answer.contains(&format!("\"code\":\"{code}\""))
        && answer
            .to_ascii_lowercase()
            .contains(&format!("x-error-code: {code}"))
}

#[test]
fn a_refused_start_names_each_setting_and_leaves_nothing_behind() {
    let dir = TempDir::new().unwrap();
    let secret = "a-secret-with-spaces-around-it";
    let output = program(dir.path())
        .env("MARFA_PORT", "not-a-port")
        .env("MARFA_WRITE_WAIT_MS", "soon")
        .env("MARFA_AUTH_SECRET", format!(" {secret} "))
        .stderr(Stdio::piped())
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    let printed = String::from_utf8_lossy(&output.stdout);
    let record: serde_json::Value = serde_json::from_str(printed.trim()).unwrap();
    let said = record["error"].as_str().unwrap();
    let line_of = |name: &str| said.lines().position(|line| line.contains(name));
    let (port, budget) = (line_of("MARFA_PORT"), line_of("MARFA_WRITE_WAIT_MS"));
    assert!(
        port.is_some() && budget.is_some() && port != budget,
        "{said}"
    );
    assert!(line_of("MARFA_AUTH_SECRET").is_some(), "{said}");
    assert!(!printed.contains(secret), "{printed}");
    assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_port_in_use_is_refused_by_a_second_start() {
    let dir = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let first = Server::start(dir.path());
    let output = program(other.path())
        .env("MARFA_PORT", first.port.to_string())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(!other.path().join("control").join("s.sock").exists());
}

#[test]
fn a_socket_left_by_a_killed_server_does_not_stop_the_next() {
    let dir = TempDir::new().unwrap();
    let mut first = Server::start(dir.path());
    first.signal("-KILL");
    first.wait();
    assert!(first.socket.exists());

    let second = Server::start(dir.path());
    assert_eq!(
        status(&second.control(&request("GET", "/health", b""))),
        200
    );
}

#[test]
fn a_second_server_on_the_socket_is_refused_and_the_first_serves_on() {
    let dir = TempDir::new().unwrap();
    let first = Server::start(dir.path());
    let output = program(dir.path()).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("already in use"),
        "{output:?}"
    );
    assert_eq!(status(&first.control(&request("GET", "/health", b""))), 200);
}

#[test]
fn a_stop_clears_a_hold_finishes_the_write_and_exits_cleanly() {
    let dir = TempDir::new().unwrap();
    let mut server = Server::start(dir.path());
    let arm = request("PUT", "/_control/test/faults", br#"{"name":"hold:write"}"#);
    assert_eq!(status(&server.control(&arm)), 200);

    let socket = server.socket.clone();
    let held = thread::spawn(move || {
        let mut stream = UnixStream::connect(socket).unwrap();
        let body = br#"{"label":"held","source":"test","permissions":[]}"#;
        exchange(&mut stream, &request("POST", "/keys", body))
    });
    let limit = Instant::now() + Duration::from_secs(5);
    while !server
        .control(&request("GET", "/_control/test/faults", b""))
        .contains("\"waiting\":1")
    {
        assert!(Instant::now() < limit, "the write never reached its hold");
        thread::sleep(Duration::from_millis(10));
    }

    server.signal("-TERM");
    assert_eq!(server.wait().code(), Some(0));
    assert_eq!(status(&held.join().unwrap()), 201);
    assert!(!server.socket.exists());
    let log = server.log.lock().unwrap().join("\n");
    assert!(log.contains("\"status\":201"), "{log}");
    drop(server);

    let next = Server::start(dir.path());
    assert_eq!(status(&next.control(&request("GET", "/health", b""))), 200);
}

#[test]
fn a_request_still_open_at_the_end_of_a_stop_exits_with_status_1() {
    let dir = TempDir::new().unwrap();
    let mut server = Server::start(dir.path());
    let mut open = UnixStream::connect(&server.socket).unwrap();
    let head = "POST /keys HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n\
                Content-Length: 100\r\n\r\n{";
    open.write_all(head.as_bytes()).unwrap();
    thread::sleep(Duration::from_millis(200));

    server.signal("-TERM");
    assert_eq!(server.wait().code(), Some(1));
    assert!(!server.socket.exists());
}

#[test]
fn a_stop_does_not_wait_for_a_connection_that_never_finished_its_head() {
    let dir = TempDir::new().unwrap();
    let mut server = Server::start(dir.path());
    let mut stalled = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
    stalled
        .write_all(b"GET /health HTTP/1.1\r\nHost: x")
        .unwrap();
    thread::sleep(Duration::from_millis(200));

    let stopped = Instant::now();
    server.signal("-TERM");
    assert_eq!(server.wait().code(), Some(0));
    assert!(stopped.elapsed() < Duration::from_secs(3));
}

#[test]
fn an_interrupt_stops_it_as_a_terminate_does() {
    let dir = TempDir::new().unwrap();
    let mut server = Server::start(dir.path());
    server.signal("-INT");
    assert_eq!(server.wait().code(), Some(0));
    assert!(!server.socket.exists());
    assert_eq!(
        std::fs::metadata(dir.path().join("marfa.db-wal")).map_or(0, |m| m.len()),
        0
    );
}

#[test]
fn a_stop_leaves_every_acknowledged_write_in_the_file_without_its_log() {
    let dir = TempDir::new().unwrap();
    let mut server = Server::start(dir.path());
    let mint = br#"{"label":"w","source":"w","type_permissions":{"*":"write"}}"#;
    let minted = server.control(&request("POST", "/keys", mint));
    let (_, body) = minted.split_once("\r\n\r\n").unwrap();
    let minted: serde_json::Value = serde_json::from_str(body).unwrap();
    let key = minted["key"].as_str().unwrap();

    let note = br#"{"type":"core.note","properties":{"body":"kept"}}"#;
    let mut create = format!(
        "POST /items HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\
         Authorization: Bearer {key}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n\r\n",
        note.len()
    )
    .into_bytes();
    create.extend_from_slice(note);
    for _ in 0..20 {
        let made = server.public(&create);
        assert_eq!(status(&made), 201, "{made}");
    }

    server.signal("-TERM");
    assert_eq!(server.wait().code(), Some(0));

    let alone = TempDir::new().unwrap();
    let copy = alone.path().join("marfa.db");
    std::fs::copy(dir.path().join("marfa.db"), &copy).unwrap();
    let held: i64 = rusqlite::Connection::open(&copy)
        .unwrap()
        .query_row("SELECT count(*) FROM items", [], |row| row.get(0))
        .unwrap();
    assert_eq!(held, 20);
}

#[test]
fn bodies_that_cannot_be_read_are_refused() {
    let dir = TempDir::new().unwrap();
    let server = Server::start(dir.path());
    let post = |body: &[u8]| server.control(&request("POST", "/keys", body));

    assert_eq!(status(&post(b"{not json")), 400);
    assert_eq!(status(&post(b"[1,2]")), 400);
    assert_eq!(status(&post(b"{\"label\":\"\xff\xfe\"}")), 400);
    let too_large = post(&vec![b' '; MAX_BODY + 1]);
    assert_eq!(status(&too_large), 413, "{too_large}");
}

#[test]
fn a_request_nothing_serves_is_answered_in_the_envelope() {
    let dir = TempDir::new().unwrap();
    let server = Server::start(dir.path());

    let unknown = server.public(&request("GET", "/nowhere", b""));
    assert_eq!(status(&unknown), 404);
    assert!(has_code(&unknown, "not_found"), "{unknown}");
    assert!(
        unknown.to_ascii_lowercase().contains("x-request-id:"),
        "{unknown}"
    );

    let wrong_method = server.public(&request("DELETE", "/health", b""));
    assert_eq!(status(&wrong_method), 404);
    assert!(has_code(&wrong_method, "not_found"), "{wrong_method}");

    let no_credential = server.public(&request("POST", "/keys", b"{}"));
    assert_eq!(status(&no_credential), 401);

    let head = server.public(&request("HEAD", "/health", b""));
    assert_eq!(status(&head), 200);
    assert!(head.ends_with("\r\n\r\n"), "{head}");

    let options = server.public(&request("OPTIONS", "/health", b""));
    assert_eq!(status(&options), 404);
    assert!(has_code(&options, "not_found"), "{options}");
}
