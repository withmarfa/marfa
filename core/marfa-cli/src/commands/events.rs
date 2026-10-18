use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use clap::{Args, ValueEnum};
use serde_json::{Value, json};

use crate::error::CliError;
use crate::interrupt;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// How long the stream waits for a frame before it looks for an interrupt.
const INTERRUPT_POLL: Duration = Duration::from_millis(100);

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
    // After the stream is open, since until then nothing here looks for the
    // stop and a first Ctrl-C has to end the command as it always did.
    interrupt::stop_on_interrupt();
    let (sender, frames) = mpsc::channel::<Result<Frame, std::io::Error>>();
    std::thread::spawn(move || read_frames(reader, sender));
    let started = Instant::now();
    let limit = args.r#for.map(Duration::from_secs);
    loop {
        if interrupt::stop().load(Ordering::Relaxed) {
            interrupt::ended_by_interrupt();
            return Ok(());
        }
        let wait = match limit {
            Some(limit) => match limit.checked_sub(started.elapsed()) {
                Some(remaining) => remaining.min(INTERRUPT_POLL),
                None => return Ok(()),
            },
            None => INTERRUPT_POLL,
        };
        match frames.recv_timeout(wait) {
            Ok(Ok(frame)) => {
                print_frame(&frame, out)?;
                if let Some(refusal) = terminal_refusal(&frame) {
                    return Err(refusal);
                }
            }
            Ok(Err(error)) => {
                return Err(CliError::Core(marfa_core::CoreError::Network(format!(
                    "the stream broke: {error}"
                ))));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

/// The server answers `200` and says in the last frame that it will not
/// stream from the cursor (`events/cursor-ahead`, `events/catchup-too-old`) or
/// can no longer deliver (`events/incomplete-closes`), so the status says
/// nothing of the refusal and a script reads it here. The frame's name alone
/// decides, whatever its data holds.
fn terminal_refusal(frame: &Frame) -> Option<CliError> {
    let data: Value = serde_json::from_str(&frame.data).unwrap_or(Value::Null);
    let text = |name: &str| data.get(name).and_then(Value::as_str).unwrap_or("unknown");
    match frame.event.as_deref()? {
        "cursor_ahead" => Some(CliError::Invalid(format!(
            "the cursor {} is past the end of the server's event log, which ends at {}, as after a restore from an earlier point: read the state again, then follow from a cursor the log holds",
            text("requested"),
            text("head")
        ))),
        "catchup_too_old" => Some(CliError::Invalid(format!(
            "the event log no longer holds the events after the cursor {}; the oldest it keeps is {}: read the state again, then follow from a cursor the log holds",
            text("requested"),
            text("min_retained_id")
        ))),
        // A stream held by a credential that ended is refused as a request
        // with that credential would be, so `marfa login` is the way on and
        // a retry is not.
        "stream_incomplete" if text("reason") == "credential_ended" => {
            Some(CliError::Core(marfa_core::CoreError::Unauthorized {
                code: "unauthorized".into(),
                message: "the credential that holds this stream ended".into(),
            }))
        }
        "stream_incomplete" => Some(CliError::Core(marfa_core::CoreError::StreamIncomplete {
            reason: data
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })),
        _ => None,
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
