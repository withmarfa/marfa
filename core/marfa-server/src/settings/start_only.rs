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
    plain("PORT", "The port the server listens on."),
    plain("MARFA_LISTEN_HOST", "The address the server listens on."),
    plain(
        "TRUSTED_PROXY_CIDRS",
        "The proxies in front of the server whose forwarded addresses it trusts.",
    ),
    plain(
        "TRUSTED_PROXY_HEADER",
        "The header an edge in front of the server puts the caller's address in.",
    ),
    plain("SQLITE_PATH", "Where the database is."),
    plain(
        "SQLITE_BUSY_BUDGET_MS",
        "How long a database request waits for the database, in milliseconds.",
    ),
    plain("BLOB_PATH", "Where the server keeps files."),
    plain(
        "S3_BUCKET",
        "The bucket of an object store kept beside the disk.",
    ),
    plain("S3_REGION", "The region of the object store."),
    secret("S3_ENDPOINT", "Where the object store is."),
    plain(
        "S3_ACCESS_KEY_ID",
        "The key the object store is reached with.",
    ),
    secret(
        "S3_SECRET_ACCESS_KEY",
        "The secret the object store is reached with.",
    ),
    plain(
        "S3_FORCE_PATH_STYLE",
        "Whether the object store is addressed by path rather than by host.",
    ),
    plain(
        "S3_PREFIX",
        "The folder in the bucket the server keeps files under.",
    ),
    plain(
        "MARFA_CONTROL_SOCKET",
        "Where the private socket for the person running the server is.",
    ),
    plain(
        "MARFA_CONTROL_ONLY",
        "Starts the private socket alone, for recovery.",
    ),
    secret("API_KEY_SALT", "Secret that keys are stored under."),
    secret("MARFA_AUTH_SECRET", "Secret that sign-in is signed with."),
    secret(
        "ERROR_WEBHOOK_URL",
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
    hook(
        "MARFA_TEST_MIGRATION_FAULT",
        "Makes the next migration fail in a chosen way.",
    ),
    hook(
        "MARFA_TEST_FREE_DISK_BYTES",
        "Sets the free disk space the server sees.",
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
    fn test_hooks_are_listed_only_when_they_are_on() {
        let environment = Environment::from_pairs(&[("PORT", "8600")]);
        let off = listed(&environment, false);
        assert!(off.iter().all(|entry| !entry.declared.test_hook));
        assert!(
            off.iter()
                .any(|entry| entry.declared.name == "PORT" && entry.set)
        );
        assert!(listed(&environment, true).len() > off.len());
    }
}
