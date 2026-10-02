mod isolated;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use isolated::Isolated;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("marfa-exit-codes-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("store.sqlite")
}

fn run(args: &[&str]) -> (i32, String, String) {
    run_with(args, &[])
}

fn run_with(args: &[&str], env: &[(&str, &str)]) -> (i32, String, String) {
    static RUNS: AtomicUsize = AtomicUsize::new(0);
    let keychain = Isolated::new(&format!("exit-{}", RUNS.fetch_add(1, Ordering::Relaxed)));
    let mut command = keychain.marfa();
    command.args(args);
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

#[test]
fn a_usage_refusal_leaves_by_two() {
    let (code, stdout, stderr) = run(&["--json", "device", "queue"]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "no_store");
    assert_eq!(envelope["exit"], 2);

    let store = scratch("usage");
    let (code, _, stderr) = run(&["--json", "device", "--db", store.to_str().unwrap(), "drain"]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(read_envelope(&stderr)["error"]["code"], "no_server");
    let (code, _, stderr) = run(&["--json", "items", "list"]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(read_envelope(&stderr)["error"]["code"], "no_server");
    let (code, stdout, _) = run(&["--json", "operations"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("\"operation_id\""));

    let (code, stdout, stderr) = run(&[
        "--json",
        "device",
        "--db",
        store.to_str().unwrap(),
        "nothing",
    ]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    let envelope = read_envelope(&stderr);
    assert_eq!(envelope["error"]["code"], "usage");
    assert!(
        envelope["error"]["message"]
            .as_str()
            .unwrap()
            .contains("'nothing'"),
        "{stderr}"
    );
    assert!(envelope["error"]["server"].is_null());
    assert_eq!(envelope["exit"], 2);
    for args in [
        &["items", "get", "--json"][..],
        &["--json", "device"],
        &["--json", "items", "list", "--sort", "sideways"],
    ] {
        let (code, _, stderr) = run(args);
        assert_eq!(code, 2, "{args:?}: {stderr}");
        let envelope = read_envelope(&stderr);
        assert_eq!(envelope["error"]["code"], "usage", "{args:?}");
        assert_eq!(envelope["exit"], 2, "{args:?}");
    }

    // After `--`, `--json` is a value, not the flag.
    for args in [
        &["items", "get"][..],
        &[
            "device",
            "--db",
            store.to_str().unwrap(),
            "nothing",
            "--",
            "--json",
        ],
    ] {
        let (code, _, stderr) = run(args);
        assert_eq!(code, 2, "{args:?}: {stderr}");
        assert!(stderr.contains("Usage:"), "{stderr}");
        assert!(!stderr.trim_start().starts_with('{'), "{stderr}");
    }

    let (code, stdout, _) = run(&["--json", "--version"]);
    assert_eq!(code, 0);
    assert!(stdout.starts_with("marfa "), "{stdout}");
    let (code, stdout, _) = run(&["--json", "device", "--help"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Usage:"), "{stdout}");
}

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
        "status",
    ]);
    assert_eq!(code, 0, "{stderr}");
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

    // Whitespace-only names no credential.
    let (code, _, stderr) = run_with(
        &["--json", "--url", "http://127.0.0.1:1", "items", "list"],
        &[("MARFA_API_KEY", "  ")],
    );
    assert_eq!(code, 5, "{stderr}");
    assert_eq!(read_envelope(&stderr)["error"]["code"], "no_credential");
}
