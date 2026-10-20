//! A run with the keychain off, as a process. The keychain it would reach
//! does not exist, so a command that looked in it would end with
//! `no_keychain` and exit 4 rather than the answer these tests expect.

mod isolated;

use isolated::Isolated;

fn run(keychain: &Isolated, args: &[&str], env: &[(&str, &str)]) -> (i32, serde_json::Value) {
    let mut command = keychain.marfa();
    command.env("MARFA_KEYCHAIN", keychain.missing()).args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    let envelope = serde_json::from_str(stderr.trim())
        .unwrap_or_else(|error| panic!("stderr is not one JSON object: {error}\n{stderr}"));
    (output.status.code().unwrap(), envelope)
}

#[test]
fn a_command_that_would_store_something_says_how_to_pass_a_key() {
    let keychain = Isolated::new("off-stores");
    let url = "http://127.0.0.1:9";
    // The witness: with the keychain on, the command does reach it, and the
    // keychain it names is not there.
    let (code, envelope) = run(&keychain, &["--json", "--url", url, "keys", "forget"], &[]);
    assert_eq!(
        (code, &envelope["error"]["code"]),
        (4, &"no_keychain".into())
    );

    for (command, instead) in [
        (&["keys", "keep"][..], "--key"),
        (&["keys", "forget"], "--key"),
        (&["logout"], "--key"),
        (&["login"], "--print-token"),
    ] {
        for (flag, env) in [(Some("--no-keychain"), None), (None, Some("1"))] {
            let mut args = vec!["--json", "--url", url];
            args.extend(flag);
            args.extend(command);
            let env: Vec<_> = env
                .map(|value| ("MARFA_NO_KEYCHAIN", value))
                .into_iter()
                .collect();
            let (code, envelope) = run(&keychain, &args, &env);
            assert_eq!(code, 2, "{command:?}: {envelope}");
            assert_eq!(envelope["error"]["code"], "usage", "{command:?}");
            let message = envelope["error"]["message"].as_str().unwrap();
            assert!(message.contains("the keychain is off"), "{message}");
            assert!(message.contains(instead), "{command:?}: {message}");
        }
    }
}

#[test]
fn a_command_that_needs_a_server_asks_for_one_rather_than_reading_the_keychain() {
    let keychain = Isolated::new("off-server");
    let (code, envelope) = run(
        &keychain,
        &[
            "--json",
            "--no-keychain",
            "--key",
            "marfa_k1_flag",
            "items",
            "list",
        ],
        &[],
    );
    assert_eq!(code, 2, "{envelope}");
    assert_eq!(envelope["error"]["code"], "no_server");

    let (code, envelope) = run(
        &keychain,
        &["--json", "items", "list"],
        &[("MARFA_NO_KEYCHAIN", "true")],
    );
    assert_eq!(code, 2, "{envelope}");
    assert_eq!(envelope["error"]["code"], "no_server");
    assert!(
        envelope["error"]["message"]
            .as_str()
            .unwrap()
            .contains("MARFA_API_URL"),
        "{envelope}"
    );
}

#[test]
fn keeping_or_forgetting_a_key_says_the_keychain_is_off_before_asking_for_a_server() {
    let keychain = Isolated::new("off-first");
    for command in [&["keys", "keep"][..], &["keys", "forget"]] {
        for flag in [Some("--no-keychain"), None] {
            let mut args = vec!["--json"];
            args.extend(flag);
            args.extend(command);
            let env: Vec<_> = flag
                .is_none()
                .then_some(("MARFA_NO_KEYCHAIN", "1"))
                .into_iter()
                .collect();
            let (code, envelope) = run(&keychain, &args, &env);
            assert_eq!(code, 2, "{command:?}: {envelope}");
            assert_eq!(
                envelope["error"]["code"], "usage",
                "{command:?}: {envelope}"
            );
            let message = envelope["error"]["message"].as_str().unwrap();
            assert!(message.contains("the keychain is off"), "{message}");
        }
    }
}
