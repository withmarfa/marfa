//! Environment names that look like server settings and are not ones the server reads.

use marfa_rules::environment::COMMAND_LINE;

use super::Environment;
use super::registry::ENTRIES;
use super::rule;
use super::start_only::DECLARED;

const PREFIXES: [&str; 2] = ["MARFA_", "S3_"];

/// Naming one of these wrongly makes the server generate a replacement, which ends every key
/// or every sign-in.
const GENERATED: [&str; 2] = ["MARFA_KEY_SALT", "MARFA_AUTH_SECRET"];

const NEAR: usize = 2;

/// What a name the server reads is, which decides whether it can be offered as a correction.
#[derive(Debug, Clone, Copy)]
enum Kind {
    Setting,
    /// Read only by a server started with test hooks.
    Hook,
    /// A stored setting, whose environment name seeds its default under test hooks alone.
    Stored(&'static str),
}

struct Known {
    name: String,
    kind: Kind,
}

/// What an unknown name was meant to be.
#[derive(Debug, PartialEq, Eq)]
pub enum Meant {
    Setting(String),
    Stored(&'static str),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Unknown {
    pub name: String,
    pub meant: Option<Meant>,
    /// It is close to the name of a secret the server makes when the environment lacks it.
    pub generated: Option<&'static str>,
    /// It begins as a setting's name does, which is what the warning is for.
    prefixed: bool,
}

impl Unknown {
    pub fn sentence(&self) -> String {
        let name = &self.name;
        match &self.meant {
            Some(Meant::Setting(meant)) => {
                format!("{name} is not a setting the server reads; did you mean {meant}?")
            }
            Some(Meant::Stored(key)) => format!(
                "{name} is not a setting the server reads; {key} is a stored setting, set it through `marfa config update` or `PATCH /config`"
            ),
            None => format!("{name} is not a setting the server reads"),
        }
    }

    /// The line that refuses a start.
    pub fn refusal(&self, secret: &str) -> String {
        let lost = if secret == "MARFA_KEY_SALT" {
            "every key"
        } else {
            "every sign-in"
        };
        format!(
            "{} Without {secret} the server would make a new one and end {lost}",
            self.sentence()
        )
    }
}

fn known() -> Vec<Known> {
    let seeds = ENTRIES.iter().map(|entry| Known {
        name: entry.seed_name(),
        kind: Kind::Stored(entry.key),
    });
    let declared = DECLARED.iter().map(|declared| Known {
        name: declared.name.to_string(),
        kind: if declared.test_hook {
            Kind::Hook
        } else {
            Kind::Setting
        },
    });
    seeds.chain(declared).collect()
}

fn hooks_on(environment: &Environment) -> bool {
    cfg!(feature = "test-hooks")
        && environment
            .get("MARFA_TEST_HOOKS")
            .is_some_and(|text| rule::boolean(text).unwrap_or(false))
}

fn distance(left: &str, right: &str) -> usize {
    let right: Vec<u8> = right.bytes().collect();
    let mut row: Vec<usize> = (0..=right.len()).collect();
    for (index, a) in left.bytes().enumerate() {
        let mut diagonal = row[0];
        row[0] = index + 1;
        for (column, b) in right.iter().enumerate() {
            let above = row[column + 1];
            row[column + 1] = (diagonal + usize::from(a != *b))
                .min(above + 1)
                .min(row[column] + 1);
            diagonal = above;
        }
    }
    row[right.len()]
}

/// What a server with or without test hooks may tell the owner to use in place of a name it
/// found: a test hook is never offered to a server that ignores it, and a stored setting's
/// seed is named as the stored setting it stands for.
fn offered(candidate: &Known, hooks_on: bool) -> Option<Meant> {
    match candidate.kind {
        Kind::Setting => Some(Meant::Setting(candidate.name.clone())),
        _ if hooks_on => Some(Meant::Setting(candidate.name.clone())),
        Kind::Stored(key) => Some(Meant::Stored(key)),
        Kind::Hook => None,
    }
}

/// The known name an unknown one is a spelling of, or the one name that carries its stem: a
/// name whose last word changed, as a unit does.
fn meant(name: &str, known: &[Known], hooks_on: bool) -> Option<Meant> {
    let upper = name.to_ascii_uppercase();
    let nearest = known
        .iter()
        .map(|candidate| (distance(&upper, &candidate.name), candidate))
        .min_by_key(|(far, _)| *far);
    if let Some((far, candidate)) = nearest
        && far <= NEAR
    {
        return offered(candidate, hooks_on);
    }
    let (stem, _) = upper.rsplit_once('_')?;
    if stem.matches('_').count() < 2 {
        return None;
    }
    let mut sharing = known
        .iter()
        .filter(|candidate| candidate.name.starts_with(&format!("{stem}_")));
    match (sharing.next(), sharing.next()) {
        (Some(only), None) => offered(only, hooks_on),
        _ => None,
    }
}

/// Every `MARFA_` and `S3_` name the environment holds that no setting reads, and any other name
/// a letter or two from a secret's, by name.
pub fn find(environment: &Environment) -> Vec<Unknown> {
    let known = known();
    let hooks_on = hooks_on(environment);
    environment
        .names()
        .filter(|name| !known.iter().any(|held| held.name == *name))
        .filter(|name| !COMMAND_LINE.contains(name))
        .filter_map(|name| {
            let upper = name.to_ascii_uppercase();
            let prefixed = PREFIXES.iter().any(|prefix| upper.starts_with(prefix));
            let near = GENERATED
                .into_iter()
                .find(|secret| distance(&upper, secret) <= NEAR);
            (prefixed || near.is_some()).then(|| Unknown {
                name: name.to_string(),
                meant: meant(name, &known, hooks_on),
                generated: near.filter(|secret| environment.get(secret).is_none()),
                prefixed,
            })
        })
        .collect()
}

/// The lines that refuse a start: an unknown name a letter or two from a secret's, while the
/// environment does not hold that secret.
pub fn refusals(unknown: &[Unknown]) -> Vec<String> {
    unknown
        .iter()
        .filter_map(|entry| entry.generated.map(|secret| entry.refusal(secret)))
        .collect()
}

pub fn warn(unknown: &[Unknown]) {
    for entry in unknown.iter().filter(|entry| entry.prefixed) {
        tracing::warn!(setting = entry.name, "{}", entry.sentence());
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    /// Names in the command line's sources that no process environment hands the server: the
    /// install record's own keys, and the stand-ins and benchmarks that tests use.
    const NOT_SETTINGS: [&str; 20] = [
        "MARFA_ACCESS",
        "MARFA_ADDRESS",
        "MARFA_APPLIED",
        "MARFA_AUTOSTART",
        "MARFA_HTTPS_PORT",
        "MARFA_NAME",
        "MARFA_RELEASE",
        "MARFA_RUNTIME",
        "MARFA_SERVICE",
        "MARFA_SETTINGS",
        "MARFA_AUTOSTART_ROOT",
        "MARFA_SERVER_CONTROL",
        "MARFA_DIRECTORY_VFS_CHILD",
        "MARFA_DIRECTORY_VFS_CHILD_MODE",
        "MARFA_READ_BENCH_ROWS",
        "MARFA_READ_ONLY_PAGE",
        "MARFA_WRITE_COMMANDS",
        "MARFA_EXPECT_SQLITE_MAX_VARIABLE_NUMBER",
        "MARFA_EXPECT_SQLITE_MAX_EXPR_DEPTH",
        "MARFA_EXPECT_SQLITE_MAX_COLUMN",
    ];

    fn found(pairs: &[(&str, &str)]) -> Vec<Unknown> {
        find(&Environment::from_pairs(pairs))
    }

    fn setting(name: &str) -> Option<Meant> {
        Some(Meant::Setting(name.to_string()))
    }

    #[test]
    fn a_name_the_server_reads_is_not_unknown() {
        let pairs: Vec<(String, String)> = known()
            .into_iter()
            .map(|held| held.name)
            .chain(COMMAND_LINE.map(String::from))
            .map(|name| (name, "x".to_string()))
            .collect();
        let pairs: Vec<(&str, &str)> = pairs
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        assert_eq!(found(&pairs), []);
    }

    #[test]
    fn only_marfa_and_s3_names_are_judged() {
        assert_eq!(
            found(&[("PATH", "/usr/bin"), ("OTEL_SDK_DISABLED", "true")]),
            []
        );
        let names: Vec<_> = found(&[("S3_BUCKT", "x"), ("MARFA_NOT_A_SETTING", "x")])
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, ["MARFA_NOT_A_SETTING", "S3_BUCKT"]);
    }

    #[test]
    fn a_renamed_unit_names_the_stored_setting_that_took_its_place() {
        let entry = &found(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "5000")])[0];
        assert_eq!(
            entry.meant,
            Some(Meant::Stored("blob_cleanup_grace_seconds"))
        );
        assert_eq!(entry.generated, None);
        assert_eq!(
            entry.sentence(),
            "MARFA_BLOB_CLEANUP_GRACE_MS is not a setting the server reads; \
             blob_cleanup_grace_seconds is a stored setting, set it through \
             `marfa config update` or `PATCH /config`"
        );
    }

    #[test]
    fn a_misspelling_names_the_setting_it_is_near() {
        let entry = &found(&[("S3_BUCKT", "x")])[0];
        assert_eq!(entry.meant, setting("S3_BUCKET"));
        let entry = &found(&[("marfa_port", "x")])[0];
        assert_eq!(entry.meant, setting("MARFA_PORT"));
    }

    #[test]
    fn a_server_without_hooks_is_never_sent_to_a_hook() {
        let entry = &found(&[("MARFA_TEST_HOOK", "x")])[0];
        assert_eq!(entry.meant, None);
        let entry = &found(&[("MARFA_TEST_TUNIN", "x")])[0];
        assert_eq!(entry.meant, None);
        // The witness: the hook name is one the table holds, so a wrong spelling of it is near.
        assert!(known().iter().any(|held| held.name == "MARFA_TEST_TUNING"));
    }

    #[test]
    fn a_stored_setting_is_never_sent_to_its_seed_name_without_hooks() {
        let entry = &found(&[("MARFA_BLOB_CLEANUP_GRACE_SECONDZ", "x")])[0];
        assert_eq!(
            entry.meant,
            Some(Meant::Stored("blob_cleanup_grace_seconds"))
        );
    }

    #[cfg(feature = "test-hooks")]
    #[test]
    fn a_server_with_hooks_is_sent_to_the_seed_and_hook_names_it_reads() {
        let entry = &found(&[
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_BLOB_CLEANUP_GRACE_SECONDZ", "x"),
            ("MARFA_TEST_TUNIN", "x"),
        ]);
        assert_eq!(
            entry[0].meant,
            setting("MARFA_BLOB_CLEANUP_GRACE_SECONDS"),
            "{entry:?}"
        );
        assert_eq!(entry[1].meant, setting("MARFA_TEST_TUNING"), "{entry:?}");
    }

    #[test]
    fn a_name_near_nothing_names_nothing() {
        let entry = &found(&[("MARFA_COMPLETELY_DIFFERENT_THING", "x")])[0];
        assert_eq!(entry.meant, None);
    }

    #[test]
    fn a_name_near_a_secret_is_refused_and_a_name_near_anything_else_is_not() {
        let near = found(&[("MARFA_AUTH_SECRT", "x"), ("MARFA_KEY_SLAT", "x")]);
        assert_eq!(
            refusals(&near),
            [
                "MARFA_AUTH_SECRT is not a setting the server reads; did you mean MARFA_AUTH_SECRET? \
                 Without MARFA_AUTH_SECRET the server would make a new one and end every sign-in",
                "MARFA_KEY_SLAT is not a setting the server reads; did you mean MARFA_KEY_SALT? \
                 Without MARFA_KEY_SALT the server would make a new one and end every key",
            ]
        );
        assert!(refusals(&found(&[("MARFA_PORTT", "x"), ("S3_BUCKT", "x")])).is_empty());
    }

    #[test]
    fn a_secret_whose_prefix_is_wrong_is_refused_too() {
        let wrong = [
            "MARF_AUTH_SECRET",
            "MRFA_KEY_SALT",
            "MARFA-AUTH-SECRET",
            "marfa_key_salt",
            "ARFA_KEY_SALT",
        ];
        for name in wrong {
            let lines = refusals(&found(&[(name, "x")]));
            assert_eq!(lines.len(), 1, "{name}: {lines:?}");
            assert!(lines[0].starts_with(name), "{lines:?}");
        }
        // The witness: a name that is not near either secret, whatever its prefix, is not.
        assert!(refusals(&found(&[("MAFA_PORT", "x"), ("HOME", "x")])).is_empty());
    }

    #[test]
    fn a_secret_that_is_set_is_not_replaced_so_a_near_name_is_only_warned_of() {
        let both = found(&[
            ("MARFA_AUTH_SECRET", "x"),
            ("MARF_AUTH_SECRET", "x"),
            ("MARFA_KEY_SLAT", "x"),
        ]);
        assert_eq!(both.len(), 2);
        let lines = refusals(&both);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with("MARFA_KEY_SLAT"), "{lines:?}");
    }

    #[test]
    fn a_name_near_a_secret_without_the_prefix_is_not_warned_of() {
        let unprefixed = &found(&[("ARFA_AUTH_SECRET", "x"), ("MARFA_AUTH_SECRET", "x")])[0];
        assert!(!unprefixed.prefixed);
        assert_eq!(unprefixed.generated, None);
    }

    /// A later setting cannot be refused as a misspelled secret, since no name the server or the
    /// command line reads is near either.
    #[test]
    fn no_name_that_is_read_is_near_a_secret() {
        let held = known()
            .into_iter()
            .map(|held| held.name)
            .chain(COMMAND_LINE.map(String::from));
        for name in held {
            if GENERATED.contains(&name.as_str()) {
                continue;
            }
            for secret in GENERATED {
                assert!(
                    distance(&name, secret) > NEAR,
                    "{name} is within {NEAR} edits of {secret}"
                );
            }
        }
    }

    fn sources(folder: &Path, into: &mut Vec<String>) {
        for entry in std::fs::read_dir(folder).expect("a source folder reads") {
            let path = entry.expect("an entry reads").path();
            if path.is_dir() {
                sources(&path, into);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                into.push(std::fs::read_to_string(&path).expect("a source reads"));
            }
        }
    }

    /// Every whole quoted name that begins as a setting's does.
    fn quoted_names(source: &str) -> Vec<&str> {
        let opens: Vec<usize> = PREFIXES
            .iter()
            .flat_map(|prefix| {
                source
                    .match_indices(&format!("\"{prefix}"))
                    .map(|(start, _)| start)
                    .collect::<Vec<_>>()
            })
            .collect();
        opens
            .into_iter()
            .filter_map(|start| {
                let rest = &source[start + 1..];
                let name = &rest[..rest.find('"')?];
                let whole = name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
                (whole && !name.ends_with('_')).then_some(name)
            })
            .collect()
    }

    /// The command line and the core read environment names of their own, and a server started
    /// by `marfa server run` holds whatever the shell held. A name read there and unknown here
    /// would draw a warning about a setting that is not wrong.
    #[test]
    fn every_name_the_command_line_and_the_core_name_is_one_the_server_may_find() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut all = Vec::new();
        for crate_name in ["marfa-cli", "marfa-core"] {
            sources(&root.join(crate_name).join("src"), &mut all);
        }
        let known = known();
        let mut seen = Vec::new();
        for source in &all {
            seen.extend(quoted_names(source));
        }
        // The witnesses: the scan reaches a name of each list, so an empty one cannot pass.
        for name in ["MARFA_FOLDER_REGISTRY", "MARFA_API_KEY", "MARFA_SETTINGS"] {
            assert!(seen.contains(&name), "the scan did not find {name}");
        }
        for name in seen {
            let accounted = known.iter().any(|held| held.name == name)
                || COMMAND_LINE.contains(&name)
                || NOT_SETTINGS.contains(&name)
                || name.starts_with("MARFA_TEST_");
            assert!(
                accounted,
                "{name} is named in marfa-cli or marfa-core and the server would warn of it: add it \
                 to COMMAND_LINE in marfa-rules if the command reads it from a shell, or to \
                 NOT_SETTINGS if no environment holds it"
            );
        }
    }
}
