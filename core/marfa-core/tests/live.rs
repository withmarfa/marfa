//! Runs against a real server: `MARFA_TEST_URL` and `MARFA_TEST_KEY` name
//! it, `scripts/server-up.sh` provides both. Ignored by default; run with
//! `cargo nextest run -p marfa-core --run-ignored only`.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use marfa_core::{
    Core, CoreError, Hydration, ItemState, ListFilters, SearchFilters, Server, Sort, Tier,
};

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
    // Equal token counts and match frequencies give the first two rows tied ranks.
    let second = seed(&["note", "Second", &format!("{marker} two"), "live,beta"]);
    let third = seed(&[
        "note",
        &format!("{marker} in the title"),
        "three longer words make this match less concentrated",
    ]);
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

    let hits = core.search(&marker, &SearchFilters::default(), 20).unwrap();
    let hit_ids: Vec<&str> = hits.iter().map(|hit| hit.item.id.as_str()).collect();
    let mut found = hit_ids.clone();
    found.sort_unstable();
    let mut expected = vec![
        first.as_str(),
        second.as_str(),
        third.as_str(),
        file.as_str(),
    ];
    expected.sort_unstable();
    assert_eq!(found, expected, "all four rows match the marker");
    let score = |id: &str| hits.iter().find(|hit| hit.item.id == id).unwrap().score;
    assert_eq!(score(&first), score(&second), "the tie-order witness");
    assert!(score(&first) > score(&third), "the score-order witness");
    for pair in hits.windows(2) {
        assert!(
            pair[0].score > pair[1].score
                || (pair[0].score == pair[1].score && pair[0].item.id < pair[1].item.id),
            "hits rank by score descending, then identifier ascending: {hits:?}"
        );
    }

    let fourth = seed(&["note", "Fourth", &format!("{marker} four")]);
    seed(&["trash", &first]);
    let caught = core.catch_up().unwrap();
    assert!(caught.applied >= 2, "{caught:?}");
    assert!(core.get(&fourth).unwrap().is_some(), "the new note arrived");
    assert!(
        core.get(&first).unwrap().is_none(),
        "a trashed row is still readable by id, where the server answers 404"
    );
    let visible = core.list(&ListFilters::default(), Sort::default()).unwrap();
    assert!(!visible.iter().any(|item| item.id == first));
    let with_bin = core
        .list(
            &ListFilters {
                all_states: true,
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap();
    let binned = with_bin
        .iter()
        .find(|item| item.id == first)
        .expect("the copy dropped the trashed row rather than holding it");
    assert_eq!(binned.state, ItemState::Trashed);

    seed(&["purge", &first]);
    core.catch_up().unwrap();
    let after_purge = core
        .list(
            &ListFilters {
                all_states: true,
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap();
    assert!(
        !after_purge.iter().any(|item| item.id == first),
        "the purge left the row in the store, where the server has deleted it"
    );

    let quiet = core.catch_up().unwrap();
    assert_eq!(quiet.applied, 0, "{quiet:?}");
    assert!(quiet.reached_head, "{quiet:?}");

    let status = core.status().unwrap();
    assert_eq!(status.slice_tier, Some(Tier::Library));
    assert_eq!(status.hydration, Hydration::Complete);
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
