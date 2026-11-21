//! `marfa types check` as a process: it judges a folder of type definitions as
//! a server judges a registration, and reaches for no server, key or keychain.

#[allow(dead_code)]
#[path = "../src/door.rs"]
mod door;

#[allow(dead_code)]
#[path = "support/quiet.rs"]
mod quiet;

use std::net::TcpListener;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tempfile::TempDir;

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

/// The binary with no server, key or working copy named, and a keychain that
/// does not exist, so anything that reached for a credential would fail.
fn marfa(args: &[&str], env: &[(&str, &str)]) -> Ran {
    let nowhere = std::env::temp_dir().join(format!(
        "marfa-types-check-no-keychain-{}",
        std::process::id()
    ));
    let mut command = quiet::marfa();
    command
        .env_remove("MARFA_API_URL")
        .env_remove("MARFA_API_KEY")
        .env_remove("MARFA_DB")
        .env("MARFA_KEYCHAIN", nowhere)
        .args(args);
    for (name, value) in env {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    Ran {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn check(folder: &Path) -> Ran {
    marfa(&["types", "check", folder.to_str().unwrap()], &[])
}

fn check_json(folder: &Path) -> (Ran, Value) {
    let ran = marfa(&["--json", "types", "check", folder.to_str().unwrap()], &[]);
    let verdict = serde_json::from_str(&ran.stdout)
        .unwrap_or_else(|error| panic!("stdout is not JSON: {error}\n{}", ran.stdout));
    (ran, verdict)
}

fn folder_of(files: &[(&str, Value)]) -> TempDir {
    let folder = TempDir::new().unwrap();
    for (name, body) in files {
        std::fs::write(folder.path().join(name), body.to_string()).unwrap();
    }
    folder
}

fn problems(verdict: &Value, file: &str) -> Vec<Value> {
    verdict["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["file"] == file)
        .unwrap_or_else(|| panic!("no entry for {file} in {verdict}"))["problems"]
        .as_array()
        .unwrap()
        .clone()
}

fn sprint_task() -> Value {
    json!({
        "id": "user.sprint-task",
        "parent": "core.task",
        "fields": { "sprint": { "type": "integer" } }
    })
}

fn bug() -> Value {
    json!({
        "id": "user.bug",
        "parent": "user.sprint-task",
        "fields": { "severity": { "type": "string" } }
    })
}

fn valid_folder() -> TempDir {
    folder_of(&[
        ("user.sprint-task.json", sprint_task()),
        ("user.bug.json", bug()),
    ])
}

#[test]
fn a_valid_folder_passes_with_a_parent_from_the_catalogue_and_a_child_of_it() {
    let folder = valid_folder();
    let ran = check(folder.path());
    assert_eq!(ran.code, 0, "{}{}", ran.stdout, ran.stderr);
    assert!(ran.stdout.contains("user.bug.json"), "{}", ran.stdout);
    assert!(
        ran.stdout.contains("user.sprint-task.json"),
        "{}",
        ran.stdout
    );
    assert!(ran.stdout.contains("2 files"), "{}", ran.stdout);
    assert_eq!(ran.stderr, "");

    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 0, "{}", ran.stderr);
    assert_eq!(verdict["ok"], true);
    assert_eq!(verdict["checked"], 2);
    assert_eq!(verdict["refused"], 0);
    assert_eq!(problems(&verdict, "user.bug.json"), Vec::<Value>::new());
}

/// Each refusal: the broken folder exits 1 naming the file, the path and the
/// server's code, and the same folder with the valid version exits 0.
fn refused(valid: Value, broken: Value, file: &str, path: &str, code: &str, said: &str) {
    let witness = folder_of(&[(file, valid)]);
    let passed = check(witness.path());
    assert_eq!(
        passed.code, 0,
        "witness: {}{}",
        passed.stdout, passed.stderr
    );

    let folder = folder_of(&[(file, broken)]);
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1, "{}", ran.stderr);
    assert_eq!(verdict["ok"], false);
    assert_eq!(verdict["refused"], 1);
    let found = problems(&verdict, file);
    assert!(
        found.iter().any(|problem| problem["path"] == path
            && problem["code"] == code
            && problem["message"].as_str().unwrap().contains(said)),
        "no {code} at {path} saying {said}: {found:?}"
    );
    let envelope: Value = serde_json::from_str(ran.stderr.trim()).unwrap();
    assert_eq!(envelope["error"]["code"], "invalid");
    assert_eq!(envelope["exit"], 1);

    let plain = check(folder.path());
    assert_eq!(plain.code, 1);
    assert!(plain.stdout.contains(file), "{}", plain.stdout);
    assert!(plain.stdout.contains(path), "{}", plain.stdout);
    assert!(plain.stdout.contains(said), "{}", plain.stdout);
}

#[test]
fn a_redefined_inherited_field_is_refused() {
    let task = |kind: &str| json!({ "id": "user.t", "parent": "core.task", "fields": { "title": { "type": kind, "required": true } } });
    refused(
        task("string"),
        task("integer"),
        "user.t.json",
        "fields.title.type",
        "inheritance_violation",
        "inherited from \"core.task\"",
    );
}

#[test]
fn a_bad_status_group_is_refused() {
    let status = |group: &str| {
        json!({ "id": "user.s", "fields": { "stage": { "type": "status", "status_values": [
            { "value": "open", "group": group }
        ] } } })
    };
    refused(
        status("not_started"),
        status("underway"),
        "user.s.json",
        "fields.stage.status_values.0.group",
        "invalid_schema",
        "underway",
    );
}

#[test]
fn two_thumbnail_fields_are_refused() {
    let fields = |second: &str| json!({ "id": "user.p", "fields": { "cover": { "type": "thumbnail" }, "banner": { "type": second } } });
    refused(
        fields("string"),
        fields("thumbnail"),
        "user.p.json",
        "fields.banner",
        "invalid_schema",
        "at most one thumbnail",
    );
}

#[test]
fn a_loosened_minimum_is_refused() {
    let floor =
        json!({ "id": "user.floor", "fields": { "count": { "type": "integer", "minimum": 5 } } });
    let lower = |minimum: i64| {
        json!({ "id": "user.lower", "parent": "user.floor",
                "fields": { "count": { "type": "integer", "minimum": minimum } } })
    };
    let witness = folder_of(&[
        ("user.floor.json", floor.clone()),
        ("user.lower.json", lower(7)),
    ]);
    assert_eq!(check(witness.path()).code, 0);
    let folder = folder_of(&[("user.floor.json", floor), ("user.lower.json", lower(1))]);
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    let found = problems(&verdict, "user.lower.json");
    assert!(
        found
            .iter()
            .any(|problem| problem["path"] == "fields.count.minimum"
                && problem["code"] == "inheritance_violation"),
        "{found:?}"
    );
    assert_eq!(problems(&verdict, "user.floor.json"), Vec::<Value>::new());
}

#[test]
fn an_unknown_field_type_is_refused() {
    let kind = |kind: &str| json!({ "id": "user.k", "fields": { "x": { "type": kind } } });
    refused(
        kind("string"),
        kind("colour"),
        "user.k.json",
        "fields.x.type",
        "invalid_schema",
        "colour",
    );
}

#[test]
fn an_enum_with_no_values_is_refused() {
    let field = |field: Value| json!({ "id": "user.e", "fields": { "x": field } });
    refused(
        field(json!({ "type": "enum", "enum_values": ["a"] })),
        field(json!({ "type": "enum" })),
        "user.e.json",
        "fields.x.enum_values",
        "invalid_schema",
        "enum_values",
    );
}

#[test]
fn an_unknown_key_is_refused() {
    let body = |extra: (&str, Value)| {
        let mut body = json!({ "id": "user.u", "fields": { "x": { "type": "string" } } });
        body[extra.0] = extra.1;
        body
    };
    refused(
        body(("description", json!("What it is"))),
        body(("colour", json!("red"))),
        "user.u.json",
        "colour",
        "invalid_schema",
        "colour",
    );
}

#[test]
fn a_reserved_root_is_refused() {
    let body = |id: &str| json!({ "id": id, "fields": { "x": { "type": "string" } } });
    let witness = folder_of(&[("user.x.json", body("user.x"))]);
    assert_eq!(check(witness.path()).code, 0);
    for (id, code, said) in [
        ("core.x", "forbidden", "Reserved namespace: core.*"),
        ("audit.x", "validation_error", "Invalid type identifier"),
    ] {
        let file = format!("{id}.json");
        let folder = folder_of(&[(file.as_str(), body(id))]);
        let (ran, verdict) = check_json(folder.path());
        assert_eq!(ran.code, 1, "{id}");
        let found = problems(&verdict, &file);
        assert_eq!(found.len(), 1, "{id}: {found:?}");
        assert_eq!(found[0]["code"], code);
        assert_eq!(found[0]["path"], "id");
        assert!(
            found[0]["message"].as_str().unwrap().contains(said),
            "{found:?}"
        );
    }
}

fn context(verdict: &Value, file: &str) -> String {
    verdict["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["file"] == file)
        .unwrap_or_else(|| panic!("no entry for {file} in {verdict}"))["context"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

fn child(id: &str, parent: &str) -> Value {
    json!({ "id": id, "parent": parent, "fields": { "x": { "type": "string" } } })
}

fn holder(id: &str, target: &str) -> Value {
    json!({ "id": id, "fields": { "x": { "type": "string" } }, "tables": { "rows": { "columns": {
        "who": { "type": "item", "type_constraints": [target] }
    } } } })
}

#[test]
fn a_missing_parent_gets_the_servers_answer_and_the_folder_says_why() {
    let body = |parent: &str| child("user.o", parent);
    refused(
        body("core.note"),
        body("user.gone"),
        "user.o.json",
        "parent",
        "validation_error",
        "Parent type \"user.gone\" not found",
    );
    let folder = folder_of(&[("user.o.json", body("user.gone"))]);
    let (_, verdict) = check_json(folder.path());
    assert_eq!(problems(&verdict, "user.o.json").len(), 1);
    assert_eq!(
        context(&verdict, "user.o.json"),
        "The parent \"user.gone\" is not shipped or in this folder."
    );
    let plain = check(folder.path());
    assert!(
        plain.stdout.contains("not shipped or in this folder"),
        "{}",
        plain.stdout
    );
}

#[test]
fn a_missing_parent_does_not_hide_the_fault_the_server_names() {
    let enum_without_values = |parent: &str| json!({ "id": "user.o", "parent": parent, "fields": { "x": { "type": "enum" } } });
    let folder = folder_of(&[("user.o.json", enum_without_values("user.gone"))]);
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    let found = problems(&verdict, "user.o.json");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["code"], "invalid_schema");
    assert_eq!(found[0]["path"], "fields.x.enum_values");
    assert!(context(&verdict, "user.o.json").contains("user.gone"));
}

#[test]
fn a_parent_cycle_gives_each_type_in_it_the_answer_of_an_absent_parent() {
    let witness = folder_of(&[
        ("user.a.json", child("user.a", "core.note")),
        ("user.b.json", child("user.b", "user.a")),
    ]);
    assert_eq!(check(witness.path()).code, 0);
    let folder = folder_of(&[
        ("user.a.json", child("user.a", "user.b")),
        ("user.b.json", child("user.b", "user.a")),
        ("user.c.json", child("user.c", "user.a")),
    ]);
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    for (file, parent) in [
        ("user.a.json", "user.b"),
        ("user.b.json", "user.a"),
        ("user.c.json", "user.a"),
    ] {
        let found = problems(&verdict, file);
        assert_eq!(found.len(), 1, "{file}: {found:?}");
        assert_eq!(found[0]["code"], "validation_error");
        assert_eq!(
            found[0]["message"],
            format!("Parent type \"{parent}\" not found")
        );
    }
    assert!(context(&verdict, "user.a.json").contains("loop"));
    assert!(context(&verdict, "user.b.json").contains("loop"));
    let below = context(&verdict, "user.c.json");
    assert!(below.contains("was refused in this folder"), "{below}");
    assert!(!below.contains("loop"), "{below}");
}

#[test]
fn a_type_naming_itself_as_its_parent_gets_the_servers_answer_and_keeps_its_folder_checks() {
    let folder = folder_of(&[
        ("user.self.json", child("user.self", "user.self")),
        (
            "core.unshipped.json",
            child("core.unshipped", "core.unshipped"),
        ),
        ("Wrong.json", child("user.other", "user.other")),
    ]);
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    let own = problems(&verdict, "user.self.json");
    assert_eq!(own.len(), 1, "{own:?}");
    assert_eq!(own[0]["message"], "Circular inheritance detected");
    let reserved = problems(&verdict, "core.unshipped.json");
    assert_eq!(reserved.len(), 1, "{reserved:?}");
    assert_eq!(reserved[0]["code"], "forbidden");
    let misnamed = problems(&verdict, "Wrong.json");
    assert_eq!(misnamed.len(), 2, "{misnamed:?}");
    assert_eq!(misnamed[0]["code"], "file_name_mismatch");
    assert_eq!(misnamed[1]["message"], "Circular inheritance detected");
}

#[test]
fn a_table_column_is_judged_after_the_type_it_names_and_refused_where_it_is_absent() {
    let witness = folder_of(&[
        (
            "user.a-holder.json",
            holder("user.a-holder", "user.z-person"),
        ),
        ("user.z-person.json", child("user.z-person", "core.note")),
    ]);
    let passed = check(witness.path());
    assert_eq!(passed.code, 0, "{}{}", passed.stdout, passed.stderr);
    let folder = folder_of(&[
        (
            "user.a-holder.json",
            holder("user.a-holder", "user.nowhere"),
        ),
        ("user.col-a.json", holder("user.col-a", "user.col-b")),
        ("user.col-b.json", holder("user.col-b", "user.col-a")),
    ]);
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    for file in ["user.a-holder.json", "user.col-a.json", "user.col-b.json"] {
        let found = problems(&verdict, file);
        assert_eq!(found.len(), 1, "{file}: {found:?}");
        assert_eq!(found[0]["code"], "invalid_schema");
        assert_eq!(found[0]["path"], "tables.rows.columns.who.type_constraints");
    }
    assert!(context(&verdict, "user.col-a.json").contains("loop"));
}

#[test]
fn a_file_name_that_differs_from_the_id_is_refused_even_by_case() {
    let body = json!({ "id": "user.recipe", "fields": { "x": { "type": "string" } } });
    let witness = folder_of(&[("user.recipe.json", body.clone())]);
    assert_eq!(check(witness.path()).code, 0);
    for name in ["recipe.json", "User.recipe.json", "user.recipe.JSON"] {
        let folder = folder_of(&[(name, body.clone())]);
        let (ran, verdict) = check_json(folder.path());
        assert_eq!(ran.code, 1, "{name}");
        let found = problems(&verdict, name);
        assert!(
            found
                .iter()
                .any(|problem| problem["code"] == "file_name_mismatch"),
            "{name}: {found:?}"
        );
    }
}

#[test]
fn a_missing_folder_and_a_file_in_its_place_are_refused() {
    let folder = TempDir::new().unwrap();
    let missing = folder.path().join("nothing-here");
    let ran = check(&missing);
    assert_eq!(ran.code, 2, "{}", ran.stderr);
    assert!(ran.stderr.contains("nothing-here"), "{}", ran.stderr);
    assert_eq!(ran.stdout, "");

    let file = folder.path().join("user.x.json");
    std::fs::write(&file, "{}").unwrap();
    let ran = check(&file);
    assert_eq!(ran.code, 2, "{}", ran.stderr);
    assert!(ran.stderr.contains("not a folder"), "{}", ran.stderr);
}

#[test]
fn a_folder_with_no_json_files_is_refused_saying_none_were_found() {
    let empty = TempDir::new().unwrap();
    let ran = check(empty.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert!(
        ran.stderr.contains("no *.json files found"),
        "{}",
        ran.stderr
    );

    std::fs::write(empty.path().join("README.md"), "text").unwrap();
    std::fs::create_dir(empty.path().join("nested.json")).unwrap();
    std::fs::create_dir(empty.path().join("sub")).unwrap();
    std::fs::write(empty.path().join("sub").join("user.x.json"), "{}").unwrap();
    let ran = check(empty.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert!(
        ran.stderr.contains("no *.json files found"),
        "{}",
        ran.stderr
    );

    let ran = marfa(
        &["--json", "types", "check", empty.path().to_str().unwrap()],
        &[],
    );
    assert_eq!(ran.code, 1);
    let envelope: Value = serde_json::from_str(ran.stderr.trim()).unwrap();
    assert_eq!(envelope["error"]["code"], "invalid");
}

#[test]
fn a_bad_file_never_stops_the_others_being_checked() {
    let folder = valid_folder();
    let path = folder.path();
    std::fs::write(path.join("user.broken.json"), "{ \"id\": ").unwrap();
    std::fs::write(path.join("user.list.json"), "[]").unwrap();
    std::fs::write(path.join("user.latin.json"), [b'{', 0xE9, b'}']).unwrap();
    let mut marked = vec![0xEF, 0xBB, 0xBF];
    marked.extend_from_slice(
        json!({ "id": "user.marked", "fields": { "x": { "type": "string" } } })
            .to_string()
            .as_bytes(),
    );
    std::fs::write(path.join("user.marked.json"), marked).unwrap();
    let (ran, verdict) = check_json(path);
    assert_eq!(ran.code, 1);
    assert_eq!(verdict["checked"], 6);
    assert_eq!(verdict["refused"], 4);
    assert_eq!(problems(&verdict, "user.bug.json"), Vec::<Value>::new());
    assert_eq!(
        problems(&verdict, "user.sprint-task.json"),
        Vec::<Value>::new()
    );
    let broken = problems(&verdict, "user.broken.json");
    assert!(
        broken[0]["message"]
            .as_str()
            .unwrap()
            .contains("line 1 column"),
        "{broken:?}"
    );
    assert_eq!(
        problems(&verdict, "user.list.json")[0]["message"],
        "The body must be a JSON object."
    );
    assert!(
        problems(&verdict, "user.latin.json")[0]["hint"]
            .as_str()
            .unwrap()
            .contains("UTF-8")
    );
    assert!(
        problems(&verdict, "user.marked.json")[0]["hint"]
            .as_str()
            .unwrap()
            .contains("byte-order mark")
    );
}

#[cfg(unix)]
#[test]
fn an_unreadable_file_is_reported_and_the_others_are_still_checked() {
    use std::os::unix::fs::PermissionsExt;

    let folder = valid_folder();
    let locked = folder.path().join("user.locked.json");
    std::fs::write(&locked, locked_text()).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    struct Unlock<'a>(&'a Path);
    impl Drop for Unlock<'_> {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(self.0, std::fs::Permissions::from_mode(0o600));
        }
    }
    let _unlock = Unlock(&locked);
    if std::fs::read(&locked).is_ok() {
        // Running as a user the mode does not bind: nothing is unreadable here.
        return;
    }
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    let found = problems(&verdict, "user.locked.json");
    assert_eq!(found[0]["code"], "file_unreadable", "{found:?}");
    assert_eq!(problems(&verdict, "user.bug.json"), Vec::<Value>::new());
}

fn locked_text() -> String {
    json!({ "id": "user.locked", "fields": { "x": { "type": "string" } } }).to_string()
}

#[test]
fn it_needs_no_server_key_or_keychain_and_sends_nothing() {
    let asked = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let kept = Arc::clone(&asked);
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = Arc::clone(&lines);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            kept.fetch_add(1, Ordering::SeqCst);
            seen.lock()
                .unwrap()
                .push(door::read_request(&mut stream).line);
        }
    });
    let folder = valid_folder();
    let path = folder.path().to_str().unwrap();
    let env = [
        ("MARFA_API_URL", url.as_str()),
        ("MARFA_API_KEY", "marfa_k1_x"),
    ];

    // Witness: a command that sends reaches the listener.
    let sent = marfa(&["--json", "types", "list"], &env);
    assert_ne!(sent.code, 99);
    assert_eq!(
        asked.load(Ordering::SeqCst),
        1,
        "{:?}",
        lines.lock().unwrap()
    );

    let ran = marfa(&["types", "check", path], &env);
    assert_eq!(ran.code, 0, "{}{}", ran.stdout, ran.stderr);
    let refused = marfa(&["types", "check", "/marfa-no-such-folder"], &env);
    assert_ne!(refused.code, 0);
    assert_eq!(asked.load(Ordering::SeqCst), 1);

    let unnamed = marfa(&["types", "check", path], &[]);
    assert_eq!(unnamed.code, 0, "{}{}", unnamed.stdout, unnamed.stderr);
}

#[test]
fn it_refuses_the_options_that_name_a_server() {
    let folder = valid_folder();
    let path = folder.path().to_str().unwrap();
    for options in [
        vec!["--url", "http://127.0.0.1:1"],
        vec!["--key", "marfa_k1_x"],
        vec!["--profile", "work"],
        vec!["--socket", "/marfa-no-socket"],
    ] {
        let mut args = options.clone();
        args.extend(["types", "check", path]);
        let ran = marfa(&args, &[]);
        assert_eq!(ran.code, 2, "{options:?}: {}", ran.stderr);
        assert_eq!(ran.stdout, "");
    }
}

#[test]
fn the_markdown_file_beside_a_definition_is_judged_as_its_guidance() {
    let note = json!({ "id": "user.note", "fields": { "a": { "type": "string" } } });
    let folder = folder_of(&[("user.note.json", note)]);
    std::fs::write(
        folder.path().join("user.note.md"),
        format!("{}\n", "a".repeat(1000)),
    )
    .unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 0, "{}{}", ran.stdout, ran.stderr);
    assert_eq!(verdict["checked"], 1);

    std::fs::write(folder.path().join("user.note.md"), "a".repeat(1001)).unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    let found = problems(&verdict, "user.note.json");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["path"], "guidance");
    assert_eq!(found[0]["code"], "invalid_schema");

    std::fs::write(folder.path().join("user.note.md"), "Use it.").unwrap();
    std::fs::write(folder.path().join("user.other.md"), "Use it.").unwrap();
    std::fs::write(folder.path().join("README.md"), "About.").unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert_eq!(
        problems(&verdict, "user.other.md")[0]["code"],
        "guidance_file_without_definition"
    );
    assert_eq!(verdict["checked"], 2);
}

fn note_folder() -> TempDir {
    folder_of(&[(
        "user.note.json",
        json!({ "id": "user.note", "fields": { "a": { "type": "string" } } }),
    )])
}

#[test]
fn a_markdown_name_that_differs_by_case_is_neither_guidance_nor_an_orphan() {
    let folder = note_folder();
    std::fs::write(folder.path().join("user.note.MD"), "a".repeat(1001)).unwrap();
    std::fs::write(folder.path().join("user.other.MD"), "Use it.").unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 0, "{}{}", ran.stdout, ran.stderr);
    assert_eq!(verdict["checked"], 1);
}

#[cfg(unix)]
#[test]
fn a_markdown_link_is_followed_and_a_dangling_one_or_a_folder_is_unreadable() {
    let folder = note_folder();
    let elsewhere = TempDir::new().unwrap();
    std::fs::write(elsewhere.path().join("text.md"), "a".repeat(1001)).unwrap();
    let link = folder.path().join("user.note.md");
    std::os::unix::fs::symlink(elsewhere.path().join("text.md"), &link).unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert_eq!(problems(&verdict, "user.note.json")[0]["path"], "guidance");
    assert_eq!(
        problems(&verdict, "user.note.json")[0]["code"],
        "invalid_schema"
    );

    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(elsewhere.path().join("missing.md"), &link).unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert_eq!(
        problems(&verdict, "user.note.json")[0]["code"],
        "guidance_file_unreadable"
    );

    std::fs::remove_file(&link).unwrap();
    std::fs::create_dir(&link).unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1, "{}", ran.stdout);
    assert_eq!(
        problems(&verdict, "user.note.json")[0]["code"],
        "guidance_file_unreadable"
    );
}

#[test]
fn a_folder_of_only_orphan_markdown_files_says_so_and_that_no_definitions_were_found() {
    let folder = TempDir::new().unwrap();
    std::fs::write(folder.path().join("user.note.md"), "Use it.").unwrap();
    let (ran, verdict) = check_json(folder.path());
    assert_eq!(ran.code, 1);
    assert_eq!(
        problems(&verdict, "user.note.md")[0]["code"],
        "guidance_file_without_definition"
    );
    assert!(
        ran.stderr.contains("no *.json files found"),
        "{}",
        ran.stderr
    );
}
