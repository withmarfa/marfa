//! `marfa metrics` as a process: it prints what the server answers, memory,
//! CPU and database figures included, and sends the key it was given.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use door::{Answer, Door};

const METRICS: &str = r#"{"items":{"total":3,"by_state":{"active":3}},"blobs":{"count":1,"total_bytes":10},"types":{"core":5,"registered":0},"keys":{"total":2},"webhooks":{"total":0},"uptime_seconds":42,"process":{"release":"v0.0.99","memory_rss_bytes":300000000,"memory_rss_peak_bytes":400000000,"cpu_user_seconds":12.5,"cpu_system_seconds":3.25},"storage":{"database_bytes":2000000,"wal_bytes":0,"rows":{"items":3,"versions":4,"event_log":5,"audit_log":6}}}"#;

fn run(url: &str, args: &[&str]) -> (i32, String, String) {
    let nowhere =
        std::env::temp_dir().join(format!("marfa-metrics-no-keychain-{}", std::process::id()));
    let output = quiet::marfa()
        .env("MARFA_API_URL", url)
        .env("MARFA_API_KEY", "marfa_k1_fixture")
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_KEYCHAIN", nowhere)
        .env_remove("MARFA_DB")
        .args(args)
        .output()
        .unwrap();
    (
        output.status.code().unwrap(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[test]
fn metrics_prints_the_process_and_storage_figures_the_server_reports() {
    let door = Door::open(vec![
        Answer::json("200 OK", METRICS),
        Answer::json("200 OK", METRICS),
    ]);
    let (code, stdout, stderr) = run(&door.url, &["--json", "metrics"]);
    assert_eq!(code, 0, "{stderr}");
    let printed: serde_json::Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(
        printed,
        serde_json::from_str::<serde_json::Value>(METRICS).unwrap()
    );
    assert_eq!(printed["process"]["memory_rss_bytes"], 300000000);
    assert_eq!(printed["storage"]["rows"]["audit_log"], 6);

    let (code, plain, stderr) = run(&door.url, &["metrics"]);
    assert_eq!(code, 0, "{stderr}");
    for figure in ["memory_rss_bytes", "wal_bytes", "event_log", "v0.0.99"] {
        assert!(plain.contains(figure), "{figure} missing from:\n{plain}");
    }

    let received = door.received();
    assert!(received.iter().all(|r| r.path() == "/metrics"));
    assert!(received.iter().all(|r| {
        r.header("authorization")
            .is_some_and(|v| v.contains("marfa_k1_fixture"))
    }));
}
