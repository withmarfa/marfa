use std::path::PathBuf;

use clap::Args;

use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Take an archive back: the other half of `export --format archive`.
#[derive(Debug, Args)]
pub struct RestoreArgs {
    /// The archive, as `export --format archive` wrote it.
    pub file: PathBuf,
}

/// The server answers a refusal it makes before reading the body without the body being sent.
pub fn request(args: &RestoreArgs) -> Request {
    Request::post(&["restore"])
        .file(args.file.clone(), "application/x-tar")
        .header("Expect", "100-continue")
}

pub fn run(args: RestoreArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    answered(&remote.json(&request(&args))?, out)
}

/// What a restore says is set up again, as one safe line of text.
fn set_up_again_note(answer: &serde_json::Value) -> Option<String> {
    answer
        .get("set_up_again")
        .and_then(serde_json::Value::as_str)
        .map(crate::output::printable)
}

/// Prints a restore's answer, says what is set up again, and fails on blobs it lacks.
pub fn answered(answer: &serde_json::Value, out: &Printer) -> Result<(), CliError> {
    out.value(answer)?;
    if let Some(note) = set_up_again_note(answer) {
        crate::errln!("{note}");
    }
    let missing: Vec<String> = answer
        .get("blobs_missing")
        .and_then(serde_json::Value::as_array)
        .map(|hashes| {
            hashes
                .iter()
                .filter_map(|hash| hash.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(CliError::RestoreLacksBlobs(missing))
    }
}

#[cfg(test)]
mod tests {
    use super::set_up_again_note;
    use serde_json::json;

    #[test]
    fn the_note_cannot_start_a_line_or_move_the_cursor() {
        let answer = json!({"set_up_again": "keys\nrestored 0 items\u{1b}[2K"});
        let note = set_up_again_note(&answer).expect("a note");
        assert!(!note.contains('\n') && !note.contains('\u{1b}'), "{note:?}");
        assert_eq!(note, "keys\\u{a}restored 0 items\\u{1b}[2K");
    }

    #[test]
    fn no_note_is_none() {
        assert_eq!(set_up_again_note(&json!({})), None);
    }
}
