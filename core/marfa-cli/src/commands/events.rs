use std::io::{BufRead, BufReader, Read};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use clap::{Args, ValueEnum};
use serde_json::{Value, json};

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Read the instance's event stream, one frame per line.
#[derive(Debug, Default, Args)]
pub struct EventsArgs {
    /// A type identifier to narrow to, repeatable up to ten; subtypes are
    /// included.
    #[arg(long = "type", value_name = "TYPE")]
    pub types: Vec<String>,
    /// Whether edge events ride along: `all` (the default) or `none`.
    #[arg(long)]
    pub edges: Option<EdgeMode>,
    /// Resume from this cursor, replaying what the log holds after it.
    #[arg(long, value_name = "CURSOR")]
    pub from: Option<String>,
    /// Stop after this many seconds. Unset, it reads until interrupted.
    #[arg(long, value_name = "SECONDS")]
    pub r#for: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum EdgeMode {
    All,
    None,
}

impl EdgeMode {
    fn as_str(self) -> &'static str {
        match self {
            EdgeMode::All => "all",
            EdgeMode::None => "none",
        }
    }
}

pub fn request(args: &EventsArgs) -> Request {
    let mut request = Request::get(&["events"])
        .query_list("type", &args.types)
        .query_opt("edges", args.edges.map(EdgeMode::as_str))
        .header("Accept", "text/event-stream")
        .streamed();
    if let Some(cursor) = &args.from {
        request = request.header("Last-Event-ID", cursor.clone());
    }
    request
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Frame {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

/// A failed read is sent as a failure, so a broken connection is not
/// reported as a stream that closed.
fn read_frames(reader: Box<dyn Read + Send>, frames: mpsc::Sender<Result<Frame, std::io::Error>>) {
    let mut frame = Frame::default();
    let mut has_content = false;
    for line in BufReader::new(reader).lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                let _ = frames.send(Err(error));
                break;
            }
        };
        if line.is_empty() {
            if has_content && frames.send(Ok(std::mem::take(&mut frame))).is_err() {
                break;
            }
            has_content = false;
            continue;
        }
        // An SSE comment line, a keep-alive.
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').unwrap_or((line.as_str(), ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "id" => frame.id = Some(value.to_string()),
            "event" => frame.event = Some(value.to_string()),
            "data" => {
                if !frame.data.is_empty() {
                    frame.data.push('\n');
                }
                frame.data.push_str(value);
            }
            _ => continue,
        }
        has_content = true;
    }
}

pub fn run(args: EventsArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let (_, reader) = remote.stream(&request(&args))?;
    let (sender, frames) = mpsc::channel::<Result<Frame, std::io::Error>>();
    std::thread::spawn(move || read_frames(reader, sender));
    let started = Instant::now();
    let limit = args.r#for.map(Duration::from_secs);
    loop {
        let remaining = match limit {
            Some(limit) => match limit.checked_sub(started.elapsed()) {
                Some(remaining) => remaining,
                None => return Ok(()),
            },
            None => Duration::from_secs(3600),
        };
        match frames.recv_timeout(remaining) {
            Ok(Ok(frame)) => print_frame(&frame, out)?,
            Ok(Err(error)) => {
                return Err(CliError::Core(marfa_core::CoreError::Network(format!(
                    "the stream broke: {error}"
                ))));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if limit.is_some() {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn print_frame(frame: &Frame, out: &Printer) -> Result<(), CliError> {
    let data: Value =
        serde_json::from_str(&frame.data).unwrap_or(Value::String(frame.data.clone()));
    out.record(
        &json!({ "id": frame.id, "event": frame.event, "data": data }),
        || {
            let subject = data
                .get("item")
                .or_else(|| data.get("edge"))
                .and_then(|record| record.get("id"))
                .and_then(Value::as_str)
                .or_else(|| data.get("cursor").and_then(Value::as_str))
                .or_else(|| data.get("min_retained_id").and_then(Value::as_str))
                .unwrap_or("");
            format!(
                "{}  {}  {}",
                frame.id.as_deref().unwrap_or("-"),
                frame.event.as_deref().unwrap_or("-"),
                subject
            )
            .trim_end()
            .to_string()
        },
    )
}
