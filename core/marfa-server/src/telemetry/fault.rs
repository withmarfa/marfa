//! An unhandled fault as the sinks see it: a fixed kind, a message safe to leave
//! the process, and a stack. A database failure is never described by the
//! driver's text, which can quote the statement's bound values.

use std::cell::RefCell;
use std::panic::PanicHookInfo;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

use backtrace::Backtrace;
use marfa_telemetry::exception::Frame;

const MAX_FRAMES: usize = 48;
const DATABASE_FAILED: &str = "Database operation failed";
const DRIVER_MARKS: [&str; 6] = [
    "sqlite",
    "SqlInputError",
    "rusqlite",
    "no such table",
    "no such column",
    "constraint failed",
];

/// Whether a stack is worth taking: only while a sink that carries one is on.
static CAPTURING: AtomicBool = AtomicBool::new(false);

pub fn capture_stacks(on: bool) {
    CAPTURING.store(on, Ordering::Relaxed);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Database,
    Panic,
    Internal,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Database => "DatabaseFailure",
            Kind::Panic => "Panic",
            Kind::Internal => "InternalError",
        }
    }
}

#[derive(Debug)]
pub struct Fault {
    pub kind: Kind,
    pub message: String,
    /// The SQLite result code of a failed statement.
    database_code: Option<&'static str>,
    stack: Option<Backtrace>,
}

impl Fault {
    pub fn database(code: &'static str) -> Fault {
        Fault {
            database_code: Some(code),
            ..Fault::new(Kind::Database, format!("{DATABASE_FAILED} ({code})"), None)
        }
    }

    pub fn database_code(&self) -> Option<&'static str> {
        self.database_code
    }

    pub fn retold(&self, message: String) -> Fault {
        Fault {
            kind: self.kind,
            message,
            database_code: self.database_code,
            stack: self.stack.clone(),
        }
    }

    pub fn internal(context: &str) -> Fault {
        Fault::new(Kind::Internal, context.to_string(), None)
    }

    pub fn panicked(context: &str) -> Fault {
        match NOTED.with(|noted| noted.borrow_mut().take()) {
            Some(noted) => {
                let kind = noted.kind;
                Fault::new(kind, noted.message, noted.stack)
            }
            None => Fault::new(Kind::Panic, context.to_string(), None),
        }
    }

    fn new(kind: Kind, message: String, stack: Option<Backtrace>) -> Fault {
        let stack = stack.or_else(|| {
            CAPTURING
                .load(Ordering::Relaxed)
                .then(Backtrace::new_unresolved)
        });
        Fault {
            kind,
            message,
            database_code: None,
            stack,
        }
    }

    /// Resolving reads the binary's debug information: call from a thread of its own.
    pub fn frames(&self) -> Option<Vec<Frame>> {
        let mut stack = self.stack.clone()?;
        stack.resolve();
        let mut frames: Vec<Frame> = stack
            .frames()
            .iter()
            .flat_map(|frame| frame.symbols())
            .map(|symbol| {
                let function = symbol
                    .name()
                    .map_or_else(|| "<unknown>".to_string(), |name| name.to_string());
                let (function, module) = split(&function);
                let filename = symbol
                    .filename()
                    .map(|path| tidy_path(&path.display().to_string()));
                Frame {
                    in_app: module
                        .as_deref()
                        .is_some_and(|module| module.starts_with("marfa_"))
                        || filename
                            .as_deref()
                            .is_some_and(|path| path.starts_with("marfa-")),
                    function,
                    module,
                    filename,
                    line: symbol.lineno(),
                    column: symbol.colno(),
                }
            })
            .collect();
        let lead = frames
            .iter()
            .position(|frame| frame.in_app && !is_own(frame))
            .unwrap_or(frames.len());
        let cut = frames[..lead]
            .iter()
            .rposition(is_machinery)
            .map_or(0, |last| last + 1);
        frames.drain(..cut);
        frames.retain(|frame| !THREAD_STARTERS.contains(&frame.function.as_str()));
        frames.truncate(MAX_FRAMES);
        Some(frames)
    }
}

/// Generic arguments, compiler crate disambiguators and the trailing hash are dropped.
fn split(symbol: &str) -> (String, Option<String>) {
    let mut plain = String::with_capacity(symbol.len());
    let mut rest = symbol;
    while let Some(open) = rest.find('[') {
        match rest[open..].find(']') {
            Some(close)
                if rest[open + 1..open + close]
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit()) =>
            {
                plain.push_str(&rest[..open]);
                rest = &rest[open + close + 1..];
            }
            _ => break,
        }
    }
    plain.push_str(rest);
    let plain = match plain.rsplit_once("::h") {
        Some((head, hash)) if hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()) => {
            head.to_string()
        }
        _ => plain,
    };

    let mut parts: Vec<&str> = Vec::new();
    let (mut depth, mut from, bytes) = (0usize, 0usize, plain.as_bytes());
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'<' => depth += 1,
            b'>' if at > 0 && bytes[at - 1] != b'-' => depth = depth.saturating_sub(1),
            b':' if depth == 0 && bytes.get(at + 1) == Some(&b':') => {
                // `name::<A, B>` writes the arguments of a generic as a segment.
                if parts.is_empty() || !plain[from..at].starts_with('<') {
                    parts.push(&plain[from..at]);
                }
                from = at + 2;
                at += 1;
            }
            _ => {}
        }
        at += 1;
    }
    if parts.is_empty() || !plain[from..].starts_with('<') {
        parts.push(&plain[from..]);
    }

    let last = parts.pop().unwrap_or_default();
    let function = if last.starts_with('{')
        && let Some(owner) = parts.pop()
    {
        format!("{}::{last}", generic_free(owner))
    } else {
        generic_free(last).to_string()
    };
    let module = (!parts.is_empty()).then(|| type_path(&parts.join("::")));
    (function, module)
}

fn tidy_path(path: &str) -> String {
    if let Some(at) = path.find("/core/marfa-") {
        return path[at + "/core/".len()..].to_string();
    }
    if let Some(rest) = path.strip_prefix("/rustc/") {
        return format!(
            "rustc/{}",
            rest.split_once('/').map_or(rest, |(_, tail)| tail)
        );
    }
    match path.split_once("/registry/src/") {
        Some((_, rest)) => rest
            .split_once('/')
            .map_or(rest, |(_, tail)| tail)
            .to_string(),
        None => path.to_string(),
    }
}

fn generic_free(name: &str) -> &str {
    if name.starts_with('<') {
        name
    } else {
        name.split('<').next().unwrap_or(name)
    }
}

fn type_path(module: &str) -> String {
    let inner = module.trim_start_matches('<');
    inner
        .split(['<', '>', ' '])
        .next()
        .unwrap_or(inner)
        .to_string()
}

const THREAD_STARTERS: [&str; 4] = ["__pthread_exit", "thread_start", "start_thread", "clone"];

fn is_own(frame: &Frame) -> bool {
    frame
        .module
        .as_deref()
        .is_some_and(|module| module.starts_with("marfa_server::telemetry::fault"))
        || frame.filename.as_deref() == Some("marfa-server/src/telemetry/fault.rs")
}

fn is_machinery(frame: &Frame) -> bool {
    let module = frame.module.as_deref().unwrap_or("");
    let file = frame.filename.as_deref().unwrap_or("");
    is_own(frame)
        || module.starts_with("backtrace")
        || module.starts_with("std::panicking")
        || module.starts_with("core::panicking")
        || file.starts_with("backtrace-")
        || file.ends_with("library/std/src/panicking.rs")
        || file.ends_with("library/core/src/panicking.rs")
        || frame.function == "rust_begin_unwind"
        || frame.function == "__rustc::rust_begin_unwind"
}

struct Noted {
    kind: Kind,
    message: String,
    stack: Option<Backtrace>,
}

thread_local! {
    static NOTED: RefCell<Option<Noted>> = const { RefCell::new(None) };
}

/// A message carrying a driver's error is replaced by the fixed failure and its code.
fn safe_message(message: &str) -> (Kind, String) {
    if !DRIVER_MARKS.iter().any(|mark| message.contains(mark)) {
        return (Kind::Panic, message.to_string());
    }
    let code = message
        .split_whitespace()
        .find(|word| word.starts_with("SQLITE_"))
        .map(|word| word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_'))
        .unwrap_or("SQLITE_ERROR");
    (Kind::Database, format!("{DATABASE_FAILED} ({code})"))
}

fn on_panic(info: &PanicHookInfo<'_>) {
    let payload = info.payload();
    let text = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic with no message");
    let (kind, message) = safe_message(text);
    let place = info
        .location()
        .map(|place| format!("{}:{}", place.file(), place.line()));
    tracing::error!(
        panic_message = message.as_str(),
        location = place.as_deref().unwrap_or("unknown"),
        "A thread panicked"
    );
    let message = match place {
        Some(place) => format!("{message} (at {place})"),
        None => message,
    };
    // The stack here is the panic's own, and does not wait to be asked for.
    let stack = CAPTURING
        .load(Ordering::Relaxed)
        .then(Backtrace::new_unresolved);
    let _ = NOTED.try_with(|noted| {
        *noted.borrow_mut() = Some(Noted {
            kind,
            message,
            stack,
        });
    });
}

/// Replaces the default hook, whose raw stderr message would bypass the rules above.
pub fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| std::panic::set_hook(Box::new(on_panic)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_database_fault_keeps_its_code_and_nothing_else() {
        let fault = Fault::database("SQLITE_CONSTRAINT");
        assert_eq!(fault.kind.name(), "DatabaseFailure");
        assert_eq!(
            fault.message,
            "Database operation failed (SQLITE_CONSTRAINT)"
        );
        assert_eq!(fault.database_code(), Some("SQLITE_CONSTRAINT"));
        assert_eq!(Fault::internal("context").database_code(), None);
    }

    #[test]
    fn a_panic_that_carries_a_driver_error_is_replaced_by_the_fixed_failure() {
        let (kind, message) = safe_message(
            "called `Result::unwrap()` on an `Err` value: SqliteFailure(Error { code: \
             Unknown }, Some(\"no such table: event_log INSERT INTO event_log VALUES (?)\"))",
        );
        assert_eq!(kind, Kind::Database);
        assert_eq!(message, "Database operation failed (SQLITE_ERROR)");
        let (kind, message) = safe_message("index out of bounds: the len is 3 but the index is 7");
        assert_eq!(
            (kind, message.as_str()),
            (
                Kind::Panic,
                "index out of bounds: the len is 3 but the index is 7"
            )
        );
    }

    #[test]
    fn a_symbol_splits_into_its_name_and_the_module_before_it() {
        assert_eq!(
            split("marfa_server::app::items::create::h0123456789abcdef"),
            (
                "create".to_string(),
                Some("marfa_server::app::items".to_string())
            )
        );
        assert_eq!(split("main"), ("main".to_string(), None));
        assert_eq!(
            split(
                "<<marfa_server[bd6f45b987bdf421]::db::writer::Writer>::submit<marfa_server\
                 [bd6f45b987bdf421]::app::items::write::Done>::{closure#0} as core\
                 [663bb9e1522ba5ef]::ops::function::FnOnce<()>>::call_once::{shim:vtable#0}"
            ),
            (
                "call_once::{shim:vtable#0}".to_string(),
                Some("marfa_server::db::writer::Writer".to_string())
            )
        );
        assert_eq!(
            split(
                "<marfa_server[bd6f45b987bdf421]::app::refusal::Refusal as core[663bb9e1522ba5ef]::convert::From<rusqlite[d2a5067f61221f4]::error::Error>>::from"
            ),
            (
                "from".to_string(),
                Some("marfa_server::app::refusal::Refusal".to_string())
            )
        );
    }

    #[test]
    fn a_path_names_no_machine() {
        assert_eq!(
            tidy_path("/home/x/work/core/marfa-server/src/app/mod.rs"),
            "marfa-server/src/app/mod.rs"
        );
        assert_eq!(
            tidy_path("/rustc/48a229ceaefd/library/std/src/panic.rs"),
            "rustc/library/std/src/panic.rs"
        );
        assert_eq!(
            tidy_path("/u/.cargo/registry/src/index.crates.io-1949/tokio-1.0.0/src/lib.rs"),
            "tokio-1.0.0/src/lib.rs"
        );
    }
}
