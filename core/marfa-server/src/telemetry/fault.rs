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
    /// The SQLite result code of a failed statement.
    database_code: Option<&'static str>,
    stack: Option<Backtrace>,
}

impl Fault {
    /// A failed statement. Only the SQLite result code is kept of it.
    pub fn database(code: &'static str) -> Fault {
        Fault {
            database_code: Some(code),
            ..Fault::new(Kind::Database, format!("{DATABASE_FAILED} ({code})"), None)
        }
    }

    /// The SQLite result code, on a fault made from a failed statement.
    pub fn database_code(&self) -> Option<&'static str> {
        self.database_code
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
            database_code: None,
            stack,
        }
    }

    /// The frames, the fault's own first, with what the machinery of reporting
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

/// A symbol as its function and the path of the module or type that holds it.
/// Generic arguments, the compiler's crate disambiguators (`[5d97c59e5e5fafcc]`)
/// and the trailing hash are left out.
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

/// A source path without the machine it was built on: a workspace file by its
/// crate, the standard library by `rustc/`, and a dependency by its crate.
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

/// A name without the arguments of a generic.
fn generic_free(name: &str) -> &str {
    if name.starts_with('<') {
        name
    } else {
        name.split('<').next().unwrap_or(name)
    }
}

/// The path of a type written `<path::Type as Trait>` or `<path::Type<A>>`.
fn type_path(module: &str) -> String {
    let inner = module.trim_start_matches('<');
    inner
        .split(['<', '>', ' '])
        .next()
        .unwrap_or(inner)
        .to_string()
}

/// Frames of the operating system that start a thread, which say nothing of
/// the fault.
const THREAD_STARTERS: [&str; 4] = ["__pthread_exit", "thread_start", "start_thread", "clone"];

/// A frame of the code that takes the stack.
fn is_own(frame: &Frame) -> bool {
    frame
        .module
        .as_deref()
        .is_some_and(|module| module.starts_with("marfa_server::telemetry::fault"))
        || frame.filename.as_deref() == Some("marfa-server/src/telemetry/fault.rs")
}

/// A frame of what takes the stack or panics, which lies above the fault.
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
