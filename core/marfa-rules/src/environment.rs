//! Environment names that a program other than the server reads.

/// What a service unit that `marfa server install` writes sets, so the server knows a service
/// manager restarts it when it exits with a failure: `launchd` or `systemd`.
pub const SERVICE: &str = "MARFA_SERVICE";

/// The install folder, which `marfa server run --dir` sets for the server it starts. Only that
/// command counts the starts of a release an update has not settled, so a server swaps its own
/// programs only where this is set.
pub const INSTALL_DIR: &str = "MARFA_INSTALL_DIR";

/// Names the `marfa` command reads from a shell, and `marfa server run` hands on, and the one
/// a service unit sets, so a server that finds one in its environment has no setting to warn of.
pub const COMMAND_LINE: [&str; 15] = [
    SERVICE,
    INSTALL_DIR,
    "MARFA_API_URL",
    "MARFA_API_KEY",
    "MARFA_PROFILE",
    "MARFA_NO_KEYCHAIN",
    "MARFA_KEYCHAIN",
    "MARFA_ALLOW_HTTP",
    "MARFA_DB",
    "MARFA_DOCS_URL",
    "MARFA_PLUGINS_URL",
    "MARFA_DOCKER",
    "MARFA_TAILSCALE",
    "MARFA_FOLDER_REGISTRY",
    "MARFA_TELEMETRY_FILE",
];
