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

/// Prints a restore's answer, says what is set up again and which entries were skipped, and fails
/// on blobs it lacks.
pub fn answered(answer: &serde_json::Value, out: &Printer) -> Result<(), CliError> {
    out.value(answer)?;
    for note in notes(answer) {
        eprintln!("{note}");
    }
    let missing = texts(answer, "blobs_missing");
    if missing.is_empty() {
        Ok(())
    } else {
        Err(CliError::RestoreLacksBlobs(missing))
    }
}

fn texts(answer: &serde_json::Value, key: &str) -> Vec<String> {
    answer
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|held| {
            held.iter()
                .filter_map(|text| text.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The lines a restore's answer gives a person beside the answer itself.
fn notes(answer: &serde_json::Value) -> Vec<String> {
    let mut notes = Vec::new();
    let skipped = texts(answer, "entries_skipped");
    if !skipped.is_empty() {
        notes.push(format!(
            "Skipped {} archive {} this build does not know: {}.",
            skipped.len(),
            if skipped.len() == 1 { "entry" } else { "entries" },
            skipped.join(", ")
        ));
    }
    if let Some(note) = answer
        .get("set_up_again")
        .and_then(serde_json::Value::as_str)
    {
        notes.push(note.to_string());
    }
    notes
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::notes;

    #[test]
    fn names_each_skipped_entry_before_what_to_set_up_again() {
        let answer = json!({
            "entries_skipped": ["._manifest.json", "PaxHeaders.4242/items.ndjson.gz"],
            "set_up_again": "Set up sign-in again.",
        });
        assert_eq!(
            notes(&answer),
            [
                "Skipped 2 archive entries this build does not know: ._manifest.json, PaxHeaders.4242/items.ndjson.gz.",
                "Set up sign-in again.",
            ]
        );
        let one = json!({ "entries_skipped": [".DS_Store"] });
        assert_eq!(
            notes(&one),
            ["Skipped 1 archive entry this build does not know: .DS_Store."]
        );
        assert!(notes(&json!({ "entries_skipped": [] })).is_empty());
    }
}
