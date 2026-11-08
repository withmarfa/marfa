//! The settings only the environment sets, listed by name for a person who
//! asks. A value never leaves here: some are secrets, and the rest are the
//! machine's own to show.

use super::Environment;

/// One setting read when the process starts.
#[derive(Debug)]
pub struct Declared {
    pub name: &'static str,
    pub description: &'static str,
    /// It is a secret, or can hold one.
    pub secret: bool,
    /// Only a server started for tests reads it.
    pub test_hook: bool,
}

const fn plain(name: &'static str, description: &'static str) -> Declared {
    Declared {
        name,
        description,
        secret: false,
        test_hook: false,
    }
}

const fn secret(name: &'static str, description: &'static str) -> Declared {
    Declared {
        name,
        description,
        secret: true,
        test_hook: false,
    }
}

const fn hook(name: &'static str, description: &'static str) -> Declared {
    Declared {
        name,
        description,
        secret: false,
        test_hook: true,
    }
}

pub const DECLARED: &[Declared] = &[
    plain("MARFA_PORT", "The port the server listens on."),
    plain("MARFA_LISTEN_HOST", "The address the server listens on."),
    plain(
        "MARFA_TRUSTED_PROXY_CIDRS",
        "The proxies in front of the server whose forwarded addresses it trusts.",
    ),
    plain(
        "MARFA_TRUSTED_PROXY_HEADER",
        "The header an edge in front of the server puts the caller's address in.",
    ),
    plain("MARFA_DATABASE_PATH", "Where the database is."),
    plain(
        "MARFA_WRITE_WAIT_MS",
        "How long a write waits for the one writer before it fails, in milliseconds.",
    ),
    plain("MARFA_BLOB_PATH", "Where the server keeps files."),
    plain(
        "MARFA_CONTROL_SOCKET",
        "Where the private socket for the person running the server is.",
    ),
    plain(
        "MARFA_CONTROL_ONLY",
        "Starts the private socket alone, for recovery.",
    ),
    secret("MARFA_KEY_SALT", "Secret that keys are stored under."),
    secret("MARFA_AUTH_SECRET", "Secret that sign-in is signed with."),
    secret(
        "MARFA_ERROR_WEBHOOK_URL",
        "Where a notice of a server error is sent.",
    ),
    plain(
        "MARFA_ERROR_WEBHOOK_TIMEOUT_MS",
        "How long a notice of a server error may take to send, in milliseconds.",
    ),
    secret("MARFA_HEARTBEAT_URL", "Where the heartbeat is sent."),
    plain("MARFA_POSTHOG_HOST", "Where exception reports are sent."),
    secret(
        "MARFA_POSTHOG_PROJECT_TOKEN",
        "The token exception reports are sent with.",
    ),
    plain(
        "MARFA_OTEL_SAMPLE_RATIO",
        "The share of requests whose traces are kept.",
    ),
    plain("OTEL_SDK_DISABLED", "Turns telemetry off."),
    plain(
        "OTEL_SERVICE_NAME",
        "The name telemetry reports the server as.",
    ),
    plain(
        "OTEL_RESOURCE_ATTRIBUTES",
        "Extra labels telemetry carries.",
    ),
    secret("OTEL_EXPORTER_OTLP_ENDPOINT", "Where telemetry is sent."),
    secret(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "Where traces are sent.",
    ),
    secret("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "Where logs are sent."),
    secret(
        "OTEL_EXPORTER_OTLP_HEADERS",
        "Headers telemetry is sent with.",
    ),
    secret(
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
        "Headers traces are sent with.",
    ),
    secret(
        "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
        "Headers logs are sent with.",
    ),
    hook("MARFA_TEST_HOOKS", "Turns the test hooks on."),
    hook(
        "MARFA_TEST_CLOCK_OFFSET_MS",
        "Moves the server's clock, in milliseconds.",
    ),
    hook(
        "MARFA_TEST_CONTRACT_VERSION",
        "Sets the contract version the server reports.",
    ),
];

/// One declared setting and whether the environment sets it.
#[derive(Debug)]
pub struct Listed {
    pub declared: &'static Declared,
    pub set: bool,
}

/// The settings to list: every declared one, test hooks only when they are on.
pub fn listed(environment: &Environment, hooks_on: bool) -> Vec<Listed> {
    DECLARED
        .iter()
        .filter(|declared| hooks_on || !declared.test_hook)
        .map(|declared| Listed {
            declared,
            set: environment.get(declared.name).is_some(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_listed_once_and_describes_itself() {
        for (index, declared) in DECLARED.iter().enumerate() {
            assert!(!declared.description.is_empty(), "{}", declared.name);
            assert!(
                DECLARED[index + 1..]
                    .iter()
                    .all(|other| other.name != declared.name),
                "{}",
                declared.name
            );
        }
    }

    #[test]
    fn the_contract_tables_each_name_declared() {
        let spec = include_str!("../../../../conformance/spec/instance.md");
        let section = spec
            .split("\n## Start-only settings\n")
            .nth(1)
            .and_then(|rest| rest.split("\n## ").next())
            .expect("instance.md holds the section");
        let tabled: Vec<&str> = section
            .lines()
            .filter_map(|line| line.strip_prefix("| `"))
            .filter_map(|rest| rest.split('`').next())
            .collect();
        let held: Vec<&str> = DECLARED.iter().map(|declared| declared.name).collect();
        for name in &held {
            assert!(tabled.contains(name), "{name} is not tabled");
        }
    }

    #[test]
    fn test_hooks_are_listed_only_when_they_are_on() {
        let environment = Environment::from_pairs(&[("MARFA_PORT", "8600")]);
        let off = listed(&environment, false);
        assert!(off.iter().all(|entry| !entry.declared.test_hook));
        assert!(
            off.iter()
                .any(|entry| entry.declared.name == "MARFA_PORT" && entry.set)
        );
        assert!(listed(&environment, true).len() > off.len());
    }
}
