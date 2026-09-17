//! Runs against a real server: `MARFA_TEST_URL` and `MARFA_TEST_KEY` name
//! it, `scripts/server-up.sh` provides both. Ignored by default; run with
//! `cargo test -p marfa-core -- --include-ignored`.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use marfa_core::{Core, CoreError, ItemState, ListFilters, Server, Sort, Tier};

fn server() -> Server {
    let url = std::env::var("MARFA_TEST_URL").expect("MARFA_TEST_URL names the server");
    let key = std::env::var("MARFA_TEST_KEY").expect("MARFA_TEST_KEY holds a working key");
    Server { url, key }
}

fn seed(args: &[&str]) -> String {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/seed.sh");
    let output = Command::new(script)
        .args(args)
        .output()
        .expect("seed.sh runs");
    assert!(
        output.status.success(),
        "seed.sh {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn nonce() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    format!("zq{}{}", now.as_secs(), now.subsec_micros())
}

#[test]
#[ignore = "needs a running server"]
fn hydrate_list_search_and_catch_up_against_a_live_server() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let marker = nonce();
    let first = seed(&["note", "First", &format!("{marker} one"), "live,alpha"]);
    let second = seed(&["note", "Second", &format!("{marker} two"), "live"]);
    let third = seed(&["note", &format!("{marker} in the title"), "three"]);
    let file = seed(&["file", "notes.txt", &format!("{marker} in a file")]);

    let core = Core::open(&path, Some(server()))
        .unwrap()
        .with_catch_up_idle(Duration::from_secs(2));
    let report = core
        .hydrate(&["core.note".into(), "core.file".into()], Tier::Library)
        .unwrap();
    assert!(report.items >= 4, "{report:?}");
    assert!(!report.cursor.is_empty());

    let notes = core
        .list(
            &ListFilters {
                r#type: Some("core.note".into()),
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap();
    for id in [&first, &second, &third] {
        assert!(
            notes.iter().any(|note| &note.id == id),
            "note {id} hydrated"
        );
    }
    let files = core
        .list(
            &ListFilters {
                r#type: Some("core.file".into()),
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap();
    assert!(files.iter().any(|item| item.id == file));
    let tagged = core
        .list(
            &ListFilters {
                tags: vec!["live".into(), "alpha".into()],
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap();
    assert_eq!(
        tagged
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.as_str()]
    );

    let hits = core.search(&marker, 20).unwrap();
    let hit_ids: Vec<&str> = hits.iter().map(|hit| hit.item.id.as_str()).collect();
    assert_eq!(
        hit_ids[0], third,
        "the title match ranks first: {hit_ids:?}"
    );
    for id in [&first, &second, &file] {
        assert!(hit_ids.contains(&id.as_str()), "{id} found by search");
    }

    let fourth = seed(&["note", "Fourth", &format!("{marker} four")]);
    seed(&["trash", &first]);
    let caught = core.catch_up().unwrap();
    assert!(caught.applied >= 2, "{caught:?}");
    assert!(core.get(&fourth).unwrap().is_some(), "the new note arrived");
    assert_eq!(core.get(&first).unwrap().unwrap().state, ItemState::Trashed);
    let visible = core.list(&ListFilters::default(), Sort::default()).unwrap();
    assert!(!visible.iter().any(|item| item.id == first));
    let with_bin = core
        .list(
            &ListFilters {
                include_trashed: true,
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap();
    assert!(with_bin.iter().any(|item| item.id == first));

    seed(&["purge", &first]);
    core.catch_up().unwrap();
    assert!(
        core.get(&first).unwrap().is_none(),
        "the purge removed the row"
    );

    let quiet = core.catch_up().unwrap();
    assert_eq!(quiet.applied, 0, "{quiet:?}");
    assert!(quiet.reached_head, "{quiet:?}");

    let status = core.status().unwrap();
    assert_eq!(status.slice_tier, Some(Tier::Library));
    assert_eq!(status.event_cursor.as_deref(), Some(quiet.cursor.as_str()));

    let other = Server {
        url: "http://127.0.0.1:1/".into(),
        key: "marfa_k1_other".into(),
    };
    assert!(matches!(
        Core::open(&path, Some(other)).err(),
        Some(CoreError::WrongServer { .. })
    ));
}
