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

/// Missing blobs make the command fail even when the restore succeeded.
pub fn answered(answer: &serde_json::Value, out: &Printer) -> Result<(), CliError> {
    out.value(answer)?;
    for note in notes(answer) {
        crate::errln!("{}", crate::output::printable(&note));
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
            if skipped.len() == 1 {
                "entry"
            } else {
                "entries"
            },
            skipped.join(", ")
        ));
    }
    let kinds = texts(answer, "line_kinds_skipped");
    if !kinds.is_empty() {
        notes.push(format!(
            "Skipped instance lines of {} this build does not know: {}.",
            if kinds.len() == 1 { "a kind" } else { "kinds" },
            kinds.join(", ")
        ));
    }
    for switch in texts(answer, "settings_without_receiver") {
        notes.push(format!(
            "Stored {switch}, which sends nothing until its receiver is set."
        ));
    }
    let added = texts(answer, "enforcement_added");
    if !added.is_empty() {
        notes.push(format!(
            "Restored the archive's enforcement settings: {}.",
            added.join(", ")
        ));
    }
    let skipped = texts(answer, "enforcement_skipped");
    if !skipped.is_empty() {
        notes.push(format!(
            "Kept this instance's own enforcement settings instead of the archive's: {}.",
            skipped.join(", ")
        ));
    }
    if let Some(message) = answer
        .pointer("/previous_instance/message")
        .and_then(serde_json::Value::as_str)
    {
        notes.push(message.to_string());
    }
    for kind in answer
        .get("not_restored")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(message) = kind.get("message").and_then(serde_json::Value::as_str) {
            notes.push(message.to_string());
        }
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
            "not_restored": [{ "kind": "sign_in", "message": "Set up sign-in again." }],
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

    #[test]
    fn a_printed_note_cannot_start_a_line_or_move_the_cursor() {
        let answer = json!({
            "not_restored": [{ "kind": "keys", "message": "keys\nrestored 0 items\u{1b}[2K" }]
        });
        let printed: Vec<String> = notes(&answer)
            .iter()
            .map(|note| crate::output::printable(note))
            .collect();
        assert_eq!(printed, ["keys\\u{a}restored 0 items\\u{1b}[2K"]);
    }

    #[test]
    fn prints_one_line_for_each_kind_the_archive_left_out_and_what_the_restore_did() {
        let answer = json!({
            "settings_without_receiver": ["heartbeat_enabled"],
            "enforcement_added": ["source_filter"],
            "enforcement_skipped": ["strict_mode", "source_allowlist"],
            "previous_instance": {
                "instance_id": "0190a1b2-0000-7000-8000-000000000001",
                "destination": "folder",
                "kept_by_previous_instance": ["backups/0190a1b2-0000-7000-8000-000000000001", "files/0190a1b2-0000-7000-8000-000000000001"],
                "message": "Previous instance line.",
            },
            "not_restored": [
                { "kind": "sign_in", "message": "Sign-in line." },
                { "kind": "inbound_endpoints", "message": "Endpoints line." },
            ],
        });
        assert_eq!(
            notes(&answer),
            [
                "Stored heartbeat_enabled, which sends nothing until its receiver is set.",
                "Restored the archive's enforcement settings: source_filter.",
                "Kept this instance's own enforcement settings instead of the archive's: strict_mode, source_allowlist.",
                "Previous instance line.",
                "Sign-in line.",
                "Endpoints line.",
            ]
        );
        assert!(notes(&json!({ "enforcement_added": [], "enforcement_skipped": [] })).is_empty());
    }

    #[test]
    fn prints_the_telemetry_note_a_restore_leaves() {
        let message = "Telemetry settings are not restored: the archive names \
                       otel_exporter_otlp_endpoint without their values. Traces, log records and \
                       fault reports that need them stay off until you set them again.";
        let answer = json!({
            "secrets_to_set": ["otel_exporter_otlp_endpoint"],
            "not_restored": [{ "kind": "telemetry", "message": message }],
        });
        assert_eq!(notes(&answer), [message]);
    }

    #[test]
    fn names_each_skipped_line_kind() {
        let answer =
            json!({ "entries_skipped": [], "line_kinds_skipped": ["later_kind", "other"] });
        assert_eq!(
            notes(&answer),
            ["Skipped instance lines of kinds this build does not know: later_kind, other."]
        );
        let one = json!({ "line_kinds_skipped": ["later_kind"] });
        assert_eq!(
            notes(&one),
            ["Skipped instance lines of a kind this build does not know: later_kind."]
        );
        assert!(notes(&json!({ "line_kinds_skipped": [] })).is_empty());
    }
}
