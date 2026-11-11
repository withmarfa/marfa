//! Environment names that a program other than the server reads.

/// Names the `marfa` command reads from a shell, and `marfa server run` hands on, so a server
/// that finds one in its environment has no setting to warn of.
pub const COMMAND_LINE: [&str; 12] = [
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
