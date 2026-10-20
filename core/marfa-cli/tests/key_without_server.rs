//! A key from `--key` or `MARFA_API_KEY` belongs to the server named with it.
//! A command that can run on held bytes alone must not run without a server
//! and drop the key without a word.

mod isolated;

use isolated::Isolated;

const MISSING_BLOB: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";

fn run(keychain: &Isolated, args: &[&str], key_from_environment: bool) -> (i32, serde_json::Value) {
    let mut command = keychain.marfa();
    command.arg("--json").args(args);
    if key_from_environment {
        command.env("MARFA_API_KEY", "marfa_k1_environment");
    }
    let output = command.output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let envelope = if stderr.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(stderr.trim())
            .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"))
    };
    (output.status.code().unwrap(), envelope)
}

fn refused_for_its_key(code: i32, envelope: &serde_json::Value) {
    assert_eq!(code, 2, "{envelope}");
    assert_eq!(envelope["error"]["code"], "no_server", "{envelope}");
    let message = envelope["error"]["message"].as_str().unwrap();
    assert!(message.contains("--key or MARFA_API_KEY"), "{message}");
    assert!(message.contains("--url"), "{message}");
}

#[test]
fn a_command_that_can_run_offline_still_refuses_a_key_with_no_server() {
    let keychain = Isolated::new("key-no-server");
    let store = keychain.directory().join("copy.sqlite");
    let store = store.to_str().unwrap();
    let folder = keychain.directory().join("folder");
    std::fs::create_dir(&folder).unwrap();
    let folder = folder.to_str().unwrap();
    let (code, status) = run(&keychain, &["device", "--db", store, "status"], false);
    assert_eq!(code, 0, "{status}");

    let commands: [&[&str]; 3] = [
        &["device", "--db", store, "blobs", "get", MISSING_BLOB],
        &["folders", "pull", folder],
        &["folders", "restore", folder],
    ];
    for command in commands {
        // The witness: with no key, the command runs offline and says what
        // an offline run says, which is not a refusal for its key.
        let (code, offline) = run(&keychain, command, false);
        assert_ne!(
            offline["error"]["code"], "no_server",
            "{command:?}: {offline}"
        );
        assert_ne!(code, 2, "{command:?}: {offline}");

        let mut by_flag = vec!["--key", "marfa_k1_flag"];
        by_flag.extend(command);
        let (code, envelope) = run(&keychain, &by_flag, false);
        refused_for_its_key(code, &envelope);

        let (code, envelope) = run(&keychain, command, true);
        refused_for_its_key(code, &envelope);
    }
}

#[test]
fn signing_in_or_out_is_not_held_to_a_key_that_is_only_exported() {
    let keychain = Isolated::new("key-exported");
    // Neither sends the key, so neither is told to name a server for it: with
    // none named they ask for one in their own words.
    for command in [&["logout"][..], &["keys", "forget"], &["login"]] {
        let (_, envelope) = run(&keychain, command, true);
        let message = envelope["error"]["message"].as_str().unwrap();
        assert_eq!(
            envelope["error"]["code"], "no_server",
            "{command:?}: {envelope}"
        );
        assert!(
            !message.contains("--key or MARFA_API_KEY"),
            "{command:?}: {message}"
        );
    }
}
