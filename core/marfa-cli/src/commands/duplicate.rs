//! Duplicate checking before file uploads.

use std::fs::File;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::Path;

use clap::ValueEnum;
use serde_json::{Value, json};

use super::blobs::hash_read;
use crate::error::CliError;
use crate::output::{Printer, printable};
use crate::remote::Remote;
use crate::remote::request::Request;

/// `items/blobs-list` answers 20 holders when more remain, and every holder otherwise.
const HOLDER_PAGE: usize = 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, ValueEnum)]
pub enum IfDuplicate {
    #[default]
    Ask,
    Add,
    Skip,
}

#[derive(Debug)]
pub struct Matches {
    items: Vec<Value>,
    more: bool,
}

impl Matches {
    fn as_json(&self) -> Value {
        json!({ "items": self.items, "more": self.more })
    }

    fn lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self.items.iter().map(describe).collect();
        if self.more {
            lines.push("and more".into());
        }
        lines
    }
}

#[derive(Debug)]
pub enum Added<T> {
    /// The file was uploaded. `found` is a match for those bytes.
    Uploaded { uploaded: T, found: Option<Matches> },
    /// Nothing was uploaded. `found` matches the bytes that were read.
    Held(Matches),
}

/// The file's name as a line may carry it.
pub fn shown(file: &Path) -> String {
    printable(&file.display().to_string())
}

fn describe(item: &Value) -> String {
    let text = |name: &str| item.get(name).and_then(Value::as_str);
    format!(
        "{} ({}, {})",
        printable(text("title").unwrap_or("untitled")),
        printable(text("type").unwrap_or("")),
        printable(text("id").unwrap_or(""))
    )
}

pub fn lookup_request(hashes: &[String]) -> Request {
    Request::post(&["items", "blobs"])
        .json(json!({ "hashes": hashes }))
        .reading()
}

fn invalid(what: &str) -> CliError {
    CliError::Invalid(format!("the answer was not a valid lookup: {what}"))
}

fn named(file: &Path, error: io::Error) -> CliError {
    CliError::Io(io::Error::new(
        error.kind(),
        format!("{}: {error}", shown(file)),
    ))
}

/// Holders of `hash` when the answer is the one entry `items/blobs` describes.
fn matches_in(answer: &Value, hash: &str) -> Result<Matches, CliError> {
    let entries = answer
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("data is not a list"))?;
    let [entry] = entries.as_slice() else {
        return Err(invalid("the answer did not name exactly the hash asked"));
    };
    if entry.get("hash").and_then(Value::as_str) != Some(hash) {
        return Err(invalid("the answer named another hash"));
    }
    let items = entry
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("items is not a list"))?;
    for item in items {
        let named = |name: &str| {
            item.get(name)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        };
        let titled =
            matches!(item.get("title"), Some(title) if title.is_string() || title.is_null());
        if !named("id") || !named("type") || !titled {
            return Err(invalid("an item has no id, type and title"));
        }
    }
    let more = entry
        .get("more")
        .and_then(Value::as_bool)
        .ok_or_else(|| invalid("more is not a boolean"))?;
    // A page is at most 20, and `more` is true only when that page is full.
    if items.len() > HOLDER_PAGE || (more && items.len() != HOLDER_PAGE) {
        return Err(invalid("more does not match the number of items"));
    }
    Ok(Matches {
        items: items.clone(),
        more,
    })
}

fn lookup(hash: &str, remote: &Remote) -> Result<Matches, CliError> {
    matches_in(&remote.json(&lookup_request(&[hash.to_string()]))?, hash)
}

fn hash_file(file: &Path) -> Result<String, CliError> {
    let mut opened = File::open(file).map_err(|error| named(file, error))?;
    hash_read(&mut opened).map_err(|error| named(file, error))
}

/// A pipe, a device or a fifo can be read once, so a check would consume the upload.
fn regular_file(file: &Path) -> Result<bool, CliError> {
    match std::fs::metadata(file) {
        Ok(meta) => Ok(meta.is_file()),
        Err(error) => Err(named(file, error)),
    }
}

fn warn_check(file: &Path, error: &CliError) {
    crate::errln!(
        "could not check whether Marfa already holds {}: {}; adding it",
        shown(file),
        printable(&error.to_string())
    );
}

fn warn_stream(file: &Path) {
    crate::errln!(
        "could not check whether Marfa already holds {}: a stream cannot be checked; adding it",
        shown(file)
    );
}

fn warn_changed(file: &Path) {
    crate::errln!(
        "{}: the file changed while it was being checked, so the check did not cover what was added",
        shown(file)
    );
}

fn say_adding(file: &Path, found: &Matches) {
    crate::errln!(
        "{} is already in Marfa as {}; adding it anyway",
        shown(file),
        found.lines().join(", ")
    );
}

fn interactive(json: bool) -> bool {
    !json && io::stdin().is_terminal() && crate::output::stderr_is_terminal()
}

/// `true` where the file should be uploaded despite `found`.
fn add_despite(
    file: &Path,
    mode: IfDuplicate,
    json: bool,
    found: &Matches,
) -> Result<bool, CliError> {
    match mode {
        IfDuplicate::Skip => Ok(false),
        IfDuplicate::Add => Ok(true),
        IfDuplicate::Ask if interactive(json) => {
            let mut question = crate::output::stderr();
            asks_to_add_anyway(file, found, &mut io::stdin().lock(), &mut question)
        }
        IfDuplicate::Ask => Ok(true),
    }
}

fn asks_to_add_anyway(
    file: &Path,
    found: &Matches,
    answers: &mut impl BufRead,
    question: &mut impl Write,
) -> Result<bool, CliError> {
    writeln!(question, "{} is already in Marfa:", shown(file))?;
    for line in found.lines() {
        writeln!(question, "  {line}")?;
    }
    write!(question, "Add it anyway? [y/N] ")?;
    question.flush()?;
    let mut answer = String::new();
    answers.read_line(&mut answer)?;
    Ok(matches!(answer.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// Read a regular file, ask the lookup, then call `upload` at most once.
pub fn checked_upload<T>(
    file: &Path,
    mode: IfDuplicate,
    json: bool,
    remote: &Remote,
    upload: impl FnOnce() -> Result<(T, String), CliError>,
) -> Result<Added<T>, CliError> {
    if mode == IfDuplicate::Add {
        let (uploaded, _) = upload()?;
        return Ok(Added::Uploaded {
            uploaded,
            found: None,
        });
    }
    if !regular_file(file)? {
        warn_stream(file);
        let (uploaded, _) = upload()?;
        return Ok(Added::Uploaded {
            uploaded,
            found: None,
        });
    }
    let hash = hash_file(file)?;
    let found = match lookup(&hash, remote) {
        Ok(found) if found.items.is_empty() => None,
        Ok(found) => {
            if !add_despite(file, mode, json, &found)? {
                return Ok(Added::Held(found));
            }
            Some(found)
        }
        Err(error) => {
            warn_check(file, &error);
            None
        }
    };
    let (uploaded, sent) = upload()?;
    if sent != hash {
        warn_changed(file);
        return Ok(Added::Uploaded {
            uploaded,
            found: None,
        });
    }
    if let Some(found) = found.as_ref().filter(|_| !interactive(json)) {
        say_adding(file, found);
    }
    Ok(Added::Uploaded { uploaded, found })
}

pub fn report_held(file: &Path, found: &Matches, out: &Printer) -> Result<(), CliError> {
    out.report(
        &json!({ "added": false, "duplicates": found.as_json() }),
        |_| {
            let mut lines = vec![format!(
                "{file} not added: Marfa already holds a file with the same contents as this one when it was checked",
                file = shown(file)
            )];
            lines.extend(found.lines().into_iter().map(|line| format!("  {line}")));
            lines.join("\n")
        },
    )
}

pub fn with_matches(mut answer: Value, found: Option<&Matches>) -> Value {
    if let Some(found) = found {
        answer["duplicates"] = found.as_json();
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found() -> Matches {
        Matches {
            items: vec![json!({"id": "i1", "type": "core.file", "title": "Harbor"})],
            more: true,
        }
    }

    fn asked(reply: &str) -> (bool, String) {
        let mut said = Vec::new();
        let agreed = asks_to_add_anyway(
            Path::new("harbor.png"),
            &found(),
            &mut reply.as_bytes(),
            &mut said,
        )
        .unwrap();
        (agreed, String::from_utf8(said).unwrap())
    }

    #[test]
    fn the_question_names_each_match_and_more_and_only_yes_adds() {
        for reply in ["y\n", "YES\n", " yes \n"] {
            assert!(asked(reply).0, "{reply:?}");
        }
        for reply in ["", "\n", "n\n", "no\n", "yep\n", "add\n"] {
            assert!(!asked(reply).0, "{reply:?}");
        }
        let said = asked("n\n").1;
        assert!(said.contains("Harbor (core.file, i1)"), "{said}");
        assert!(said.contains("and more"), "{said}");
        assert!(said.ends_with("Add it anyway? [y/N] "), "{said}");
    }

    #[test]
    fn a_title_cannot_move_the_cursor() {
        let item = json!({"id": "i1", "type": "core.file", "title": "a\u{1b}[2Jb"});
        assert!(!describe(&item).contains('\u{1b}'));
        assert!(describe(&json!({"id": "i2", "type": "core.note"})).contains("untitled"));
    }

    #[test]
    fn a_file_name_cannot_move_the_cursor_in_the_question_or_the_report() {
        let name = Path::new("a\nb\u{1b}[2Jc.png");
        let mut said = Vec::new();
        asks_to_add_anyway(name, &found(), &mut "n\n".as_bytes(), &mut said).unwrap();
        let said = String::from_utf8(said).unwrap();
        assert!(!said.contains('\u{1b}'), "{said:?}");
        assert!(
            said.lines()
                .next()
                .unwrap()
                .ends_with("is already in Marfa:"),
            "{said:?}"
        );
        assert!(!shown(name).contains('\n'));
    }

    fn entry(hash: &str, rest: Value) -> Value {
        let mut entry = json!({ "hash": hash });
        for (name, value) in rest.as_object().unwrap() {
            entry[name] = value.clone();
        }
        json!({ "data": [entry] })
    }

    fn page(count: usize) -> Value {
        Value::Array(
            (0..count)
                .map(|n| json!({"id": format!("i{n}"), "type": "t", "title": "T"}))
                .collect(),
        )
    }

    #[test]
    fn only_a_whole_answer_for_the_hash_asked_is_believed() {
        let item = json!({"id": "i1", "type": "core.file", "title": "Harbor"});
        let whole = entry("h", json!({"items": [item], "more": false}));
        assert_eq!(matches_in(&whole, "h").unwrap().items.len(), 1);
        let full = entry("h", json!({"items": page(HOLDER_PAGE), "more": true}));
        assert_eq!(matches_in(&full, "h").unwrap().items.len(), HOLDER_PAGE);
        let exact = entry("h", json!({"items": page(HOLDER_PAGE), "more": false}));
        assert!(!matches_in(&exact, "h").unwrap().more);
        let null_title = entry(
            "h",
            json!({"items": [{"id": "i", "type": "t", "title": null}], "more": false}),
        );
        assert_eq!(matches_in(&null_title, "h").unwrap().items.len(), 1);
        for (name, answer) in [
            ("another hash", whole.clone()),
            (
                "empty item",
                entry("h", json!({"items": [{}], "more": false})),
            ),
            (
                "no type",
                entry("h", json!({"items": [{"id": "i"}], "more": false})),
            ),
            (
                "numeric id",
                entry(
                    "h",
                    json!({"items": [{"id": 1, "type": "t"}], "more": false}),
                ),
            ),
            (
                "numeric title",
                entry(
                    "h",
                    json!({"items": [{"id": "i", "type": "t", "title": 4}], "more": false}),
                ),
            ),
            (
                "items an object",
                entry(
                    "h",
                    json!({"items": {"id": "i", "type": "t"}, "more": false}),
                ),
            ),
            ("items missing", entry("h", json!({"more": false}))),
            ("more missing", entry("h", json!({"items": []}))),
            (
                "more a string",
                entry("h", json!({"items": [], "more": "no"})),
            ),
            (
                "more with no holders",
                entry("h", json!({"items": [], "more": true})),
            ),
            (
                "more with fewer than a page",
                entry(
                    "h",
                    json!({"items": [{"id": "i", "type": "t", "title": "T"}], "more": true}),
                ),
            ),
            (
                "more than a page",
                entry("h", json!({"items": page(HOLDER_PAGE + 1), "more": false})),
            ),
            (
                "more than a page with more set",
                entry("h", json!({"items": page(HOLDER_PAGE + 1), "more": true})),
            ),
            ("no data", json!({})),
            (
                "title missing",
                entry(
                    "h",
                    json!({"items": [{"id": "i", "type": "t"}], "more": false}),
                ),
            ),
            (
                "two entries",
                json!({
                    "data": [
                        {"hash": "h", "items": [{"id": "a", "type": "t", "title": "A"}], "more": false},
                        {"hash": "h", "items": [], "more": false}
                    ]
                }),
            ),
            (
                "another hash beside it",
                json!({
                    "data": [
                        {"hash": "h", "items": [], "more": false},
                        {"hash": "other", "items": [], "more": false}
                    ]
                }),
            ),
        ] {
            let asked = if name == "another hash" { "other" } else { "h" };
            assert!(matches_in(&answer, asked).is_err(), "{name}");
        }
    }

    use crate::door::{Answer, Received, read_request};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// A server for `requests` requests: `act` answers each.
    fn serve(
        requests: usize,
        mut act: impl FnMut(usize, &Received) -> Option<Answer> + Send + 'static,
    ) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for at in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let received = read_request(&mut stream);
                if let Some(answer) = act(at, &received) {
                    write!(
                        stream,
                        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n{}",
                        answer.status,
                        answer.body.len(),
                        answer
                            .headers
                            .iter()
                            .map(|(name, value)| format!("{name}: {value}\r\n"))
                            .collect::<String>(),
                        answer.body
                    )
                    .unwrap();
                }
            }
            std::thread::sleep(Duration::from_secs(3));
        });
        url
    }

    fn asked_hash(received: &Received) -> String {
        let body: Value = serde_json::from_str(&received.body).unwrap();
        body["hashes"][0].as_str().unwrap().to_string()
    }

    fn holders(received: &Received, held: bool) -> Option<Answer> {
        let items = if held {
            json!([{"id": "old", "type": "core.file", "title": "Old"}])
        } else {
            json!([])
        };
        Some(Answer::json(
            "200 OK",
            &entry(
                &asked_hash(received),
                json!({"items": items, "more": false}),
            )
            .to_string(),
        ))
    }

    /// Lookups answer `held`, `change` rewrites the file, and the upload reads the path.
    fn run_changing(
        mode: IfDuplicate,
        held: fn(usize) -> bool,
        change: fn(usize) -> Option<&'static [u8]>,
    ) -> (Result<Added<String>, CliError>, Vec<String>, usize) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"first").unwrap();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (seen, path) = (asked.clone(), file.clone());
        let url = serve(4, move |at, received| {
            seen.lock().unwrap().push(asked_hash(received));
            let answer = holders(received, held(at));
            if let Some(bytes) = change(at) {
                std::fs::write(&path, bytes).unwrap();
            }
            answer
        });
        let remote = Remote::keyed(&url, "k").unwrap();
        let uploads = AtomicUsize::new(0);
        let reading = file.clone();
        let ran = checked_upload(&file, mode, true, &remote, || {
            uploads.fetch_add(1, Ordering::SeqCst);
            let mut opened = File::open(&reading).unwrap();
            Ok((
                String::from_utf8(std::fs::read(&reading).unwrap()).unwrap(),
                hash_read(&mut opened).unwrap(),
            ))
        });
        // A run that never looked up still owes the server its one accept.
        let looked_up = asked.lock().unwrap().clone();
        if looked_up.is_empty() {
            let _ = remote.json(&lookup_request(&["sha256:none".into()]));
        }
        (ran, looked_up, uploads.load(Ordering::SeqCst))
    }

    #[test]
    fn a_skip_of_a_held_snapshot_does_not_read_the_rewritten_file() {
        let (ran, asked, uploads) = run_changing(
            IfDuplicate::Skip,
            |at| at == 0,
            |at| (at == 0).then_some(b"second".as_slice()),
        );
        assert!(matches!(ran, Ok(Added::Held(_))), "{ran:?}");
        assert_eq!(asked.len(), 1);
        assert_eq!(uploads, 0);
    }

    #[test]
    fn a_file_rewritten_in_place_while_it_is_held_is_skipped_once() {
        let (ran, asked, uploads) = run_changing(
            IfDuplicate::Skip,
            |_| true,
            |at| (at == 0).then_some(b"second".as_slice()),
        );
        assert!(matches!(ran, Ok(Added::Held(_))), "{ran:?}");
        assert_eq!(asked.len(), 1);
        assert_eq!(uploads, 0);
    }

    #[test]
    fn a_changed_file_is_uploaded_once_without_another_lookup() {
        let (ran, asked, uploads) = run_changing(
            IfDuplicate::Ask,
            |_| false,
            |at| (at == 0).then_some(b"second".as_slice()),
        );
        assert!(
            matches!(ran, Ok(Added::Uploaded { found: None, ref uploaded }) if uploaded == "second"),
            "{ran:?}"
        );
        assert_eq!(asked.len(), 1);
        assert_eq!(uploads, 1);
    }

    #[test]
    fn a_file_rewritten_before_the_upload_is_added_and_not_looked_up_again() {
        let (ran, asked, uploads) = run_changing(
            IfDuplicate::Skip,
            |at| at == 1,
            |at| (at == 0).then_some(b"second".as_slice()),
        );
        assert!(
            matches!(ran, Ok(Added::Uploaded { found: None, ref uploaded }) if uploaded == "second"),
            "a changed file was skipped after its upload: {ran:?}"
        );
        assert_eq!(asked.len(), 1, "the upload was followed by another lookup");
        assert_eq!(uploads, 1);
    }

    #[test]
    fn a_path_replaced_during_the_lookup_is_not_read_again_for_a_skip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"first").unwrap();
        let path = file.clone();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let url = serve(2, move |at, received| {
            seen.lock().unwrap().push(asked_hash(received));
            if at == 0 {
                let replaced = path.with_extension("new");
                std::fs::write(&replaced, b"second").unwrap();
                std::fs::rename(&replaced, &path).unwrap();
            }
            holders(received, true)
        });
        let remote = Remote::keyed(&url, "k").unwrap();
        let uploads = AtomicUsize::new(0);
        let ran = checked_upload(&file, IfDuplicate::Skip, true, &remote, || {
            uploads.fetch_add(1, Ordering::SeqCst);
            Ok(((), "sha256:unused".into()))
        });
        assert!(matches!(ran, Ok(Added::Held(_))), "{ran:?}");
        assert_eq!(asked.lock().unwrap().len(), 1, "a skip re-read the path");
        assert_eq!(uploads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_file_that_keeps_changing_is_uploaded_at_most_once() {
        let changing = |at: usize| Some([b"a".as_slice(), b"b", b"c", b"d"][at % 4]);
        let (ran, asked, uploads) = run_changing(IfDuplicate::Skip, |_| true, changing);
        assert!(matches!(ran, Ok(Added::Held(_))), "{ran:?}");
        assert_eq!(asked.len(), 1);
        assert_eq!(uploads, 0);
        let (ran, asked, uploads) = run_changing(IfDuplicate::Ask, |_| false, changing);
        assert!(
            matches!(ran, Ok(Added::Uploaded { found: None, .. })),
            "{ran:?}"
        );
        assert_eq!(asked.len(), 1);
        assert_eq!(uploads, 1);
    }

    #[test]
    fn add_mode_uploads_without_a_lookup() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let remote = Remote::keyed(&url, "k").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"bytes").unwrap();
        let ran = checked_upload(&file, IfDuplicate::Add, true, &remote, || {
            Ok(((), "sha256:h".into()))
        })
        .unwrap();
        assert!(matches!(ran, Added::Uploaded { found: None, .. }));
        let stream = checked_upload(
            Path::new("/dev/null"),
            IfDuplicate::Add,
            true,
            &remote,
            || Ok(((), "sha256:h".into())),
        )
        .unwrap();
        assert!(matches!(stream, Added::Uploaded { found: None, .. }));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn a_fifo_is_uploaded_once_without_a_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pipe");
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: The path is a NUL-terminated fixture path and mkfifo retains no pointer.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let writing = path.clone();
        let writer = std::thread::spawn(move || {
            std::fs::write(&writing, b"piped").unwrap();
        });
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let url = serve(1, move |_, received| {
            seen.lock().unwrap().push(asked_hash(received));
            holders(received, true)
        });
        let remote = Remote::keyed(&url, "k").unwrap();
        let uploads = AtomicUsize::new(0);
        let reading = path.clone();
        let ran = checked_upload(&path, IfDuplicate::Skip, true, &remote, || {
            uploads.fetch_add(1, Ordering::SeqCst);
            let bytes = std::fs::read(&reading).unwrap();
            Ok((bytes, "sha256:piped".into()))
        });
        writer.join().unwrap();
        let looked_up = asked.lock().unwrap().clone();
        if looked_up.is_empty() {
            let _ = remote.json(&lookup_request(&["sha256:none".into()]));
        }
        assert!(
            matches!(ran, Ok(Added::Uploaded { found: None, ref uploaded }) if uploaded == b"piped"),
            "{ran:?}"
        );
        assert!(looked_up.is_empty(), "a stream was looked up");
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
    }
}
