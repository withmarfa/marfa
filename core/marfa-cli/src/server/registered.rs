//! The install folders that launchd agents and systemd units hold a server for.

use std::path::{Path, PathBuf};

use crate::autostart::{after, line_value, plist_strings, unquoted};
use crate::server::launchd;
use crate::server::systemd::{self, Scope};

/// The folder after `--dir` in the command a service runs, when it runs a server.
fn folder_of(arguments: &[String]) -> Option<PathBuf> {
    if !arguments.iter().any(|argument| argument == "server") {
        return None;
    }
    let at = arguments.iter().position(|argument| argument == "--dir")?;
    arguments
        .get(at + 1)
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
}

fn from_plist(text: &str) -> Option<PathBuf> {
    folder_of(&plist_strings(
        after(text, "<key>ProgramArguments</key>")?,
        "</array>",
    )?)
}

fn from_unit(text: &str) -> Option<PathBuf> {
    folder_of(&unquoted(line_value(text, "ExecStart=")?)?)
}

/// The folders of the service files in `dir` named `<prefix>…<suffix>`, in name order.
fn scan(
    dir: &Path,
    prefix: &str,
    suffix: &str,
    read: fn(&str) -> Option<PathBuf>,
    found: &mut Vec<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix) && name.ends_with(suffix))
        })
        .collect();
    files.sort();
    for path in files {
        if let Some(folder) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| read(&text))
            && !found.contains(&folder)
        {
            found.push(folder);
        }
    }
}

/// Every install folder a launchd agent or a systemd unit of this account, or of the machine, runs.
pub fn folders() -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(home) = launchd::home() {
        scan(
            &home.join("Library/LaunchAgents"),
            &launchd::label(""),
            ".plist",
            from_plist,
            &mut found,
        );
    }
    for scope in [Scope::User, Scope::System] {
        if let Some(dir) = systemd::file(scope, "")
            .ok()
            .and_then(|file| file.parent().map(Path::to_path_buf))
        {
            scan(&dir, "marfa-", ".service", from_unit, &mut found);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::launchd::{Agent, Job};
    use crate::server::systemd::Unit;

    #[test]
    fn the_folder_is_read_back_from_the_files_the_installer_writes() {
        let dir = PathBuf::from("/srv/it's <here> & there/marfa");
        let agent = Agent {
            name: "work".into(),
            job: Job::Server,
            binary: PathBuf::from("/usr/local/bin/marfa"),
            dir: dir.clone(),
            stdout: PathBuf::from("/tmp/out.log"),
            at_login: true,
        };
        assert_eq!(from_plist(&agent.plist().unwrap()), Some(dir.clone()));
        let container = Agent {
            job: Job::Container,
            ..agent
        };
        assert_eq!(from_plist(&container.plist().unwrap()), Some(dir.clone()));
        let unit = Unit {
            name: "work".into(),
            binary: PathBuf::from("/usr/local/bin/marfa"),
            dir: dir.clone(),
            scope: Scope::User,
            protect_home: false,
        };
        assert_eq!(from_unit(&unit.text().unwrap()), Some(dir));
    }

    #[test]
    fn a_service_that_does_not_run_a_server_names_no_folder() {
        let watch = ["/usr/bin/marfa", "folders", "watch", "--dir", "/tmp/x"]
            .map(String::from)
            .to_vec();
        assert_eq!(folder_of(&watch), None);
        let relative = ["marfa", "server", "run", "--dir", "marfa-server"]
            .map(String::from)
            .to_vec();
        assert_eq!(folder_of(&relative), None);
        assert_eq!(from_unit("ExecStart=\"a\" \"b\"\n"), None);
        assert_eq!(from_plist("not a plist"), None);
    }
}
