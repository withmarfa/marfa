//! What a person types and reads: `--all` joining pages, the bin emptied by
//! itself, `--prop` read as its field's kind, and the flags for an edge's two
//! ends.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::path::Path;

use door::{Answer, Door};
use serde_json::{Value, json};

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("marfa-flags-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::canonicalize(dir).unwrap()
}

fn run(home: &Path, url: &str, args: &[&str]) -> Ran {
    let output = quiet::marfa()
        .env("HOME", home)
        .env("MARFA_API_URL", url)
        .env("MARFA_API_KEY", "marfa_k1_fixture")
        .env("MARFA_NO_KEYCHAIN", "1")
        .env("MARFA_KEYCHAIN", home.join("none"))
        .env_remove("MARFA_DB")
        .env_remove("MARFA_PROFILE")
        .args(args)
        .output()
        .unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn ok(body: Value) -> Answer {
    Answer::json("200 OK", &body.to_string())
}

fn refused(status: &'static str, code: &str, message: &str) -> Answer {
    Answer::json(
        status,
        &json!({"error": {"code": code, "message": message}}).to_string(),
    )
}

fn note(id: &str) -> Value {
    json!({"id": id, "type": "core.note", "created_at": "2026-01-01T00:00:00.000Z",
           "properties": {"title": id}})
}

#[test]
fn all_reads_every_page_and_prints_them_as_one_answer() {
    let home = scratch("all");
    let door = Door::open(vec![
        ok(json!({"data": [note("a"), note("b")], "next_cursor": "p2"})),
        ok(json!({"data": [note("c")], "next_cursor": null})),
    ]);
    let ran = run(
        &home,
        &door.url,
        &["--json", "items", "list", "--all", "--limit", "2"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let joined: Value = serde_json::from_str(&ran.stdout).unwrap();
    let ids: Vec<&str> = joined["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["a", "b", "c"]);
    assert_eq!(joined["next_cursor"], Value::Null);
    let asked = door.received();
    assert!(!asked[0].path().contains("cursor"), "{}", asked[0].path());
    assert!(asked[1].path().contains("cursor=p2"), "{}", asked[1].path());
    assert!(asked[1].path().contains("limit=2"), "{}", asked[1].path());
}

#[test]
fn all_alone_reads_a_page_that_has_no_next_and_refuses_a_cursor_beside_it() {
    let home = scratch("all-one");
    let door = Door::open(vec![ok(json!({"data": [note("a")], "next_cursor": null}))]);
    let ran = run(&home, &door.url, &["items", "list", "--all"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(
        ran.stdout.starts_with("id"),
        "a header leads: {}",
        ran.stdout
    );
    assert!(!ran.stdout.contains("more:"), "{}", ran.stdout);
    assert_eq!(door.received().len(), 1);

    let ran = run(
        &home,
        "http://127.0.0.1:9",
        &["items", "list", "--all", "--cursor", "c"],
    );
    assert_ne!(ran.code, 0);
    assert!(ran.stderr.contains("--cursor"), "{}", ran.stderr);
}

#[test]
fn a_cursor_with_hyphens_and_underscores_is_taken_as_a_separate_argument() {
    let home = scratch("cursor-separate");
    let door = Door::open(vec![ok(json!({"data": [note("a")], "next_cursor": null}))]);
    let ran = run(
        &home,
        &door.url,
        &["items", "list", "--cursor", "cA-b_C-9", "--limit", "1"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let asked = door.received();
    assert!(
        asked[0].path().contains("cursor=cA-b_C-9"),
        "{}",
        asked[0].path()
    );
}

#[test]
fn all_stops_where_the_server_names_a_cursor_it_named_before() {
    let home = scratch("all-loop");
    let door = Door::open(vec![
        ok(json!({"data": [note("a")], "next_cursor": "same"})),
        ok(json!({"data": [note("b")], "next_cursor": "same"})),
    ]);
    let ran = run(&home, &door.url, &["--json", "items", "list", "--all"]);
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert!(ran.stderr.contains("named before"), "{}", ran.stderr);
    drop(door);
}

fn emptied(id: u64, next: Option<&str>) -> Answer {
    ok(json!({"purged": id, "failures": [], "next_cursor": next}))
}

#[test]
fn emptying_the_bin_pages_itself_and_counts_as_it_goes() {
    let home = scratch("empty");
    let door = Door::open(vec![
        emptied(200, Some("c1")),
        emptied(200, Some("c2")),
        emptied(37, None),
    ]);
    let ran = run(
        &home,
        &door.url,
        &["items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout.lines().collect::<Vec<_>>(),
        [
            "200 items deleted so far",
            "400 items deleted so far",
            "437 items deleted from the bin",
        ]
    );
    let asked = door.received();
    assert_eq!(asked.len(), 3);
    assert_eq!(asked[0].path(), "/trash/empty");
    assert_eq!(asked[1].path(), "/trash/empty?cursor=c1");
    assert_eq!(asked[2].path(), "/trash/empty?cursor=c2");

    // An interrupted run keeps nothing: the next one starts from the first
    // batch, with no cursor.
    let door = Door::open(vec![emptied(0, None)]);
    let ran = run(
        &home,
        &door.url,
        &["items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.stdout.trim(), "0 items deleted from the bin");
    assert_eq!(door.received()[0].path(), "/trash/empty");

    let door = Door::open(vec![emptied(5, Some("c1")), emptied(2, None)]);
    let ran = run(
        &home,
        &door.url,
        &["--json", "items", "bin", "empty", "--confirm", "PURGE"],
    );
    let said: Value = serde_json::from_str(&ran.stdout).unwrap();
    assert_eq!(said, json!({"purged": 7, "stayed": 0, "failures": []}));
}

fn kept(id: &str) -> Value {
    json!({"id": id, "code": "version_conflict", "message": "This item changed and was kept."})
}

#[test]
fn emptying_the_bin_says_how_many_items_stayed_in_it_and_still_exits_zero() {
    let home = scratch("empty-stayed");
    let batches = || {
        vec![
            ok(json!({"purged": 198, "failures": [kept("x"), kept("y")], "next_cursor": "c1"})),
            ok(json!({"purged": 1, "failures": [kept("z")], "next_cursor": null})),
        ]
    };
    let door = Door::open(batches());
    let ran = run(
        &home,
        &door.url,
        &["items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let lines: Vec<&str> = ran.stdout.lines().collect();
    assert_eq!(
        lines,
        [
            "198 items deleted so far",
            "199 items deleted from the bin",
            "x: This item changed and was kept.",
            "y: This item changed and was kept.",
            "z: This item changed and was kept.",
            "3 items stayed in the bin",
        ]
    );

    let door = Door::open(batches());
    let ran = run(
        &home,
        &door.url,
        &["--json", "items", "bin", "empty", "--confirm", "PURGE"],
    );
    let said: Value = serde_json::from_str(&ran.stdout).unwrap();
    assert_eq!(said["purged"], 199);
    assert_eq!(said["stayed"], 3);
}

#[test]
fn emptying_the_bin_stops_with_an_error_where_the_server_names_a_cursor_again() {
    let home = scratch("empty-cycle");
    // The batches name c1, c1 again; and c1, c2, then c1 again.
    let scenes: [(&str, Vec<Answer>, &str); 2] = [
        (
            "same",
            vec![emptied(200, Some("c1")), emptied(200, Some("c1"))],
            "400 items",
        ),
        (
            "round",
            vec![
                emptied(200, Some("c1")),
                emptied(200, Some("c2")),
                emptied(200, Some("c1")),
            ],
            "600 items",
        ),
    ];
    for (name, answers, count) in scenes {
        let asked = answers.len();
        let door = Door::open(answers);
        let ran = run(
            &home,
            &door.url,
            &["items", "bin", "empty", "--confirm", "PURGE"],
        );
        assert_eq!(ran.code, 1, "{name}: {}{}", ran.stdout, ran.stderr);
        assert!(ran.stderr.contains("\"c1\""), "{name}: {}", ran.stderr);
        assert!(ran.stderr.contains(count), "{name}: {}", ran.stderr);
        assert!(ran.stderr.contains("again"), "{name}: {}", ran.stderr);
        assert_eq!(door.received().len(), asked, "{name}: it asked on");
    }
}

#[test]
fn a_batch_that_fails_midway_says_how_many_were_deleted_before_it() {
    let home = scratch("empty-midway");
    let answers = || {
        vec![
            emptied(200, Some("c1")),
            emptied(200, Some("c2")),
            refused(
                "500 Internal Server Error",
                "internal_error",
                "Something broke",
            ),
        ]
    };
    let door = Door::open(answers());
    let ran = run(
        &home,
        &door.url,
        &["items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.code, 3, "{}", ran.stderr);
    assert!(
        ran.stderr.contains(
            "400 items were deleted before this failed, and the failed batch may have deleted more: "
        ),
        "{}",
        ran.stderr
    );
    assert!(ran.stderr.contains("Something broke"), "{}", ran.stderr);

    let door = Door::open(answers());
    let ran = run(
        &home,
        &door.url,
        &["--json", "items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.code, 3);
    assert_eq!(ran.stdout.trim(), "", "nothing else is on stdout");
    let last = ran.stderr.lines().last().unwrap();
    let said: Value = serde_json::from_str(last).expect(last);
    assert_eq!(said["purged"], 400, "{said}");
    assert_eq!(said["exit"], 3);
    assert_eq!(said["error"]["server"]["status"], 500);

    // Before any batch has gone, the failure is the plain one.
    let door = Door::open(vec![refused(
        "500 Internal Server Error",
        "internal_error",
        "Something broke",
    )]);
    let ran = run(
        &home,
        &door.url,
        &["--json", "items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.code, 3);
    let said: Value = serde_json::from_str(ran.stderr.lines().last().unwrap()).unwrap();
    assert!(said["purged"].is_null(), "{said}");
    assert!(
        !ran.stderr.contains("were deleted before"),
        "{}",
        ran.stderr
    );
}

#[test]
fn emptying_the_bin_stops_where_a_deletion_could_not_be_confirmed() {
    let home = scratch("empty-unknown");
    let door = Door::open(vec![ok(json!({
        "purged": 0,
        "failures": [{"id": "x", "message": "Refresh first",
                      "details": {"write_outcome": "unknown"}}],
        "next_cursor": "more",
    }))]);
    let ran = run(
        &home,
        &door.url,
        &["items", "bin", "empty", "--confirm", "PURGE"],
    );
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert!(
        ran.stdout.contains("0 items deleted from the bin"),
        "{}",
        ran.stdout
    );
    assert!(ran.stdout.contains("x: Refresh first"), "{}", ran.stdout);
    assert!(
        ran.stderr.contains("could not be confirmed"),
        "{}",
        ran.stderr
    );
    assert_eq!(
        door.received().len(),
        1,
        "it went on past the uncertain batch"
    );
}

fn recipe_type() -> Answer {
    ok(json!({"id": "user.recipe", "fields": {
        "title": {"type": "string"},
        "servings": {"type": "integer"},
        "rating": {"type": "number"},
        "vegan": {"type": "boolean"},
        "made_on": {"type": "datetime"},
        "extras": {"type": "object"},
        "steps": {"type": "array", "items_type": "string"},
    }}))
}

fn created() -> Answer {
    Answer::json(
        "201 Created",
        &json!({"item": {"id": "i1", "type": "user.recipe", "version": 1,
                         "properties": {"title": "Soup"}}})
        .to_string(),
    )
}

#[test]
fn a_prop_is_sent_as_the_kind_its_field_has() {
    let home = scratch("prop");
    let door = Door::open(vec![recipe_type(), created()]);
    let ran = run(
        &home,
        &door.url,
        &[
            "items",
            "create",
            "--type",
            "user.recipe",
            "--prop",
            "title=Soup",
            "--prop",
            "servings=2",
            "--prop",
            "rating=4.5",
            "--prop",
            "vegan=true",
            "--prop",
            "made_on=2026-11-13T10:00:00Z",
            "--prop",
            r#"extras={"salt":"a pinch"}"#,
            "--prop",
            r#"steps=["boil","serve"]"#,
            "--prop",
            "unlisted=7",
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout.trim(),
        r#"created user.recipe i1 "Soup" (version 1)"#
    );
    let asked = door.received();
    assert_eq!(asked.len(), 2, "one request reads the type, one writes");
    assert_eq!(
        (asked[0].method(), asked[0].path()),
        ("GET", "/types/user.recipe")
    );
    let sent: Value = serde_json::from_str(&asked[1].body).unwrap();
    assert_eq!(
        sent["properties"],
        json!({
            "title": "Soup",
            "servings": 2,
            "rating": 4.5,
            "vegan": true,
            "made_on": "2026-11-13T10:00:00Z",
            "extras": {"salt": "a pinch"},
            "steps": ["boil", "serve"],
            "unlisted": "7",
        })
    );
}

#[test]
fn no_prop_asks_the_server_for_no_type() {
    let home = scratch("no-prop");
    let door = Door::open(vec![created()]);
    let ran = run(
        &home,
        &door.url,
        &[
            "items",
            "create",
            "--type",
            "user.recipe",
            "--properties",
            r#"{"servings":2}"#,
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let asked = door.received();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].method(), "POST");
}

#[test]
fn a_value_that_is_not_its_fields_kind_is_refused_before_anything_is_written() {
    let home = scratch("prop-refused");
    for (prop, kind) in [
        ("servings=two", "an integer"),
        ("servings=2.5", "an integer"),
        ("rating=high", "a number"),
        ("vegan=yes", "a boolean"),
        ("extras=[1]", "an object"),
        ("steps={}", "a list"),
        ("extras={nope", "an object"),
    ] {
        let door = Door::open(vec![recipe_type()]);
        let ran = run(
            &home,
            &door.url,
            &["items", "create", "--type", "user.recipe", "--prop", prop],
        );
        assert_eq!(ran.code, 1, "{prop}: {}", ran.stderr);
        let field = prop.split('=').next().unwrap();
        assert!(
            ran.stderr.contains(&format!("the field {field} is {kind}")),
            "{prop}: {}",
            ran.stderr
        );
        assert_eq!(door.received().len(), 1, "{prop}: only the type was read");
    }
}

#[test]
fn a_type_that_cannot_be_read_leaves_the_text_and_a_refusal_names_properties() {
    let home = scratch("prop-unreadable");
    let door = Door::open(vec![
        refused("403 Forbidden", "type_not_permitted", "No."),
        refused(
            "400 Bad Request",
            "invalid_properties",
            "servings: Expected a whole number",
        ),
    ]);
    let ran = run(
        &home,
        &door.url,
        &[
            "items",
            "create",
            "--type",
            "user.recipe",
            "--prop",
            "servings=2",
        ],
    );
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert!(ran.stderr.contains("invalid_properties"), "{}", ran.stderr);
    assert!(ran.stderr.contains("--properties"), "{}", ran.stderr);
    let asked = door.received();
    let sent: Value = serde_json::from_str(&asked[1].body).unwrap();
    assert_eq!(sent["properties"], json!({"servings": "2"}));

    // Witness: a refusal of properties when the fields were read names no flag.
    let door = Door::open(vec![
        recipe_type(),
        refused("400 Bad Request", "invalid_properties", "title: too long"),
    ]);
    let ran = run(
        &home,
        &door.url,
        &[
            "items",
            "create",
            "--type",
            "user.recipe",
            "--prop",
            "title=x",
        ],
    );
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert!(!ran.stderr.contains("--properties"), "{}", ran.stderr);
}

#[test]
fn an_update_reads_the_items_type_for_its_prop() {
    let home = scratch("prop-update");
    let door = Door::open(vec![
        ok(json!({"item": {"id": "i1", "type": "user.recipe", "version": 1}})),
        recipe_type(),
        ok(
            json!({"item": {"id": "i1", "type": "user.recipe", "version": 2,
                           "properties": {"title": "Soup"}}}),
        ),
    ]);
    let ran = run(
        &home,
        &door.url,
        &[
            "items",
            "update",
            "i1",
            "--version",
            "1",
            "--prop",
            "servings=4",
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout.trim(),
        r#"updated user.recipe i1 "Soup" (version 2)"#
    );
    let asked = door.received();
    assert_eq!(asked[0].method(), "GET");
    assert!(
        asked[0].path().starts_with("/items/i1"),
        "{}",
        asked[0].path()
    );
    assert_eq!(asked[1].path(), "/types/user.recipe");
    let sent: Value = serde_json::from_str(&asked[2].body).unwrap();
    assert_eq!(sent["properties"], json!({"servings": 4}));
}

#[test]
fn an_edge_names_its_two_ends_by_from_and_to() {
    let home = scratch("edge-flags");
    let door = Door::open(vec![Answer::json(
        "201 Created",
        &json!({"edge": {"id": "e1", "edge_type": "about", "source_id": "a", "target_id": "b",
                         "version": 1}})
        .to_string(),
    )]);
    let ran = run(
        &home,
        &door.url,
        &[
            "edges", "create", "--from", "a", "--to", "b", "--type", "about",
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    let sent: Value = serde_json::from_str(&door.received()[0].body).unwrap();
    assert_eq!(sent["source_id"], "a");
    assert_eq!(sent["target_id"], "b");

    // The old names are gone, and `--source` is the writer's alone.
    for words in [
        [
            "edges", "create", "--source", "a", "--to", "b", "--type", "about",
        ],
        [
            "edges", "create", "--from", "a", "--target", "b", "--type", "about",
        ],
    ] {
        let ran = run(&home, "http://127.0.0.1:9", &words);
        assert_eq!(ran.code, 2, "{words:?}: {}", ran.stderr);
        assert!(
            ran.stderr.contains("unexpected argument"),
            "{words:?}: {}",
            ran.stderr
        );
    }
    let ran = run(&home, "http://127.0.0.1:9", &["edges", "update", "--help"]);
    assert!(
        ran.stdout.contains("--from") && ran.stdout.contains("--to"),
        "{}",
        ran.stdout
    );
    assert!(!ran.stdout.contains("--source"), "{}", ran.stdout);
}

#[test]
fn a_connector_reports_and_beats_without_naming_itself() {
    let home = scratch("connector");
    let door = Door::open(vec![
        ok(json!({"last_heartbeat_at": "2026-11-13T10:00:00.000Z"})),
        Answer::json(
            "201 Created",
            &json!({"id": "r1", "connector_id": "c1", "outcome": "failed"}).to_string(),
        ),
    ]);
    let ran = run(&home, &door.url, &["connectors", "heartbeat"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout.trim(),
        "heartbeat recorded at 2026-11-13T10:00:00.000Z"
    );
    let ran = run(
        &home,
        &door.url,
        &[
            "connectors",
            "report",
            "--outcome",
            "failed",
            "--started-at",
            "2026-11-13T10:00:00Z",
            "--finished-at",
            "2026-11-13T10:00:01Z",
        ],
    );
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(ran.stdout.trim(), "reported a failed run as r1");
    let asked = door.received();
    assert_eq!(
        (asked[0].method(), asked[0].path()),
        ("POST", "/connectors/heartbeat")
    );
    assert_eq!(
        (asked[1].method(), asked[1].path()),
        ("POST", "/connectors/runs")
    );

    // Naming an id is no longer a thing to do.
    let ran = run(
        &home,
        "http://127.0.0.1:9",
        &["connectors", "heartbeat", "c1"],
    );
    assert_eq!(ran.code, 2, "{}", ran.stderr);
}

#[test]
fn a_list_has_a_header_and_a_status_with_no_items_says_so() {
    let home = scratch("plain");
    let door = Door::open(vec![ok(json!({
        "data": [{"tag": "work", "count": 3}, {"tag": "home", "count": 12}],
        "next_cursor": null,
    }))]);
    let ran = run(&home, &door.url, &["metadata", "tags"]);
    assert_eq!(ran.stdout, "tag   items\nwork  3\nhome  12\n");

    let door = Door::open_at(|_| {
        vec![
            ok(
                json!({"name": "Marfa", "version": "0.0.0", "instance_id": "i1",
                      "contract": marfa_core::contract::CONTRACT_VERSION, "features": []}),
            ),
            ok(json!({"status": "ok"})),
            ok(json!({})),
        ]
    });
    let ran = run(&home, &door.url, &["status"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert!(
        ran.stdout.lines().any(|line| line == "no items"),
        "{}",
        ran.stdout
    );
    assert!(!ran.stdout.contains("{}"), "{}", ran.stdout);
}

#[test]
fn a_backup_run_and_an_adopted_folder_each_say_what_happened_in_a_sentence() {
    let home = scratch("backups");
    let taken = json!({
        "outcome": "put",
        "backup": {"name": "20261113T100000.000Z.tar", "instance_id": "i1",
                   "created_at": "2026-11-13T10:00:00.000Z", "size_bytes": 10},
        "removed": 1,
        "unremoved": 0,
        "blobs_lost": ["sha256-aa", "sha256-bb"],
        "blobs_waiting": 3,
    });
    let adopted = json!({
        "store_id": "s2",
        "replaced_store_id": "s1",
        "backups_forgotten": 1,
        "copies_forgotten": 3,
    });
    let door = Door::open(vec![
        ok(taken.clone()),
        ok(adopted.clone()),
        ok(adopted.clone()),
    ]);

    let ran = run(&home, &door.url, &["backups", "run"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout,
        "took backup 20261113T100000.000Z.tar; deleted 1 old backup\n\
         2 files lost, which the backup names and no store could give: sha256-aa, sha256-bb\n\
         the backup is incomplete: 3 files it names wait for their copy. A restore needs those \
         files unless the restoring instance holds them or the backup lists them as lost\n"
    );

    let ran = run(&home, &door.url, &["backups", "folder", "adopt"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(
        ran.stdout,
        "adopted the backup folder as store s2, replacing s1; forgot 1 backup and 3 file copies\n"
    );

    let ran = run(&home, &door.url, &["--json", "backups", "folder", "adopt"]);
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(serde_json::from_str::<Value>(&ran.stdout).unwrap(), adopted);
}
