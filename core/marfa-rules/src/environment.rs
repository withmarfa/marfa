//! Environment names that a program other than the server reads.

/// What a service unit that `marfa server install` writes sets, so the server knows a service
/// manager restarts it when it exits with a failure: `launchd` or `systemd`.
pub const SERVICE: &str = "MARFA_SERVICE";

/// Names the `marfa` command reads from a shell, and `marfa server run` hands on, and the one
/// a service unit sets, so a server that finds one in its environment has no setting to warn of.
pub const COMMAND_LINE: [&str; 13] = [
    SERVICE,
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
    "MARFA_FOLDER_REGISTRY",
    "MARFA_TELEMETRY_FILE",
];
