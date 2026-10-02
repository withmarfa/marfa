//! Over real sockets, so the transport, the stream reader and the follow's
//! threads run as they do against a real server.
//!
//! Each path answers from its own list in order, and the last answer
//! repeats. Every answer names the core's contract unless a JSON answer
//! names its own.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::contract::CONTRACT_VERSION;
use crate::http::CONTRACT_HEADER;

#[derive(Debug, Clone)]
pub enum Answer {
    Json {
        status: u16,
        body: String,
        headers: Vec<(String, String)>,
    },
    Stream {
        frames: Vec<String>,
        then: Then,
    },
    Stall,
}

#[derive(Debug, Clone)]
pub enum Then {
    End,
    /// With no `lasting`, held until the server stops.
    Hold {
        keepalive: Option<Duration>,
        lasting: Option<Duration>,
    },
    /// Cut off inside a chunk, which the reader sees as an error, not an end.
    Break,
    Later {
        keepalive: Duration,
        after: Duration,
        frames: Vec<String>,
    },
}

#[derive(Debug, Clone)]
pub struct Seen {
    pub path: String,
    pub last_event_id: Option<String>,
    pub authorization: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Default)]
struct Script {
    answers: HashMap<String, Vec<Answer>>,
    seen: Vec<Seen>,
}

pub struct Scripted {
    port: u16,
    script: Arc<Mutex<Script>>,
    stopping: Arc<AtomicBool>,
    open: Arc<Mutex<Vec<TcpStream>>>,
}

impl Scripted {
    pub fn start() -> Scripted {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // A catalog is read with both halves, and a script about something
        // else need not write the second.
        let script = Arc::new(Mutex::new(Script::default()));
        script
            .lock()
            .unwrap()
            .answers
            .insert("/edge-types".into(), vec![edge_types(&[])]);
        let stopping = Arc::new(AtomicBool::new(false));
        let open = Arc::new(Mutex::new(Vec::new()));
        {
            let (script, stopping, open) = (
                Arc::clone(&script),
                Arc::clone(&stopping),
                Arc::clone(&open),
            );
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if stopping.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    if let Ok(clone) = stream.try_clone() {
                        open.lock().unwrap().push(clone);
                    }
                    let (script, stopping) = (Arc::clone(&script), Arc::clone(&stopping));
                    thread::spawn(move || serve(stream, &script, &stopping));
                }
            });
        }
        Scripted {
            port,
            script,
            stopping,
            open,
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn on(&self, path: &str, answers: Vec<Answer>) {
        self.script
            .lock()
            .unwrap()
            .answers
            .insert(path.to_string(), answers);
    }

    pub fn seen(&self, path: &str) -> Vec<Seen> {
        self.script
            .lock()
            .unwrap()
            .seen
            .iter()
            .filter(|seen| seen.path == path)
            .cloned()
            .collect()
    }

    pub fn asked(&self) -> usize {
        self.script.lock().unwrap().seen.len()
    }

    pub fn wait_for(&self, path: &str, count: usize, within: Duration) {
        let until = Instant::now() + within;
        while self.seen(path).len() < count {
            assert!(
                Instant::now() < until,
                "{path} was asked for {} time(s) of {count} within {within:?}",
                self.seen(path).len()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Scripted {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        for stream in self.open.lock().unwrap().drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
        // The accept loop is blocked on the next connection; this is it.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn serve(stream: TcpStream, script: &Mutex<Script>, stopping: &AtomicBool) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let target = request_line.split_whitespace().nth(1).unwrap_or("/");
    let path = target.split('?').next().unwrap_or("/").to_string();
    let mut last_event_id = None;
    let mut authorization = None;
    let mut length = None;
    let mut chunked = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("last-event-id") {
                last_event_id = Some(value.trim().to_string());
            } else if name.eq_ignore_ascii_case("authorization") {
                authorization = Some(value.trim().to_string());
            } else if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            } else if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = value.trim().eq_ignore_ascii_case("chunked");
            }
        }
    }
    let body = if chunked {
        read_chunked(&mut reader)
    } else {
        let mut body = vec![0; length.unwrap_or(0)];
        let _ = reader.read_exact(&mut body);
        body
    };
    let answer = {
        let mut script = script.lock().unwrap();
        script.seen.push(Seen {
            path: path.clone(),
            last_event_id,
            authorization,
            body,
        });
        match script.answers.get_mut(&path) {
            Some(answers) if answers.len() > 1 => Some(answers.remove(0)),
            Some(answers) => answers.first().cloned(),
            None => None,
        }
    };
    let mut stream = stream;
    let answer = answer.unwrap_or_else(|| Answer::Json {
        status: 404,
        body: format!(r#"{{"error":{{"code":"not_found","message":"no answer for {path}"}}}}"#),
        headers: Vec::new(),
    });
    match answer {
        Answer::Json {
            status,
            body,
            headers,
        } => {
            let mut head = format!(
                "HTTP/1.1 {status} Scripted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                body.len()
            );
            if !headers
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(CONTRACT_HEADER))
            {
                head.push_str(&format!("{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\n"));
            }
            for (name, value) in headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            let _ = write!(stream, "{head}\r\n{body}");
        }
        Answer::Stream { frames, then } => {
            let chunked = matches!(then, Then::Break);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n{CONTRACT_HEADER}: {CONTRACT_VERSION}\r\n{}\r\n",
                if chunked {
                    "Transfer-Encoding: chunked\r\n"
                } else {
                    ""
                }
            );
            let body: String = frames.concat();
            if chunked {
                let _ = write!(stream, "{:x}\r\n{body}\r\n", body.len());
                // A chunk that promises more than it carries.
                let _ = write!(stream, "100\r\npartial");
            } else {
                let _ = stream.write_all(body.as_bytes());
            }
            let _ = stream.flush();
            if let Then::Later {
                keepalive,
                after,
                frames,
            } = &then
            {
                let started = Instant::now();
                let mut said = Instant::now();
                while !stopping.load(Ordering::Relaxed) && started.elapsed() < *after {
                    thread::sleep(Duration::from_millis(5));
                    if said.elapsed() >= *keepalive {
                        if stream.write_all(b": keepalive\n\n").is_err() {
                            return;
                        }
                        said = Instant::now();
                    }
                }
                if stream.write_all(frames.concat().as_bytes()).is_err() {
                    return;
                }
                while !stopping.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            if let Then::Hold { keepalive, lasting } = then {
                let started = Instant::now();
                let mut said = Instant::now();
                while !stopping.load(Ordering::Relaxed)
                    && lasting.is_none_or(|lasting| started.elapsed() < lasting)
                {
                    thread::sleep(Duration::from_millis(5));
                    if let Some(every) = keepalive
                        && said.elapsed() >= every
                    {
                        if stream.write_all(b": keepalive\n\n").is_err() {
                            return;
                        }
                        said = Instant::now();
                    }
                }
            }
        }
        Answer::Stall => {
            while !stopping.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

fn read_chunked(reader: &mut impl BufRead) -> Vec<u8> {
    let mut body = Vec::new();
    loop {
        let mut size = String::new();
        if reader.read_line(&mut size).unwrap_or(0) == 0 {
            return body;
        }
        let size = size.trim().split(';').next().unwrap_or("");
        let Ok(size) = usize::from_str_radix(size, 16) else {
            return body;
        };
        if size == 0 {
            let mut trailer = String::new();
            let _ = reader.read_line(&mut trailer);
            return body;
        }
        let mut chunk = vec![0; size + 2];
        if reader.read_exact(&mut chunk).is_err() {
            return body;
        }
        body.extend_from_slice(&chunk[..size]);
    }
}

pub fn connected() -> String {
    ": connected\n\n".into()
}

pub fn event(id: &str, name: &str, payload: &str) -> String {
    format!("id: {id}\nevent: {name}\ndata: {payload}\n\n")
}

pub fn stream_cursor(cursor: &str) -> String {
    format!(
        "event: stream_cursor\ndata: {{\"type\":\"stream_cursor\",\"cursor\":\"{cursor}\"}}\n\n"
    )
}

pub fn stream_live(cursor: Option<&str>) -> String {
    let cursor = cursor.map_or("null".to_string(), |cursor| format!("\"{cursor}\""));
    format!("event: stream_live\ndata: {{\"type\":\"stream_live\",\"cursor\":{cursor}}}\n\n")
}

pub fn item_payload(event: &str, id: &str, r#type: &str, version: i64) -> String {
    format!(
        r#"{{"type":"{event}","item":{{"id":"{id}","type":"{type}","properties":{{"title":"{id}"}},"state":"active","tier":"library","version":{version},"schema_version":1,"source":"test","occurred_at":"2026-01-01T00:00:00Z","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}},"metadata":{{"tags":[]}}}}"#
    )
}

pub fn types(entries: &[(&str, Option<&str>)]) -> Answer {
    let data: Vec<String> = entries
        .iter()
        .map(|(id, parent)| match parent {
            Some(parent) => format!(
                r#"{{"id":"{id}","parent":"{parent}","display_hints":{{"title_field":"title"}}}}"#
            ),
            None => format!(r#"{{"id":"{id}","display_hints":{{"title_field":"title"}}}}"#),
        })
        .collect();
    json(
        200,
        &format!(r#"{{"data":[{}],"next_cursor":null}}"#, data.join(",")),
    )
}

/// Edge types as the listing answers them, each `(id, reverse name)`.
pub fn edge_types(entries: &[(&str, Option<&str>)]) -> Answer {
    let data: Vec<String> = entries
        .iter()
        .map(|(id, reverse)| {
            let reverse = reverse.map_or(String::new(), |name| {
                format!(r#","reverse_name":"{name}","written_at":"target""#)
            });
            let written = if reverse.is_empty() {
                r#","written_at":"source""#
            } else {
                ""
            };
            format!(
                r#"{{"id":"{id}","cardinality":"many-to-many","source_type_constraints":["*"],"target_type_constraints":["*"],"cascade_on_delete":"orphan","property_schema":{{}},"shipped":false{reverse}{written}}}"#
            )
        })
        .collect();
    json(
        200,
        &format!(r#"{{"data":[{}],"next_cursor":null}}"#, data.join(",")),
    )
}

pub fn json(status: u16, body: &str) -> Answer {
    Answer::Json {
        status,
        body: body.into(),
        headers: Vec::new(),
    }
}

pub fn refusal(status: u16, code: &str) -> Answer {
    json(
        status,
        &format!(r#"{{"error":{{"code":"{code}","message":"scripted"}}}}"#),
    )
}

pub fn stream(frames: Vec<String>, then: Then) -> Answer {
    Answer::Stream { frames, then }
}
