//! Spans and events for a host that wants them, through the `tracing` crate.
//!
//! The core owns no exporter and installs no subscriber: a host that wants
//! the records installs one, and until it does `tracing` drops them. Without
//! the `telemetry` feature every macro here expands to nothing, and the crate
//! is not built, so no other source file outside the tests names it.
//!
//! What may be recorded is a closed list: the operation's name, a count, an
//! outcome word, the kind of a queued write, an HTTP status, and a Marfa
//! error code (`CoreError::code`). Never an item's content, title, tag, key,
//! natural key or id, a credential, an address, a header, a path, a query, or
//! an error's message, which can echo any of them.

#[cfg(feature = "telemetry")]
pub(crate) mod live {
    use crate::error::CoreError;

    /// Only a value of a `'static` type that is `Copy` gets through, so a
    /// count, a status or a word fixed in the source can be recorded and a
    /// borrowed string, which is where content would come from, does not
    /// compile.
    pub(crate) fn fixed<V: tracing::field::Value + Copy + 'static>(value: V) -> V {
        value
    }

    /// Ends an operation that returned an error. A stop the caller raised is
    /// not a failure, so it leaves a word on the span and no event.
    pub(crate) fn failed(span: &tracing::Span, error: &CoreError) {
        if matches!(error, CoreError::Canceled) {
            span.record("outcome", "canceled");
            return;
        }
        span.record("outcome", "error");
        tracing::error!(code = error.code(), "the operation failed");
    }

    /// A request to the server that failed and was left for the next pass
    /// instead of ending the operation.
    pub(crate) fn degraded(error: &CoreError) {
        tracing::warn!(code = error.code(), "a request to the server failed");
    }

    /// A folder holding fetched bytes that could not be synced, which the
    /// fetch carried on past.
    pub(crate) fn unsynced(error: &CoreError) {
        tracing::warn!(
            code = error.code(),
            "a folder holding fetched bytes could not be synced"
        );
    }

    /// Ends the span of one request that got no answer. An error that ends
    /// the operation is recorded by the operation, once; one it carries on
    /// past is a warning here.
    pub(crate) fn unanswered(span: &tracing::Span, error: &CoreError, ends_operation: bool) {
        if matches!(error, CoreError::Canceled) {
            span.record("outcome", "canceled");
            return;
        }
        span.record("outcome", "error");
        if !ends_operation {
            degraded(error);
        }
    }
}

/// Opens a span named `$name` for the rest of the enclosing scope. `outcome`
/// is always declared; the other fields are named here and filled by
/// `record!` or `ended!`.
#[cfg(feature = "telemetry")]
macro_rules! operation {
    ($name:literal $(, $field:ident)* $(,)?) => {
        ::tracing::info_span!(
            $name,
            outcome = ::tracing::field::Empty
            $(, $field = ::tracing::field::Empty)*
        )
        .entered()
    };
}

#[cfg(not(feature = "telemetry"))]
macro_rules! operation {
    ($name:literal $(, $field:ident)* $(,)?) => {
        $crate::telemetry::Idle
    };
}

/// The stand-in for a span when the feature is off.
#[cfg(not(feature = "telemetry"))]
pub(crate) struct Idle;

/// Sets fields the span declared.
#[cfg(feature = "telemetry")]
macro_rules! record {
    ($span:expr, $($field:ident = $value:expr),+ $(,)?) => {
        {
            $($span.record(stringify!($field), $crate::telemetry::live::fixed($value));)+
        }
    };
}

#[cfg(not(feature = "telemetry"))]
macro_rules! record {
    ($span:expr, $($field:ident = $value:expr),+ $(,)?) => {{
        let _ = &$span;
    }};
}

/// Closes out an operation from its result, a `Result<&T, &CoreError>`: on
/// success the fields given. On failure the error's code goes out as an error
/// event, or, with `unanswered` and a predicate on the error, as a warning for
/// one request that got no answer and left the operation going. The predicate
/// says whether the error ends the operation, and is the one the operation
/// itself decides by.
#[cfg(feature = "telemetry")]
macro_rules! ended {
    ($span:expr, $result:expr, |$ok:ident| { $($field:ident = $value:expr),+ $(,)? }) => {
        match $result {
            Ok($ok) => {
                $crate::telemetry::record!($span, $($field = $value),+);
            }
            Err(error) => $crate::telemetry::live::failed(&$span, error),
        }
    };
    ($span:expr, $result:expr, |$ok:ident| { $($field:ident = $value:expr),+ $(,)? }, unanswered $ends:path) => {
        match $result {
            Ok($ok) => {
                $crate::telemetry::record!($span, $($field = $value),+);
            }
            Err(error) => $crate::telemetry::live::unanswered(&$span, error, $ends(error)),
        }
    };
}

#[cfg(not(feature = "telemetry"))]
macro_rules! ended {
    ($span:expr, $result:expr, |$ok:ident| { $($field:ident = $value:expr),+ $(,)? } $(, unanswered $ends:path)?) => {{
        let _ = (&$span, &$result);
    }};
}

/// A request to the server that failed and was left for the next pass, given
/// as a `&CoreError`.
#[cfg(feature = "telemetry")]
macro_rules! degraded {
    ($error:expr) => {
        $crate::telemetry::live::degraded($error)
    };
}

#[cfg(not(feature = "telemetry"))]
macro_rules! degraded {
    ($error:expr) => {{
        let _ = $error;
    }};
}

/// A folder holding fetched bytes that could not be synced, given as a
/// `&CoreError`.
#[cfg(feature = "telemetry")]
macro_rules! unsynced {
    ($error:expr) => {
        $crate::telemetry::live::unsynced($error)
    };
}

#[cfg(not(feature = "telemetry"))]
macro_rules! unsynced {
    ($error:expr) => {{
        let _ = $error;
    }};
}

pub(crate) use {degraded, ended, operation, record, unsynced};

/// The subscriber of the thread that made it, for work it hands to a thread
/// of its own: a host that installed one for that thread alone would
/// otherwise hear nothing of the work.
#[cfg(feature = "telemetry")]
pub(crate) struct Carried(tracing::Dispatch);

#[cfg(feature = "telemetry")]
impl Carried {
    pub(crate) fn here() -> Carried {
        Carried(tracing::dispatcher::get_default(Clone::clone))
    }

    pub(crate) fn run<T>(&self, work: impl FnOnce() -> T) -> T {
        tracing::dispatcher::with_default(&self.0, work)
    }
}

#[cfg(not(feature = "telemetry"))]
pub(crate) struct Carried;

#[cfg(not(feature = "telemetry"))]
impl Carried {
    pub(crate) fn here() -> Carried {
        Carried
    }

    pub(crate) fn run<T>(&self, work: impl FnOnce() -> T) -> T {
        work()
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// The privacy rule is kept by one file naming `tracing`, so a field can
    /// only be added where a reviewer will look for it. A default
    /// `#[instrument]` would record every argument, content included.
    #[test]
    fn only_this_file_names_tracing() {
        fn rust_files(dir: &Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    rust_files(&path, found);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    found.push(path);
                }
            }
        }
        let mut files = Vec::new();
        rust_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let named: Vec<_> = files
            .iter()
            .filter(|path| !path.ends_with("telemetry.rs") && !path.ends_with("telemetry_tests.rs"))
            .filter(|path| {
                let source = std::fs::read_to_string(path).unwrap();
                source.contains("tracing::") || source.contains("#[instrument")
            })
            .collect();
        assert!(named.is_empty(), "{named:?}");
        assert!(files.iter().any(|path| path.ends_with("telemetry.rs")));
    }
}
