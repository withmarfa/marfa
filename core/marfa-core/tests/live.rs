//! Runs against a real server: `MARFA_TEST_URL` and `MARFA_TEST_KEY` name
//! it, `scripts/server-up.sh` provides both. Ignored by default; run with
//! `cargo nextest run -p marfa-core --run-ignored only`.

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use marfa_core::{
    Core, CoreError, Hydration, ItemState, ListFilters, SearchFilters, Server, SliceTier, Sort,
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
        .hydrate(
            &["core.note".into(), "core.file".into()],
            SliceTier::Library,
        )
        .unwrap();
    assert!(report.items >= 4, "{report:?}");
    assert!(!report.cursor.is_empty());

    let notes = core
        .list(
            &ListFilters {
                types: Some(vec!["core.note".into()]),
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap()
        .rows;
    for id in [&first, &second, &third] {
        assert!(
            notes.iter().any(|note| &note.id == id),
            "note {id} hydrated"
        );
    }
    let files = core
        .list(
            &ListFilters {
                types: Some(vec!["core.file".into()]),
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap()
        .rows;
    assert!(files.iter().any(|item| item.id == file));
    let tagged = core
        .list(
            &ListFilters {
                tags: vec!["live".into(), "alpha".into()],
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap()
        .rows;
    assert_eq!(
        tagged
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![first.as_str()]
    );

    let hits = core
        .search(&marker, &SearchFilters::default(), 20)
        .unwrap()
        .rows;
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
    let visible = core
        .list(&ListFilters::default(), Sort::default())
        .unwrap()
        .rows;
    assert!(!visible.iter().any(|item| item.id == first));
    let with_bin = core
        .list(
            &ListFilters {
                all_states: true,
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap()
        .rows;
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
        .unwrap()
        .rows;
    assert!(
        !after_purge.iter().any(|item| item.id == first),
        "the purge left the row in the store, where the server has deleted it"
    );

    let quiet = core.catch_up().unwrap();
    assert_eq!(quiet.applied, 0, "{quiet:?}");
    assert_eq!(quiet.skipped, 0, "{quiet:?}");

    let status = core.status().unwrap();
    assert_eq!(status.slice_tier, Some(SliceTier::Library));
    assert_eq!(status.hydration, Hydration::Complete);
    assert_eq!(status.event_cursor.as_deref(), Some(quiet.cursor.as_str()));

    let before_rows = core
        .list(&ListFilters::default(), Sort::default())
        .unwrap()
        .rows;
    let before_queue = core.queue().unwrap();
    drop(core);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let other = Server {
        url: format!("http://{}", listener.local_addr().unwrap()),
        key: "marfa_k1_other".into(),
    };
    drop(listener);
    let moved = Core::open(&path, Some(other)).unwrap();
    assert_eq!(moved.status().unwrap(), status);
    assert!(matches!(
        moved.server_catalog_until(&std::sync::atomic::AtomicBool::new(false)),
        Err(CoreError::Network(_))
    ));
    assert_eq!(moved.status().unwrap(), status);
    assert_eq!(moved.queue().unwrap(), before_queue);
    assert_eq!(
        moved
            .list(&ListFilters::default(), Sort::default())
            .unwrap()
            .rows,
        before_rows
    );
}

fn post(url: &str, headers: &[(&str, &str)], content_type: &str, body: &str) -> ureq::Body {
    let mut request = ureq::post(url).header("Content-Type", content_type);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request
        .send(body)
        .unwrap_or_else(|error| panic!("POST {url} failed: {error}"))
        .into_body()
}

fn field(text: &str, name: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text).unwrap()[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name} is missing from {text}"))
        .to_string()
}

/// The access token of a signed-in app: the way a device holds one, a
/// device code the owner approves for reading notes. Unlike a key, it is a
/// bound credential, so a read under a reach is judged against its grant.
fn app_token(url: &str) -> String {
    let form = "application/x-www-form-urlencoded";
    let registered = post(
        &format!("{url}/auth/oauth2/register"),
        &[],
        "application/json",
        r#"{"client_name":"core-live","application_type":"native","grant_types":["urn:ietf:params:oauth:grant-type:device_code"],"response_types":[],"token_endpoint_auth_method":"none"}"#,
    )
    .read_to_string()
    .unwrap();
    let client_id = field(&registered, "client_id");
    let code = post(
        &format!("{url}/auth/device/code"),
        &[],
        form,
        &format!("client_id={client_id}&scope=core.note:read"),
    )
    .read_to_string()
    .unwrap();
    let email = std::env::var("MARFA_TEST_OWNER_EMAIL").expect("the boot names its owner");
    let password = std::env::var("MARFA_TEST_OWNER_PASSWORD").expect("the boot names its owner");
    let sign_in = ureq::post(format!("{url}/auth/sign-in/email"))
        .header("Content-Type", "application/json")
        .header("Origin", url)
        .send(serde_json::json!({"email": email, "password": password}).to_string())
        .unwrap();
    let cookie = sign_in
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.contains("session_token="))
        .and_then(|value| value.split(';').next())
        .expect("the owner's sign-in sets a session cookie")
        .to_string();
    post(
        &format!("{url}/auth/device/consent"),
        &[("Cookie", &cookie), ("Origin", url)],
        form,
        &format!(
            "user_code={}&decision=approve&access=full&scopes=core.note:read",
            field(&code, "user_code")
        ),
    );
    let token = post(
        &format!("{url}/auth/oauth2/token"),
        &[],
        form,
        &format!(
            "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code={}&client_id={client_id}",
            field(&code, "device_code")
        ),
    )
    .read_to_string()
    .unwrap();
    field(&token, "access_token")
}

#[test]
#[ignore = "needs a running server"]
fn a_signed_in_device_hydrates_under_its_reach() {
    let url = server().url;
    let marker = nonce();
    let note = seed(&["note", "Device", &format!("{marker} read by a device")]);
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(
        dir.path().join("core.sqlite"),
        Some(Server {
            url: url.clone(),
            key: app_token(&url),
        }),
    )
    .unwrap();
    let report = core
        .hydrate(&["core.note".into()], SliceTier::Library)
        .expect("a bound credential hydrates the type it may read");
    assert!(report.items >= 1, "{report:?}");
    let rows = core
        .list(
            &ListFilters {
                types: Some(vec!["core.note".into()]),
                ..Default::default()
            },
            Sort::default(),
        )
        .unwrap()
        .rows;
    assert!(rows.iter().any(|row| row.id == note), "the note hydrated");
}
