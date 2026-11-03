//! The telemetry settings a folder watch started at login carries. A launchd
//! agent or a systemd user unit does not inherit the shell that ran
//! `folders autostart on`, so the command writes the settings it finds in its
//! own environment to one file that only the person can read, beside the
//! folder registry, and the agent names that file in `MARFA_TELEMETRY_FILE`.
//! The binary reads the file before anything else, so the watch reports as a
//! command run from that shell does.
//!
//! One file holds all of them, and not only the settings that obviously hold
//! a secret: `OTEL_EXPORTER_OTLP_HEADERS` carries credentials, an endpoint
//! can carry a user name and password, and PostHog's project token, though
//! it only lets a client send events, is no more for others to read than the
//! rest. The agent's own file is readable by others and holds the path alone.

use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
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
        let Some(value) = super::settings::text(get, name) else {
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

/// Puts the file's settings into the environment, except one already set, so
/// that a command run by hand with its own settings keeps them.
fn apply(text: &str, get: &impl Fn(&str) -> Option<String>, set: &mut impl FnMut(&str, &str)) {
    for (name, value) in parse(text) {
        if get(name).is_none() {
            set(name, &value);
        }
    }
}

/// The text of a file that only its owner can read, or what is wrong with it.
/// Never a value.
fn read_private(path: &Path) -> Result<String, String> {
    let said = |why: &str| {
        format!(
            "the telemetry file {} {why}, so this run sends no reports",
            path.display()
        )
    };
    let mut file = std::fs::File::open(path)
        .map_err(|error| said(&format!("cannot be read ({})", error.kind())))?;
    let meta = file
        .metadata()
        .map_err(|error| said(&format!("cannot be read ({})", error.kind())))?;
    // SAFETY: `geteuid` cannot fail.
    if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(said("is not a file that only you can read"));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| said(&format!("cannot be read ({})", error.kind())))?;
    Ok(text)
}

/// Reads the file `MARFA_TELEMETRY_FILE` names, if it is set, into this
/// process's environment. Called first in `main`, before any thread starts and
/// before the telemetry settings are read. A fault is said on standard error
/// and leaves the run without the settings.
pub fn load() {
    let Some(path) = std::env::var_os(FILE_ENV).filter(|path| !path.is_empty()) else {
        return;
    };
    match read_private(Path::new(&path)) {
        Ok(text) => apply(
            &text,
            &|name| std::env::var(name).ok(),
            // SAFETY: the process is still single-threaded at this point.
            &mut |name, value| unsafe { std::env::set_var(name, value) },
        ),
        Err(said) => eprintln!("marfa: {said}"),
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
}
