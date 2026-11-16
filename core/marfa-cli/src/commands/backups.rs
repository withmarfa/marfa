use clap::Subcommand;
use serde_json::Value;

use crate::error::CliError;
use crate::output::{Printer, printable};
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum BackupsCommand {
    /// The backups where the instance keeps them, its backup folder or its object store, newest
    /// first, from every instance that put them there. Requires `backups.manage`.
    List,
    /// Take a backup now, whether or not anything changed since the last one.
    /// Requires `backups.manage`.
    Run,
    /// Restore a backup from the instance's backup folder or object store. The
    /// server reads it itself, files included, so nothing is downloaded here. It
    /// restores as `restore` does an archive, and holds no sign-in, keys, apps,
    /// webhooks or inbound endpoints. Requires private local authority (--socket).
    Restore {
        /// The id of the instance that took the backup, as `backups list` shows it.
        instance_id: String,
        /// The backup's name, as `backups list` shows it.
        name: String,
        /// Restore without the files the backup needs that neither its destination nor this
        /// instance holds whole, instead of refusing.
        #[arg(long)]
        allow_missing_files: bool,
    },
    /// The backup folder that the `backup_path` setting names. Requires `backups.manage`.
    Folder {
        #[command(subcommand)]
        command: FolderCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum FolderCommand {
    /// Start afresh on a disk that replaced the backup folder's disk. The server forgets the
    /// backups and file copies it kept on the old disk, which are gone, and copies every file
    /// again with the next backup. It changes no other store, and refuses while the folder
    /// still holds this instance's files or is not there.
    Adopt,
}

const CHECK_BACKUPS: &str =
    "Run `marfa backups list` to see whether the backup was taken before you run this again.";
const CHECK_STATUS: &str = "Run `marfa status` once the server answers, and check what it holds before you run this again.";

pub fn request(command: &BackupsCommand) -> Request {
    match command {
        BackupsCommand::List => Request::get(&["backups"]),
        BackupsCommand::Run => Request::post(&["backups"]).working(CHECK_BACKUPS),
        BackupsCommand::Restore {
            instance_id,
            name,
            allow_missing_files,
        } => Request::post(&["backups", instance_id, name, "restore"])
            .query_flag("allow_missing_files", *allow_missing_files)
            .working(CHECK_STATUS),
        BackupsCommand::Folder {
            command: FolderCommand::Adopt,
        } => Request::post(&["backups", "folder", "adopt"]).working(CHECK_BACKUPS),
    }
}

fn count(answer: &Value, field: &str) -> u64 {
    answer.get(field).and_then(Value::as_u64).unwrap_or(0)
}

fn plural(count: u64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn text<'a>(answer: &'a Value, field: &str) -> &'a str {
    answer.get(field).and_then(Value::as_str).unwrap_or("")
}

fn ran_text(answer: &Value) -> String {
    let name = answer
        .pointer("/backup/name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut line = format!(
        "took backup {}; deleted {}",
        printable(name),
        plural(count(answer, "removed"), "old backup", "old backups")
    );
    let unremoved = count(answer, "unremoved");
    if unremoved > 0 {
        line.push_str(&format!(
            ", could not delete {}",
            plural(unremoved, "old backup", "old backups")
        ));
    }
    let lost: Vec<String> = answer
        .get("blobs_lost")
        .and_then(Value::as_array)
        .map(|hashes| {
            hashes
                .iter()
                .filter_map(Value::as_str)
                .map(printable)
                .collect()
        })
        .unwrap_or_default();
    if !lost.is_empty() {
        line.push_str(&format!(
            "\n{} lost, which the backup names and no store could give: {}",
            plural(lost.len() as u64, "file", "files"),
            lost.join(", ")
        ));
    }
    let waiting = count(answer, "blobs_waiting");
    if waiting > 0 {
        let files = match waiting {
            1 => "1 file it names waits for its copy".to_string(),
            many => format!("{many} files it names wait for their copy"),
        };
        line.push_str(&format!(
            "\nthe backup is incomplete: {files}. A restore needs those files unless the \
             restoring instance holds them or the backup lists them as lost"
        ));
    }
    line
}

fn adopted_text(answer: &Value) -> String {
    format!(
        "adopted the backup folder as store {}, replacing {}; forgot {} and {}",
        printable(text(answer, "store_id")),
        printable(text(answer, "replaced_store_id")),
        plural(count(answer, "backups_forgotten"), "backup", "backups"),
        plural(
            count(answer, "copies_forgotten"),
            "file copy",
            "file copies"
        )
    )
}

pub fn run(command: BackupsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let answer = remote.json(&request(&command))?;
    match command {
        BackupsCommand::Restore { .. } => super::restore::answered(&answer, out),
        BackupsCommand::Run => out.report(&answer, ran_text),
        BackupsCommand::Folder {
            command: FolderCommand::Adopt,
        } => out.report(&answer, adopted_text),
        BackupsCommand::List => out.value(&answer),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_the_server_works_on_before_it_answers_waits_for_it() {
        let restore = BackupsCommand::Restore {
            instance_id: "i".into(),
            name: "n".into(),
            allow_missing_files: false,
        };
        let adopt = BackupsCommand::Folder {
            command: FolderCommand::Adopt,
        };
        for command in [&BackupsCommand::Run, &restore, &adopt] {
            assert!(request(command).working.is_some(), "{command:?}");
        }
        assert!(request(&BackupsCommand::List).working.is_none());
    }
}
