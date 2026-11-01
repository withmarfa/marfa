//! Every test that starts `marfa` goes through `support/quiet.rs`, so that a
//! test which fails on purpose never reports to a developer's PostHog.

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::path::{Path, PathBuf};
use std::process::Command;

fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn no_test_file_starts_the_binary_without_the_helper() {
    // Built in two parts so this file does not name it.
    let binary = format!("CARGO_BIN_EXE_{}", "marfa");
    let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut files = Vec::new();
    rust_files(&tests, &mut files);
    let mut offenders = Vec::new();
    let mut named = 0;
    for file in files {
        let relative = file.strip_prefix(&tests).unwrap().to_owned();
        let text = std::fs::read_to_string(&file).unwrap();
        for (number, line) in text.lines().enumerate() {
            if !line.contains(&binary) {
                continue;
            }
            // The helper itself, and the one script that hands the path to a
            // child it sets the whole environment of, to prove the runner.
            let allowed = relative == Path::new("support/quiet.rs")
                || (relative == Path::new("telemetry.rs") && line.contains("\"MARFA_BIN\""));
            if allowed {
                named += 1;
            } else {
                offenders.push(format!("{}:{}", relative.display(), number + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "start the binary with quiet::marfa(): {offenders:?}"
    );
    // The witness: the scan finds the places that are allowed to name it.
    assert_eq!(named, 2, "the scan no longer sees the allowed places");
}

#[test]
fn the_helper_removes_telemetry_settings_and_turns_the_sdk_off() {
    let mut planted = Command::new("env");
    planted
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
        .env("MARFA_OTEL_X", "1")
        .env("MARFA_POSTHOG_HOST", "http://127.0.0.1:1")
        .env("MARFA_POSTHOG_PROJECT_TOKEN", "t")
        .env("OTEL_SDK_DISABLED", "false")
        .env("MARFA_KEPT", "yes");
    let output = quiet::quiet(planted).output().unwrap();
    let text = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = text.lines().collect();
    assert!(lines.contains(&"OTEL_SDK_DISABLED=true"));
    assert!(lines.contains(&"MARFA_KEPT=yes"));
    assert!(
        !lines.iter().any(|line| line.starts_with("OTEL_EXPORTER")
            || line.starts_with("MARFA_OTEL_")
            || line.starts_with("MARFA_POSTHOG_")),
        "{lines:?}"
    );
}
