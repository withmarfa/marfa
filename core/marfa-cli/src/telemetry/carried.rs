//! The telemetry settings a folder watch started at login carries. A launchd
//! agent or a systemd user unit does not inherit the shell that ran
//! `folders autostart on`, so the command writes the settings it finds in its
//! own environment to one file that only the person can read, beside the
//! folder registry, and the agent names that file in `MARFA_TELEMETRY_FILE`.
//! `folders watch`, and no other command, reads the file before it reads the
//! telemetry settings, so the watch reports as a command run from that shell
//! does.
//!
//! One file holds all of them, and not only the settings that obviously hold
//! a secret: `OTEL_EXPORTER_OTLP_HEADERS` carries credentials, an endpoint
//! can carry a user name and password, and PostHog's project token, though
//! it only lets a client send events, is no more for others to read than the
//! rest. The agent's own file is readable by others and holds the path alone.

use std::io::Read as _;
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::path::Path;

/// Names the file in the agent's environment.
pub const FILE_ENV: &str = "MARFA_TELEMETRY_FILE";

/// The file's name, beside the folder registry.
pub const FILE_NAME: &str = "folder-watch.env";

/// Every setting the command line reads to report, in the order the file
/// lists them. A test fails when a source names one that is missing here.
pub const NAMES: [&str; 13] = [
    "MARFA_POSTHOG_HOST",
    "MARFA_POSTHOG_PROJECT_TOKEN",
    "OTEL_SDK_DISABLED",
    "OTEL_SERVICE_NAME",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
    "OTEL_TRACES_SAMPLER",
    "OTEL_TRACES_SAMPLER_ARG",
];

const HEADER: &str = "# Telemetry settings that `marfa folders autostart on` carried from the shell it ran in. Rewritten each time it runs.\n";

/// What `autostart on` carries from its own environment.
#[derive(Debug, PartialEq, Eq)]
pub struct Carried {
    /// The settings that were set, by name and never by value.
    pub names: Vec<&'static str>,
    /// The file's text, or none where nothing is carried and no file stays.
    pub content: Option<String>,
}

/// The settings `get` has, or the name of one whose value a line of a file
/// cannot hold.
pub fn carry(get: &impl Fn(&str) -> Option<String>) -> Result<Carried, &'static str> {
    let mut names = Vec::new();
    let mut lines = String::new();
    for name in NAMES {
        let Some(value) = marfa_telemetry::environment::text(get, name) else {
            continue;
        };
        if value.chars().any(char::is_control) {
            return Err(name);
        }
        names.push(name);
        lines.push_str(&format!("{name}={value}\n"));
    }
    Ok(Carried {
        content: (!names.is_empty()).then(|| format!("{HEADER}{lines}")),
        names,
    })
}

/// The settings a file's text holds, ignoring a line that is no setting the
/// command line reads.
fn parse(text: &str) -> Vec<(&'static str, String)> {
    text.lines()
        .filter_map(|line| {
            let (name, value) = line.split_once('=')?;
            let name = NAMES.iter().find(|known| **known == name)?;
            Some((*name, value.to_string()))
        })
        .collect()
}

/// Puts the file's settings into the environment, except one set and not
/// empty already, so that a command run by hand with its own settings keeps
/// them.
fn apply(text: &str, get: &impl Fn(&str) -> Option<String>, set: &mut impl FnMut(&str, &str)) {
    for (name, value) in parse(text) {
        if marfa_telemetry::environment::text(get, name).is_none() {
            set(name, &value);
        }
    }
}

/// The text of a regular file that only `owner` can read, or what is wrong
/// with it. Never a value. The file is opened without following a symbolic
/// link and without waiting, so a link or a named pipe in its place is refused
/// and never blocks the watch.
fn read_private(path: &Path, owner: u32) -> Result<String, String> {
    let said = |why: &str| {
        format!(
            "the telemetry file {} {why}, so this run sends no reports",
            path.display()
        )
    };
    let not_private = || said("is not a file that only you can read");
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| match error.raw_os_error() {
            Some(libc::ELOOP) => not_private(),
            _ => said(&format!("cannot be read ({})", error.kind())),
        })?;
    let meta = file
        .metadata()
        .map_err(|error| said(&format!("cannot be read ({})", error.kind())))?;
    if !meta.is_file() || meta.uid() != owner || meta.mode() & 0o077 != 0 {
        return Err(not_private());
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| said(&format!("cannot be read ({})", error.kind())))?;
    Ok(text)
}

/// The command whose run reads the file: the folder watch, which a login
/// agent starts, and no other.
const READER: &str = "marfa folders watch";

/// Reads the file `file` names, if it is set and `command` is the folder
/// watch, into the environment through `set`. A fault is returned for the
/// caller to say, and leaves the run without the settings.
fn load_with(
    command: &str,
    file: Option<std::ffi::OsString>,
    owner: u32,
    get: &impl Fn(&str) -> Option<String>,
    set: &mut impl FnMut(&str, &str),
) -> Result<(), String> {
    if command != READER {
        return Ok(());
    }
    let Some(path) = file.filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    apply(&read_private(Path::new(&path), owner)?, get, set);
    Ok(())
}

/// Reads the file `MARFA_TELEMETRY_FILE` names into this process's
/// environment, for the folder watch only. Called in `main` before any thread
/// starts and before the telemetry settings are read. A fault is said on
/// standard error and leaves the run without the settings.
pub fn load(command: &str) {
    // SAFETY: `geteuid` cannot fail.
    let owner = unsafe { libc::geteuid() };
    let result = load_with(
        command,
        std::env::var_os(FILE_ENV),
        owner,
        &|name| std::env::var(name).ok(),
        // SAFETY: the process is still single-threaded at this point.
        &mut |name, value| unsafe { std::env::set_var(name, value) },
    );
    if let Err(said) = result {
        crate::errln!("marfa: {said}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn getter<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn carries_what_is_set_and_nothing_for_the_rest() {
        let carried = carry(&getter(&[
            ("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer a=b"),
            ("MARFA_POSTHOG_HOST", "https://posthog.invalid"),
            ("OTEL_SERVICE_NAME", "   "),
            ("UNRELATED", "x"),
        ]))
        .expect("carried");
        assert_eq!(
            carried.names,
            ["MARFA_POSTHOG_HOST", "OTEL_EXPORTER_OTLP_HEADERS"]
        );
        let content = carried.content.expect("a file");
        assert!(content.contains("MARFA_POSTHOG_HOST=https://posthog.invalid\n"));
        assert!(!content.contains("OTEL_SERVICE_NAME"));
        assert!(!content.contains("UNRELATED"));
    }

    #[test]
    fn carries_none_with_no_file() {
        let carried = carry(&getter(&[])).expect("carried");
        assert_eq!(
            carried,
            Carried {
                names: vec![],
                content: None
            }
        );
    }

    #[test]
    fn refuses_a_value_a_line_cannot_hold() {
        assert_eq!(
            carry(&getter(&[(
                "OTEL_SERVICE_NAME",
                "a\nOTEL_SDK_DISABLED=true"
            )])),
            Err("OTEL_SERVICE_NAME")
        );
    }

    #[test]
    fn a_file_round_trips_and_never_overrides_what_is_set() {
        let content = carry(&getter(&[
            ("OTEL_EXPORTER_OTLP_HEADERS", "k=v=w"),
            ("OTEL_SERVICE_NAME", "from-file"),
        ]))
        .expect("carried")
        .content
        .expect("a file");
        let mut set = Vec::new();
        apply(
            &content,
            &getter(&[("OTEL_SERVICE_NAME", "by-hand")]),
            &mut |name, value| {
                set.push((name.to_string(), value.to_string()));
            },
        );
        assert_eq!(
            set,
            [(
                "OTEL_EXPORTER_OTLP_HEADERS".to_string(),
                "k=v=w".to_string()
            )]
        );
    }

    #[test]
    fn a_line_that_is_no_known_setting_is_ignored() {
        assert!(parse("# note\nPATH=/bin\nOTEL_UNKNOWN=1\nnoequals\n").is_empty());
    }

    /// Every setting the reporting code names is one the file carries.
    #[test]
    fn names_every_setting_the_command_line_reads() {
        for source in [
            include_str!("settings.rs"),
            include_str!("posthog.rs"),
            include_str!("otlp.rs"),
            include_str!("../telemetry.rs"),
        ] {
            for quoted in source.split('"').skip(1).step_by(2) {
                let setting = ["OTEL_", "MARFA_OTEL_", "MARFA_POSTHOG_"]
                    .iter()
                    .any(|prefix| quoted.starts_with(prefix))
                    && quoted.chars().all(|c| c.is_ascii_uppercase() || c == '_')
                    && !quoted.ends_with('_');
                assert!(
                    !setting || NAMES.contains(&quoted),
                    "{quoted} is not carried"
                );
            }
        }
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("marfa-carried-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        dir
    }

    fn mine() -> u32 {
        // SAFETY: `geteuid` cannot fail.
        unsafe { libc::geteuid() }
    }

    fn file_with(dir: &Path, mode: u32) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let path = dir.join("folder-watch.env");
        std::fs::write(&path, "OTEL_SERVICE_NAME=from-file\n").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("mode");
        path
    }

    #[test]
    fn reads_a_regular_file_only_its_owner_can_read() {
        let dir = scratch("ok");
        let path = file_with(&dir, 0o600);
        assert_eq!(
            read_private(&path, mine()).as_deref(),
            Ok("OTEL_SERVICE_NAME=from-file\n")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_file_others_can_access() {
        for mode in [0o640, 0o604, 0o660, 0o644, 0o607] {
            let dir = scratch(&format!("mode{mode:o}"));
            let path = file_with(&dir, mode);
            let said = read_private(&path, mine()).expect_err("refused");
            assert!(said.contains("only you can read"), "{mode:o}: {said}");
            assert!(!said.contains("from-file"));
            std::fs::remove_dir_all(dir).ok();
        }
    }

    #[test]
    fn refuses_a_file_another_user_owns() {
        let dir = scratch("owner");
        let path = file_with(&dir, 0o600);
        // Witness: the same file is read as its owner.
        assert!(read_private(&path, mine()).is_ok());
        let said = read_private(&path, mine().wrapping_add(1)).expect_err("refused");
        assert!(said.contains("only you can read"), "{said}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_symbolic_link_even_to_a_good_file() {
        let dir = scratch("link");
        let target = file_with(&dir, 0o600);
        let link = dir.join("link.env");
        std::os::unix::fs::symlink(&target, &link).expect("link");
        assert!(read_private(&target, mine()).is_ok());
        let said = read_private(&link, mine()).expect_err("refused");
        assert!(said.contains("only you can read"), "{said}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_what_is_no_regular_file_and_never_waits_on_it() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch("fifo");
        let pipe = dir.join("pipe.env");
        let made = std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .expect("mkfifo");
        assert!(made.success());
        // Private, so that only the type is what refuses it.
        std::fs::set_permissions(&pipe, std::fs::Permissions::from_mode(0o600)).expect("mode");
        // A pipe with no writer would block a plain open for ever.
        let said = read_private(&pipe, mine()).expect_err("refused");
        assert!(said.contains("only you can read"), "{said}");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("mode");
        let said = read_private(&dir, mine()).expect_err("a directory is refused");
        assert!(said.contains("only you can read"), "{said}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_empty_setting_does_not_hold_off_the_file() {
        let mut set = Vec::new();
        apply(
            "OTEL_SERVICE_NAME=from-file\n",
            &getter(&[("OTEL_SERVICE_NAME", "  ")]),
            &mut |name, value| set.push((name.to_string(), value.to_string())),
        );
        assert_eq!(
            set,
            [("OTEL_SERVICE_NAME".to_string(), "from-file".to_string())]
        );
    }

    #[test]
    fn the_watch_gets_the_files_settings_and_no_other_command_reads_it() {
        let dir = scratch("reach");
        let path = file_with(&dir, 0o600);
        let reach = |command: &str| {
            let mut set = Vec::new();
            let result = load_with(
                command,
                Some(path.clone().into_os_string()),
                mine(),
                &getter(&[]),
                &mut |name, value| set.push((name.to_string(), value.to_string())),
            );
            (result, set)
        };
        let (result, set) = reach("marfa folders watch");
        assert_eq!(result, Ok(()));
        assert_eq!(
            set,
            [("OTEL_SERVICE_NAME".to_string(), "from-file".to_string())]
        );
        for command in [
            "marfa folders list",
            "marfa items list",
            "marfa folders autostart on",
        ] {
            assert_eq!(reach(command), (Ok(()), vec![]), "{command}");
        }
        // A file that fails the gate reaches nothing and says why.
        let loose = file_with(&scratch("reach-loose"), 0o644);
        let mut set = Vec::new();
        let result = load_with(
            "marfa folders watch",
            Some(loose.into_os_string()),
            mine(),
            &getter(&[]),
            &mut |name, value| set.push((name.to_string(), value.to_string())),
        );
        assert!(result.is_err() && set.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }
}
