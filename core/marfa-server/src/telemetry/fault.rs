//! An unhandled fault as the sinks see it: a fixed kind, a message that is safe
//! to leave the process, and the stack it was made on.
//!
//! A message leaves the process at every sink, so a database failure is never
//! described by what the driver said: that text is the statement, and it can
//! quote the values the statement was bound to.

use std::cell::RefCell;
use std::panic::PanicHookInfo;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

use backtrace::Backtrace;
use marfa_telemetry::exception::Frame;

/// The most frames a report carries.
const MAX_FRAMES: usize = 48;
const DATABASE_FAILED: &str = "Database operation failed";
/// What names the driver in a panic message that carries its error.
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
    /// The type error tracking groups by.
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
    stack: Option<Backtrace>,
}

impl Fault {
    /// A failed statement. Only the SQLite result code is kept of it.
    pub fn database(code: &str) -> Fault {
        Fault::new(Kind::Database, format!("{DATABASE_FAILED} ({code})"), None)
    }

    /// A fault nothing foresaw. `context` is fixed text written in the code.
    pub fn internal(context: &str) -> Fault {
        Fault::new(Kind::Internal, context.to_string(), None)
    }

    /// A panic caught on this thread, from what the hook noted of it.
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
            stack,
        }
    }

    /// The frames, outermost call last, with what the machinery of reporting
    /// and of panicking put above the fault left out. Resolving reads the
    /// binary's debug information, so this belongs on a thread of its own.
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
                Frame {
                    in_app: module
                        .as_deref()
                        .is_some_and(|module| module.starts_with("marfa_")),
                    function,
                    module,
                    filename: symbol.filename().map(|path| path.display().to_string()),
                    line: symbol.lineno(),
                    column: symbol.colno(),
                }
            })
            .collect();
        let first = frames
            .iter()
            .position(|frame| !is_machinery(frame))
            .unwrap_or(0);
        frames.drain(..first);
        frames.truncate(MAX_FRAMES);
        Some(frames)
    }
}

/// `a::b::name::h0123456789abcdef` as its name and the path before it.
fn split(symbol: &str) -> (String, Option<String>) {
    let trimmed = match symbol.rsplit_once("::h") {
        Some((head, hash)) if hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit()) => {
            head
        }
        _ => symbol,
    };
    match trimmed.rsplit_once("::") {
        Some((module, name)) if !name.starts_with('{') => {
            (name.to_string(), Some(module.to_string()))
        }
        Some((module, _)) => (
            trimmed.to_string(),
            Some(module.split("::{").next().unwrap_or(module).to_string()),
        ),
        None => (trimmed.to_string(), None),
    }
}

fn is_machinery(frame: &Frame) -> bool {
    let module = frame.module.as_deref().unwrap_or("");
    let own = module.starts_with("marfa_server::telemetry::fault");
    own || module.starts_with("backtrace")
        || module.starts_with("std::panicking")
        || module.starts_with("core::panicking")
        || frame.function == "rust_begin_unwind"
        || frame.function == "__rustc::rust_begin_unwind"
}

/// What the panic hook noted on the thread that panicked.
struct Noted {
    kind: Kind,
    message: String,
    stack: Option<Backtrace>,
}

thread_local! {
    static NOTED: RefCell<Option<Noted>> = const { RefCell::new(None) };
}

/// A panic's message, made safe to send: one that carries a driver's error
/// is replaced by the fixed failure and the code its error names.
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

/// Takes the panic hook, which the default one's raw message on standard
/// error would otherwise bypass every rule above.
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
    }

    #[test]
    fn a_stack_is_taken_only_while_a_sink_wants_one() {
        capture_stacks(false);
        assert!(Fault::internal("x").frames().is_none());
        capture_stacks(true);
        let frames = Fault::internal("x").frames().expect("a stack");
        capture_stacks(false);
        assert!(!frames.is_empty());
        assert!(
            frames.iter().all(|frame| !is_machinery(frame)),
            "{frames:#?}"
        );
    }
}
