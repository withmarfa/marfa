//! The binary leaves by the door its help documents, end to end: the process
//! exit code and what stderr carries, for every class reachable without a
//! server. A server's own refusal (exit 1 with the server's code) needs one
//! and is held by the scenario suite under `conformance/`.

use std::path::PathBuf;
use std::process::Command;

fn marfa() -> Command {
    Command::new(env!("CARGO_BIN_EXE_marfa"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("marfa-exit-codes-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("store.sqlite")
}

/// Runs the binary with no server or credential in the environment, so the
/// answer comes from the arguments alone.
fn run(args: &[&str]) -> (i32, String, String) {
    run_with(args, &[])
}

fn run_with(args: &[&str], env: &[(&str, &str)]) -> (i32, String, String) {
    let mut command = marfa();
    command
        .args(args)
        .env_remove("MARFA_API_URL")
        .env_remove("MARFA_API_KEY")
        .env_remove("MARFA_DB");
    for (name, value) in env {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn read_envelope(stderr: &str) -> serde_json::Value {
    serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"))
}

/// Whether this machine's keychain names a current server, which the
/// binary consults when nothing else names one: the cases that expect
/// `no_server` cannot be held on a machine where a kept credential answers.
/// The built binary reads the real keychain (the per-run test service is
/// the unit tests' alone), so on a developer's machine the verdict adapts
/// to what they have kept.
fn keychain_names_a_server() -> bool {
    let (code, _, stderr) = run(&["--json", "status"]);
    code != 2 || !stderr.contains("no_server")
}

#[test]
fn a_usage_refusal_leaves_by_two() {
    let (code, stdout, stderr) = run(&["--json", "device", "queue"]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "no_store");
    assert_eq!(envelope["exit"], 2);

    let store = scratch("usage");
    if keychain_names_a_server() {
        eprintln!("skipped the no_server cases: this machine's keychain names a server");
    } else {
        let (code, _, stderr) =
            run(&["--json", "device", "--db", store.to_str().unwrap(), "drain"]);
        assert_eq!(code, 2, "{stderr}");
        assert_eq!(read_envelope(&stderr)["error"]["code"], "no_server");
        let (code, _, stderr) = run(&["--json", "items", "list"]);
        assert_eq!(code, 2, "{stderr}");
        assert_eq!(read_envelope(&stderr)["error"]["code"], "no_server");
    }
    // The table needs no server at all.
    let (code, stdout, _) = run(&["--json", "operations"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("\"operation_id\""));

    // clap's own refusal: exit 2, its usage text, no envelope.
    let (code, _, stderr) = run(&[
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "nothing",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("Usage:"), "{stderr}");
    assert!(!stderr.trim_start().starts_with('{'), "{stderr}");
}

/// The binary's own refusal of an argument, before anything is sent.
#[test]
fn an_argument_the_binary_refuses_leaves_by_one() {
    let (code, stdout, stderr) = run(&[
        "--json",
        "--url",
        "http://127.0.0.1:1",
        "--key",
        "marfa_k1_test",
        "items",
        "create",
        "--type",
        "core.note",
        "--properties",
        "[1]",
    ]);
    assert_eq!(code, 1, "{stderr}");
    assert_eq!(stdout, "");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "invalid");
    assert!(envelope["error"]["server"].is_null());
    assert_eq!(envelope["exit"], 1);
}

#[test]
fn an_environment_failure_leaves_by_three() {
    let store = scratch("network");
    let (code, _, stderr) = run(&[
        "--json",
        "--url",
        "http://127.0.0.1:1",
        "--key",
        "marfa_k1_test",
        "device",
        "--db",
        store.to_str().unwrap(),
        "hydrate",
        "--types",
        "core.note",
        "--tier",
        "library",
    ]);
    assert_eq!(code, 3, "{stderr}");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "network");
    assert!(envelope["error"]["server"].is_null());
    assert_eq!(envelope["exit"], 3);

    // A direct command takes the same flags and meets the same door.
    let (code, _, stderr) = run(&[
        "--json",
        "--url",
        "http://127.0.0.1:1",
        "--key",
        "marfa_k1_test",
        "status",
    ]);
    assert_eq!(code, 3, "{stderr}");
    assert_eq!(read_envelope(&stderr)["error"]["code"], "network");
}

#[test]
fn a_refusal_under_the_device_rules_leaves_by_four() {
    let store = scratch("local");
    let (code, _, stderr) = run(&[
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "items",
        "list",
    ]);
    assert_eq!(code, 4, "{stderr}");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "hydration_incomplete");
    assert_eq!(envelope["exit"], 4);

    // Without `--json`, the sentence, prefixed, and no JSON.
    let (code, stdout, stderr) = run(&["device", "--db", store.to_str().unwrap(), "items", "list"]);
    assert_eq!(code, 4, "{stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.starts_with("marfa: "), "{stderr}");
    assert!(!stderr.contains('{'), "{stderr}");
}

#[test]
fn a_missing_credential_leaves_by_five() {
    let store = scratch("credential");
    let (code, _, stderr) = run(&[
        "--json",
        "--url",
        "http://127.0.0.1:1",
        "device",
        "--db",
        store.to_str().unwrap(),
        "drain",
    ]);
    assert_eq!(code, 5, "{stderr}");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "no_credential");
    assert_eq!(envelope["exit"], 5);

    // A variable exported as nothing names no credential.
    let (code, _, stderr) = run_with(
        &["--json", "--url", "http://127.0.0.1:1", "items", "list"],
        &[("MARFA_API_KEY", "  ")],
    );
    assert_eq!(code, 5, "{stderr}");
    assert_eq!(read_envelope(&stderr)["error"]["code"], "no_credential");
}
