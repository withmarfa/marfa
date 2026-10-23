//! Bold and color for the lines people read, drawn only where a person is
//! reading: the stream is a terminal, `NO_COLOR` is unset or empty, `TERM` is
//! not `dumb`, and the command was not given `--json`. Each stream is judged
//! on its own, so a command piped to a program on one side and read on a
//! terminal on the other draws color on the terminal alone. Every styled
//! word keeps its text, so a color never carries meaning by itself.

use std::io::IsTerminal;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Out,
    Err,
}

static JSON: AtomicBool = AtomicBool::new(false);

/// Called once the command line is read: a command given `--json` draws
/// nothing.
pub fn set_json(json: bool) {
    JSON.store(json, Ordering::Relaxed);
}

pub fn json() -> bool {
    JSON.load(Ordering::Relaxed)
}

/// no-color.org and clig.dev: an empty `NO_COLOR` is the same as unset.
pub fn allowed(is_terminal: bool, json: bool, no_color: Option<&str>, term: Option<&str>) -> bool {
    is_terminal && !json && no_color.is_none_or(str::is_empty) && term != Some("dumb")
}

fn on(stream: Stream) -> bool {
    let is_terminal = match stream {
        Stream::Out => std::io::stdout().is_terminal(),
        Stream::Err => std::io::stderr().is_terminal(),
    };
    allowed(
        is_terminal,
        JSON.load(Ordering::Relaxed),
        std::env::var("NO_COLOR").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
    )
}

fn wrap(stream: Stream, code: &str, text: &str) -> String {
    if on(stream) {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn bold(stream: Stream, text: &str) -> String {
    wrap(stream, "1", text)
}

pub fn dim(stream: Stream, text: &str) -> String {
    wrap(stream, "2", text)
}

pub fn good(stream: Stream, text: &str) -> String {
    wrap(stream, "1;32", text)
}

pub fn bad(stream: Stream, text: &str) -> String {
    wrap(stream, "1;31", text)
}

const LABELS: [&str; 7] = [
    "Address", "Point at", "Folder", "Backup", "Settings", "Owner", "Login",
];

/// The labels that start the indented lines of a summary, in bold. The
/// padding after a label stays outside the bold, so the columns line up
/// whether or not it is drawn.
pub fn labelled(stream: Stream, text: &str) -> String {
    text.lines()
        .map(|line| {
            for label in LABELS {
                if let Some(rest) = line.strip_prefix("  ").and_then(|l| l.strip_prefix(label))
                    && rest.starts_with(' ')
                {
                    return format!("  {}{rest}", bold(stream, label));
                }
            }
            line.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::{Stream, allowed, labelled};

    #[test]
    fn the_labels_of_a_summary_keep_their_words_and_columns_when_not_drawn() {
        // Not a terminal under test, so nothing is drawn.
        let text = "Marfa 0.0.1 is running.\n\n  Address   https://m.example\n  Point at  http://localhost:8600 (here)\n  Folder    /x\nAddress is not a label here";
        assert_eq!(labelled(Stream::Out, text), text);
    }

    #[test]
    fn color_is_drawn_only_on_a_terminal_that_wants_it() {
        assert!(allowed(true, false, None, Some("xterm-256color")));
        assert!(allowed(true, false, Some(""), None));
        // Each condition alone turns it off.
        assert!(!allowed(false, false, None, Some("xterm")));
        assert!(!allowed(true, true, None, Some("xterm")));
        assert!(!allowed(true, false, Some("1"), Some("xterm")));
        assert!(!allowed(true, false, Some("0"), Some("xterm")));
        assert!(!allowed(true, false, None, Some("dumb")));
    }
}
