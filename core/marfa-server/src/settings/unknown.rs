//! Environment names that look like server settings and are not ones the server reads.

use super::Environment;
use super::registry::ENTRIES;
use super::start_only::DECLARED;

const PREFIXES: [&str; 2] = ["MARFA_", "S3_"];

/// Names the `marfa` command reads from a shell, which `marfa server run` hands on.
const COMMAND_LINE: [&str; 10] = [
    "MARFA_API_URL",
    "MARFA_API_KEY",
    "MARFA_PROFILE",
    "MARFA_NO_KEYCHAIN",
    "MARFA_KEYCHAIN",
    "MARFA_ALLOW_HTTP",
    "MARFA_DB",
    "MARFA_DOCS_URL",
    "MARFA_DOCKER",
    "MARFA_TAILSCALE",
];

/// Naming one of these wrongly makes the server generate a replacement, which ends every key
/// or every sign-in.
const GENERATED: [&str; 2] = ["MARFA_KEY_SALT", "MARFA_AUTH_SECRET"];

const NEAR: usize = 2;

#[derive(Debug, PartialEq, Eq)]
pub struct Unknown {
    pub name: String,
    pub meant: Option<String>,
    /// It is close to the name of a secret the server makes when the environment lacks it.
    pub generated: Option<&'static str>,
}

impl Unknown {
    pub fn sentence(&self) -> String {
        let name = &self.name;
        match &self.meant {
            Some(meant) => {
                format!("{name} is not a setting the server reads; did you mean {meant}?")
            }
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

fn known() -> Vec<String> {
    let seeds = ENTRIES.iter().map(|entry| entry.seed_name());
    let declared = DECLARED.iter().map(|declared| declared.name.to_string());
    seeds.chain(declared).collect()
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

/// The known name an unknown one is a spelling of, or the one name that carries its stem: a
/// name whose last word changed, as a unit does.
fn meant(name: &str, known: &[String]) -> Option<String> {
    let upper = name.to_ascii_uppercase();
    let nearest = known
        .iter()
        .map(|candidate| (distance(&upper, candidate), candidate))
        .min_by_key(|(far, _)| *far);
    if let Some((far, candidate)) = nearest
        && far <= NEAR
    {
        return Some(candidate.clone());
    }
    let (stem, _) = upper.rsplit_once('_')?;
    if stem.matches('_').count() < 2 {
        return None;
    }
    let mut sharing = known
        .iter()
        .filter(|candidate| candidate.starts_with(&format!("{stem}_")));
    match (sharing.next(), sharing.next()) {
        (Some(only), None) => Some(only.clone()),
        _ => None,
    }
}

/// Every `MARFA_` and `S3_` name the environment holds that no setting reads, by name.
pub fn find(environment: &Environment) -> Vec<Unknown> {
    let known = known();
    environment
        .names()
        .filter(|name| {
            let upper = name.to_ascii_uppercase();
            PREFIXES.iter().any(|prefix| upper.starts_with(prefix))
        })
        .filter(|name| !known.iter().any(|held| held == name))
        .filter(|name| !COMMAND_LINE.contains(name))
        .map(|name| {
            let upper = name.to_ascii_uppercase();
            Unknown {
                name: name.to_string(),
                meant: meant(name, &known),
                generated: GENERATED
                    .into_iter()
                    .find(|secret| distance(&upper, secret) <= NEAR),
            }
        })
        .collect()
}

/// The lines that refuse a start: an unknown name a letter or two from a secret's.
pub fn refusals(unknown: &[Unknown]) -> Vec<String> {
    unknown
        .iter()
        .filter_map(|entry| entry.generated.map(|secret| entry.refusal(secret)))
        .collect()
}

pub fn warn(unknown: &[Unknown]) {
    for entry in unknown {
        tracing::warn!(setting = entry.name, "{}", entry.sentence());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(pairs: &[(&str, &str)]) -> Vec<Unknown> {
        find(&Environment::from_pairs(pairs))
    }

    #[test]
    fn a_name_the_server_reads_is_not_unknown() {
        let pairs: Vec<(String, String)> = known()
            .into_iter()
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
    fn a_renamed_unit_names_the_setting_that_took_its_place() {
        let entry = &found(&[("MARFA_BLOB_CLEANUP_GRACE_MS", "5000")])[0];
        assert_eq!(
            entry.meant.as_deref(),
            Some("MARFA_BLOB_CLEANUP_GRACE_SECONDS")
        );
        assert_eq!(entry.generated, None);
    }

    #[test]
    fn a_misspelling_names_the_setting_it_is_near() {
        let entry = &found(&[("S3_BUCKT", "x")])[0];
        assert_eq!(entry.meant.as_deref(), Some("S3_BUCKET"));
        let entry = &found(&[("marfa_port", "x")])[0];
        assert_eq!(entry.meant.as_deref(), Some("MARFA_PORT"));
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
}
