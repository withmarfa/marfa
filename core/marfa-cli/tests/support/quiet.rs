//! The only way a CLI integration test starts the `marfa` binary. A test
//! that fails on purpose ends a command in a fault, which reports an
//! exception wherever `MARFA_POSTHOG_*` points, so no test may inherit a
//! developer's telemetry settings. `quiet_binary.rs` fails any test file that
//! starts the binary another way. A test that wants telemetry sets its own
//! environment on the command this returns.

use std::process::Command;

/// Whether `name` is one of the settings that route telemetry.
fn is_telemetry(name: &str) -> bool {
    name.starts_with("OTEL_")
        || name.starts_with("MARFA_OTEL_")
        || name.starts_with("MARFA_POSTHOG_")
}

/// Takes the telemetry settings out of the command's environment, the
/// inherited ones and any already set on it, and turns the SDK off.
pub fn quiet(mut command: Command) -> Command {
    let inherited = std::env::vars_os().map(|(name, _)| name);
    let set = command
        .get_envs()
        .map(|(name, _)| name.to_os_string())
        .collect::<Vec<_>>();
    for name in inherited.chain(set) {
        if name.to_str().is_some_and(is_telemetry) {
            command.env_remove(name);
        }
    }
    command.env("OTEL_SDK_DISABLED", "true");
    command
}

/// The `marfa` binary under test, with no telemetry.
pub fn marfa() -> Command {
    quiet(Command::new(env!("CARGO_BIN_EXE_marfa")))
}
