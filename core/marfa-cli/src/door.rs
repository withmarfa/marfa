//! A door on a local port for the tests: it answers what it was given, one
//! answer per connection, and keeps what it was sent, so a command's whole
//! call can be held without a server.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread::JoinHandle;

/// One request as it arrived on the wire: the request line and headers,
/// lowercased for lookup, and the body.
#[derive(Debug, Clone)]
pub struct Received {
    pub line: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Received {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(found, _)| *found == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn method(&self) -> &str {
        self.line.split(' ').next().unwrap_or("")
    }

    pub fn path(&self) -> &str {
        self.line.split(' ').nth(1).unwrap_or("")
    }
}

/// A canned answer: the status line's code and reason, the content type,
/// the body.
pub struct Answer {
    pub status: &'static str,
    pub content_type: &'static str,
    pub body: String,
}

impl Answer {
    pub fn json(status: &'static str, body: &str) -> Answer {
        Answer {
            status,
            content_type: "application/json",
            body: body.to_string(),
        }
    }
}

pub struct Door {
    pub url: String,
    handle: JoinHandle<Vec<Received>>,
}

impl Door {
    /// Opens the door with the answers it will give, in order, one per
    /// connection; every answer closes its connection so the next call
    /// arrives as a fresh one.
    pub fn open(answers: Vec<Answer>) -> Door {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut received = Vec::new();
            for answer in answers {
                let (mut stream, _) = listener.accept().unwrap();
                received.push(read_request(&mut stream));
                write!(
                    stream,
                    "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    answer.status,
                    answer.content_type,
                    answer.body.len(),
                    answer.body
                )
                .unwrap();
                stream.flush().unwrap();
            }
            received
        });
        Door { url, handle }
    }

    /// Everything the door was sent, once every answer has gone out. A
    /// door with answers left is one a call never reached, which is a
    /// failure this reports rather than a wait it sits out.
    pub fn received(self) -> Vec<Received> {
        self.handle.join().unwrap()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Received {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end;
    loop {
        let n = stream.read(&mut chunk).unwrap();
        if n == 0 {
            panic!("the connection closed before the request's head arrived");
        }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(at) = find(&bytes, b"\r\n\r\n") {
            head_end = at + 4;
            break;
        }
    }
    let head = String::from_utf8_lossy(&bytes[..head_end]).into_owned();
    let mut lines = head.lines();
    let line = lines.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let chunked = headers
        .iter()
        .any(|(name, value)| name == "transfer-encoding" && value.contains("chunked"));
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = bytes[head_end..].to_vec();
    if chunked {
        while find(&body, b"\r\n0\r\n\r\n").is_none() && !body.starts_with(b"0\r\n\r\n") {
            let n = stream.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body = unchunk(&body);
    } else {
        while body.len() < length {
            let n = stream.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
    }
    Received {
        line,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The payload of a chunked body: each chunk's size line dropped, the
/// bytes kept.
fn unchunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(end) = find(&body[at..], b"\r\n") {
        let size_line = String::from_utf8_lossy(&body[at..at + end]);
        let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
        at += end + 2;
        if size == 0 {
            break;
        }
        out.extend_from_slice(&body[at..(at + size).min(body.len())]);
        at += size + 2;
    }
    out
}
