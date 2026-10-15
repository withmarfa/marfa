//! The `tracing` layer that turns the core's spans and the command's own into
//! `Finished` spans.
//!
//! Privacy is kept here as well as in the core: the layer exports a span's
//! name, the fields on the allowlist below and nothing else, and a word only
//! when it looks like one. The core records no more than that either, so a
//! field added there reaches a collector only once it is added to this list.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

use super::export::Sink;
use super::otlp::{self, Attribute, Finished};

/// Counts and statuses.
pub const NUMBERS: &[&str] = &[
    "answered",
    "applied",
    "dropped_spans",
    "exit_code",
    "held",
    "hits",
    "skipped",
    "status",
    "unmade",
    "undelivered",
    "unsent",
];

/// Names the code fixes: an outcome, a write's kind, an error code.
pub const WORDS: &[&str] = &["code", "kind", "outcome"];

/// The span the command opens, and the field that names it.
pub const ROOT: &str = "command";

/// A name is a few plain characters, so that nothing a person typed or stored
/// can ride in on a field that is allowed.
const LONGEST: usize = 64;

fn plain(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= LONGEST
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b' '))
}

/// Most events kept on one span.
const MOST_EVENTS: usize = 32;

struct Open {
    id: [u8; 8],
    parent: Option<[u8; 8]>,
    name: String,
    start: SystemTime,
    began: Instant,
    attributes: Vec<(&'static str, Attribute)>,
    events: Vec<otlp::Event>,
    error: bool,
}

/// Collects the allowed fields of a span or an event.
struct Fields<'a> {
    attributes: &'a mut Vec<(&'static str, Attribute)>,
    /// Set only for the root span, whose name is a field's value.
    name: Option<&'a mut Option<String>>,
}

impl Fields<'_> {
    fn set(&mut self, key: &'static str, value: Attribute) {
        self.attributes.retain(|(held, _)| *held != key);
        self.attributes.push((key, value));
    }

    fn number(&mut self, field: &Field, value: i64) {
        if let Some(key) = NUMBERS.iter().find(|key| **key == field.name()) {
            self.set(key, Attribute::Number(value));
        }
    }
}

impl Visit for Fields<'_> {
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.number(field, i64::try_from(value).unwrap_or(i64::MAX));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.number(field, value);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if !plain(value) {
            return;
        }
        if field.name() == ROOT {
            if let Some(name) = self.name.as_deref_mut() {
                *name = Some(value.to_string());
            }
        } else if let Some(key) = WORDS.iter().find(|key| **key == field.name()) {
            self.set(key, Attribute::Word(value.to_string()));
        }
    }

    /// Everything else, a message above all, which can be built from any
    /// text, is left out.
    fn record_debug(&mut self, _: &Field, _: &dyn std::fmt::Debug) {}
}

pub struct Export {
    trace_id: [u8; 16],
    root_id: [u8; 8],
    root_taken: AtomicBool,
    sink: Arc<dyn Sink>,
}

impl Export {
    pub fn new(trace_id: [u8; 16], root_id: [u8; 8], sink: Arc<dyn Sink>) -> Export {
        Export {
            trace_id,
            root_id,
            root_taken: AtomicBool::new(false),
            sink,
        }
    }
}

/// The core's spans and events carry the `marfa_core` target and the
/// command's the binary's own; anything else that records through `tracing`
/// in this process is not ours to export.
fn ours(metadata: &tracing::Metadata<'_>) -> bool {
    let target = metadata.target();
    target == "marfa_core" || target.starts_with("marfa_core::") || target.starts_with("marfa::")
}

impl<S> Layer<S> for Export
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attributes: &Attributes<'_>, id: &Id, context: Context<'_, S>) {
        let metadata = attributes.metadata();
        if !ours(metadata) {
            return;
        }
        let Some(span) = context.span(id) else {
            return;
        };
        let is_root = metadata.name() == ROOT
            && metadata.target().starts_with("marfa::")
            && !self.root_taken.swap(true, Ordering::SeqCst);
        // A span made on a thread the command did not enter, or with no
        // parent, still belongs to this run's one trace, under its root.
        let parent = if is_root {
            None
        } else {
            span.parent()
                .and_then(|parent| parent.extensions().get::<Open>().map(|open| open.id))
                .or(Some(self.root_id))
        };
        let mut open = Open {
            id: if is_root { self.root_id } else { fresh() },
            parent,
            name: metadata.name().to_string(),
            start: SystemTime::now(),
            began: Instant::now(),
            attributes: Vec::new(),
            events: Vec::new(),
            error: false,
        };
        let mut name = None;
        attributes.record(&mut Fields {
            attributes: &mut open.attributes,
            name: is_root.then_some(&mut name),
        });
        if let Some(name) = name {
            open.name = name;
        }
        span.extensions_mut().insert(open);
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, context: Context<'_, S>) {
        let Some(span) = context.span(id) else {
            return;
        };
        if let Some(open) = span.extensions_mut().get_mut::<Open>() {
            values.record(&mut Fields {
                attributes: &mut open.attributes,
                name: None,
            });
        }
    }

    fn on_event(&self, event: &Event<'_>, context: Context<'_, S>) {
        let name = match *event.metadata().level() {
            Level::ERROR => "error",
            Level::WARN => "warning",
            _ => return,
        };
        if !ours(event.metadata()) {
            return;
        }
        let Some(span) = context.event_span(event) else {
            return;
        };
        for within in span.scope() {
            let mut extensions = within.extensions_mut();
            let Some(open) = extensions.get_mut::<Open>() else {
                continue;
            };
            if open.events.len() < MOST_EVENTS {
                let mut attributes = Vec::new();
                event.record(&mut Fields {
                    attributes: &mut attributes,
                    name: None,
                });
                open.events.push(otlp::Event {
                    name,
                    at: SystemTime::now(),
                    attributes,
                });
            }
            open.error |= name == "error";
            return;
        }
    }

    fn on_close(&self, id: Id, context: Context<'_, S>) {
        let Some(span) = context.span(&id) else {
            return;
        };
        let Some(open) = span.extensions_mut().remove::<Open>() else {
            return;
        };
        self.sink.push(Finished {
            trace_id: self.trace_id,
            span_id: open.id,
            parent: open.parent,
            name: open.name,
            start: open.start,
            end: open.start + open.began.elapsed(),
            attributes: open.attributes,
            events: open.events,
            error: open.error,
        });
    }
}

/// A random id for a span. The operating system's source failing leaves the
/// clock and a counter, which are unique if not unguessable.
pub fn fresh() -> [u8; 8] {
    random()
}

pub fn random<const N: usize>() -> [u8; N] {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let mut bytes = [0u8; N];
    if getrandom::fill(&mut bytes).is_err() || bytes.iter().all(|byte| *byte == 0) {
        let seed = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(1, |since| since.as_nanos() as u64)
            ^ COUNTER.fetch_add(1, Ordering::Relaxed).rotate_left(32);
        for (at, byte) in bytes.iter_mut().enumerate() {
            *byte = (seed >> ((at % 8) * 8)) as u8 | u8::from(at == 0);
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tracing_subscriber::layer::SubscriberExt;

    use super::*;

    #[derive(Default)]
    struct Collected(Mutex<Vec<Finished>>);

    impl Sink for Collected {
        fn push(&self, span: Finished) {
            self.0.lock().unwrap().push(span);
        }
    }

    const TRACE: [u8; 16] = [9; 16];
    const ROOT_ID: [u8; 8] = [1; 8];

    fn recorded(run: impl FnOnce()) -> Vec<Finished> {
        let sink = Arc::new(Collected::default());
        let subscriber = tracing_subscriber::registry().with(Export::new(
            TRACE,
            ROOT_ID,
            Arc::clone(&sink) as Arc<dyn Sink>,
        ));
        tracing::subscriber::with_default(subscriber, run);
        sink.0.lock().unwrap().clone()
    }

    fn root() -> tracing::Span {
        tracing::info_span!(
            "command",
            command = "marfa items create",
            exit_code = tracing::field::Empty
        )
    }

    #[test]
    fn the_root_is_named_for_the_command_and_everything_else_hangs_from_it() {
        let spans = recorded(|| {
            let root = root();
            root.in_scope(|| {
                let _drain =
                    tracing::info_span!("drain", outcome = "ok", answered = 2u64).entered();
                {
                    let _write =
                        tracing::info_span!("write", kind = "create_item", status = 201u16)
                            .entered();
                }
            });
            // Entered on no thread of the command's, as a watch's helpers are.
            let _alone = tracing::info_span!(parent: None, "catch_up", applied = 4usize).entered();
        });
        let by = |name: &str| spans.iter().find(|span| span.name == name).unwrap();
        let root = by("marfa items create");
        assert_eq!(root.parent, None);
        assert_eq!(root.span_id, ROOT_ID);
        assert!(spans.iter().all(|span| span.trace_id == TRACE));
        assert_eq!(by("drain").parent, Some(ROOT_ID));
        assert_eq!(by("write").parent, Some(by("drain").span_id));
        assert_eq!(by("catch_up").parent, Some(ROOT_ID));
        assert_eq!(
            by("drain").attributes,
            vec![
                ("outcome", Attribute::Word("ok".into())),
                ("answered", Attribute::Number(2))
            ]
        );
        assert_eq!(
            by("write").attributes,
            vec![
                ("kind", Attribute::Word("create_item".into())),
                ("status", Attribute::Number(201))
            ]
        );
        assert_eq!(
            by("catch_up").attributes,
            vec![("applied", Attribute::Number(4))]
        );
        let ids: std::collections::HashSet<_> = spans.iter().map(|span| span.span_id).collect();
        assert_eq!(ids.len(), spans.len());
    }

    #[test]
    fn an_error_event_marks_its_span_and_a_warning_does_not() {
        let spans = recorded(|| {
            let root = root();
            root.in_scope(|| {
                let _ok = tracing::info_span!("drain", outcome = tracing::field::Empty).entered();
                tracing::warn!(code = "network", "a request to the server failed");
                let _bad = tracing::info_span!("search").entered();
                tracing::error!(code = "store", "the operation failed");
                tracing::info!(code = "ignored", "not an error or a warning");
            });
        });
        let by = |name: &str| spans.iter().find(|span| span.name == name).unwrap();
        assert!(by("search").error);
        assert!(!by("drain").error);
        assert_eq!(by("search").events.len(), 1);
        assert_eq!(by("search").events[0].name, "error");
        assert_eq!(
            by("search").events[0].attributes,
            vec![("code", Attribute::Word("store".into()))]
        );
        assert_eq!(by("drain").events[0].name, "warning");
    }

    #[test]
    fn a_value_recorded_later_lands_on_its_span() {
        let spans = recorded(|| {
            let root = root();
            root.record("exit_code", 3u64);
        });
        assert_eq!(
            spans[0].attributes,
            vec![("exit_code", Attribute::Number(3))]
        );
    }

    /// The witness is the allowed fields beside them in the same spans: the
    /// layer does export, and exports only what is on the list.
    #[test]
    fn only_the_allowlist_is_exported_and_a_word_only_when_it_is_plain() {
        let secret = "SECRET-token-123";
        let spans = recorded(|| {
            let root = root();
            root.in_scope(|| {
                let _span = tracing::info_span!(
                    "write",
                    outcome = "ok",
                    kind = "create_item",
                    status = 201u16,
                    title = secret,
                    body = ?secret,
                    id = secret,
                    path = "/home/person/notes",
                    count = 5u64,
                    key = tracing::field::Empty,
                )
                .entered();
                tracing::error!(
                    code = "network",
                    message = secret,
                    error = secret,
                    url = secret,
                    "failed for {secret}"
                );
                tracing::error!(code = "https://u:SECRET-token-123@host/?q=1", "bad code");
                let _plain =
                    tracing::info_span!("write", outcome = "has/slash?and=query").entered();
            });
        });
        let text = format!("{spans:?}");
        assert!(!text.contains("SECRET"), "{text}");
        assert!(!text.contains("/home"), "{text}");
        assert!(!text.contains("failed for"), "{text}");
        let write = spans
            .iter()
            .find(|span| span.name == "write" && !span.attributes.is_empty())
            .unwrap();
        assert!(
            write
                .attributes
                .contains(&("outcome", Attribute::Word("ok".into())))
        );
        assert!(
            write
                .attributes
                .contains(&("kind", Attribute::Word("create_item".into())))
        );
        assert!(
            write
                .attributes
                .contains(&("status", Attribute::Number(201)))
        );
        assert_eq!(write.attributes.len(), 3);
        assert_eq!(
            write.events[0].attributes,
            vec![("code", Attribute::Word("network".into()))]
        );
        assert_eq!(write.events.len(), 2);
        assert!(write.events[1].attributes.is_empty());
    }

    #[test]
    fn what_is_not_ours_is_not_exported() {
        let spans = recorded(|| {
            let root = root();
            root.in_scope(|| {
                let _other =
                    tracing::info_span!(target: "some_other_crate", "request", outcome = "ok")
                        .entered();
                tracing::error!(target: "some_other_crate", code = "x", "boom");
            });
        });
        assert_eq!(spans.len(), 1);
        assert!(spans[0].events.is_empty());
    }

    #[test]
    fn a_name_that_is_not_plain_does_not_name_the_root() {
        let spans = recorded(|| {
            let _root = tracing::info_span!("command", command = "marfa a/b?c=d");
        });
        assert_eq!(spans[0].name, "command");
    }

    #[test]
    fn events_on_one_span_are_bounded() {
        let spans = recorded(|| {
            let root = root();
            root.in_scope(|| {
                for _ in 0..(MOST_EVENTS + 10) {
                    tracing::warn!(code = "network", "again");
                }
            });
        });
        assert_eq!(spans[0].events.len(), MOST_EVENTS);
    }

    #[test]
    fn ids_are_random_and_never_zero() {
        let a: [u8; 16] = random();
        let b: [u8; 16] = random();
        assert_ne!(a, b);
        assert_ne!(a, [0; 16]);
        assert_ne!(fresh(), [0; 8]);
    }
}
