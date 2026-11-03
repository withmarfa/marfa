//! A watch over a quiet folder rests between its full passes, whatever
//! stands in the folder, and a file held for a link line its item never took
//! goes to the bin, once the person deletes it, as any other file does.

use super::held_links_tests::{Answer, held, nothing_found, online_folder};
use super::tests::{
    ScannedDir, changed_elsewhere, deletes_queued, folder_with, kept, landed, past_the_grace,
    settle, watched_notes, watched_notes_in,
};
use super::*;
use crate::scripted::{Scripted, certified};

/// Two default full-pass intervals of a watch's ticks.
const TWO_INTERVALS: usize = 1200;

/// One default full-pass interval of a watch's ticks.
const ONE_INTERVAL: usize = 600;

/// Whether `pulls` is at most the one full pull an interval allows over two
/// intervals.
fn once_an_interval(pulls: usize) -> bool {
    pulls <= 2
}

/// Ticks two quiet intervals, answering the pulls they ran.
fn two_quiet_intervals(passes: &mut watch::Passes, folder: &Folder) -> usize {
    passes.pulls();
    for _ in 0..TWO_INTERVALS {
        passes.tick(folder).unwrap();
    }
    passes.pulls()
}

/// Ticks until `woken` holds, for at most an interval, answering whether it did.
fn wakes_within_an_interval(
    passes: &mut watch::Passes,
    folder: &Folder,
    woken: impl Fn() -> bool,
) -> bool {
    (0..ONE_INTERVAL).any(|_| {
        passes.tick(folder).unwrap();
        woken()
    })
}

/// The folder at `path` opened again over a server that answers nothing it
/// is not scripted to, as a watch holds it.
fn served(path: &Path, folder: Folder) -> (Folder, Scripted) {
    drop(folder);
    let server = Scripted::start();
    let folder = Folder::open(
        path,
        Some(crate::Server {
            url: server.url(),
            key: "fixture".into(),
        }),
    )
    .unwrap();
    (folder, server)
}

/// Answers every write the folder queued, as a server that took them would.
fn answered(folder: &Folder) {
    folder
        .core
        .conn()
        .unwrap()
        .execute("DELETE FROM queue", [])
        .unwrap();
}

/// Gives the note at `path` the frontmatter line `line`.
fn with_line(path: &Path, line: &str) {
    let text = std::fs::read_to_string(path).unwrap();
    let lined = match text.strip_prefix("---\n") {
        Some(rest) => format!("---\n{line}\n{rest}"),
        None => format!("---\n{line}\n---\n{text}"),
    };
    std::fs::write(path, lined).unwrap();
}

/// A watched folder with the note `A.md`, which the folder wrote and the
/// person then gave a parent no item is named for. The file is held, and its
/// item has every line the folder recorded except that one. Answers the
/// folder's directory, the folder, its server, the watch's passes and the
/// note's item.
pub(super) fn held_note() -> (ScannedDir, Folder, Scripted, watch::Passes, String) {
    let (dir, folder, server) = online_folder(nothing_found());
    std::fs::write(dir.path().join("A.md"), "A\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    let id = landed(&folder, "A.md");
    answered(&folder);
    let mut passes = watch::Passes::default();
    passes.run(&folder, true).unwrap();
    settle(&folder, &mut passes);

    with_line(&dir.path().join("A.md"), r#"child-of: "[[B]]""#);
    passes.run(&folder, false).unwrap();
    answered(&folder);
    assert!(
        held(&folder, "A.md").is_some_and(|held| held.contains("matches no item")),
        "the witness: the file is held, {:?}",
        held(&folder, "A.md")
    );
    (dir, folder, server, passes, id)
}

/// A folder with the notes `A.md` and `B.md`, where `A.md` was given
/// the line `took`, naming `B`, which its item took. The person then made
/// it `line`, which holds the file for `reason` while names are looked up
/// with `lookup`, and deleted it. `seed` runs first, over the empty folder.
/// Answers the folder's directory, the folder, its server and the item of
/// `A.md`.
fn deleted_after(
    took: &str,
    line: &str,
    (lookup, reason): (Answer, &str),
    seed: impl FnOnce(&ScannedDir, &Folder),
) -> (ScannedDir, Folder, Scripted, String) {
    let (dir, folder, server) = online_folder(nothing_found());
    seed(&dir, &folder);
    for name in ["A", "B"] {
        std::fs::write(dir.path().join(format!("{name}.md")), format!("{name}\n")).unwrap();
    }
    folder.scan().unwrap();
    let id = landed(&folder, "A.md");
    landed(&folder, "B.md");
    answered(&folder);
    folder.pull().unwrap();
    folder.scan().unwrap();

    let path = dir.path().join("A.md");
    with_line(&path, took);
    folder.scan().unwrap();
    answered(&folder);
    assert_eq!(held(&folder, "A.md"), None, "the witness: {took} was taken");
    assert!(
        bound(&folder, "A.md").is_some_and(|bound| !bound.lines.is_empty()),
        "the witness: the folder recorded the line's edge"
    );
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains(took), "{text}");
    std::fs::write(&path, text.replace(took, line)).unwrap();
    server.on("/items/titles", vec![lookup]);
    folder.scan().unwrap();
    answered(&folder);
    assert!(
        held(&folder, "A.md").is_some_and(|held| held.contains(reason)),
        "the witness: the file is held for {reason}, {:?}",
        held(&folder, "A.md")
    );
    deleted(&dir, &folder);
    (dir, folder, server, id)
}

/// Deletes `A.md` and runs a scan that finds it missing.
fn deleted(dir: &ScannedDir, folder: &Folder) {
    std::fs::remove_file(dir.path().join("A.md")).unwrap();
    let scanned = folder.scan().unwrap();
    assert_eq!(scanned.missing, 1, "{scanned:?}");
}

fn bound(folder: &Folder, path: &str) -> Option<state::Bound> {
    state::bound_at(&folder.core.conn().unwrap(), path).unwrap()
}

/// That the deleted `A.md` stays deleted through a pull inside the grace,
/// and the sweep once it has run out trashes its item.
fn goes_to_the_bin(dir: &ScannedDir, folder: &Folder) {
    let pulled = folder.pull().unwrap();
    assert!(!dir.path().join("A.md").exists(), "{pulled:?}");
    assert_eq!(pulled.revived, 0, "{pulled:?}");

    past_the_grace(folder, "A.md");
    let swept = folder.scan().unwrap();
    assert_eq!(
        swept.trashed,
        ["A.md"],
        "the person's delete was held as a change made elsewhere: {swept:?}"
    );
    assert_eq!(deletes_queued(folder).len(), 1);
    assert!(bound(folder, "A.md").is_none());
    assert!(
        state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
    let pulled = folder.pull().unwrap();
    assert!(!dir.path().join("A.md").exists(), "{pulled:?}");
}

/// That the sweep sends no delete for the deleted `A.md` once its grace has
/// run out, and the pull writes it back as its item renders. Answers the
/// file.
fn comes_back(dir: &ScannedDir, folder: &Folder, id: &str) -> String {
    past_the_grace(folder, "A.md");
    let swept = folder.scan().unwrap();
    assert!(swept.trashed.is_empty(), "{swept:?}");
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.revived, 1, "{pulled:?}");
    assert!(deletes_queued(folder).is_empty());
    assert_eq!(
        bound(folder, "A.md").map(|bound| bound.item_id),
        Some(id.to_string())
    );
    std::fs::read_to_string(dir.path().join("A.md")).unwrap()
}

/// The ticks, of `count`, on which a quiet watch ran a pass: with nothing
/// standing, only a full pass runs.
fn ticks_of_full_passes(passes: &mut watch::Passes, folder: &Folder, count: usize) -> Vec<usize> {
    (1..=count)
        .filter(|_| passes.tick(folder).unwrap())
        .collect()
}

/// Sets the interval in the folder's row on the copy; `null` removes it.
fn set_interval(folder: &Folder, value: serde_json::Value) {
    let changed = folder
        .core
        .conn()
        .unwrap()
        .execute(
            "UPDATE items SET properties = json_set(properties, '$.full_pass_interval_seconds', json(?2)), version = version + 1 WHERE id = ?1",
            [folder.folder.as_str(), value.to_string().as_str()],
        )
        .unwrap();
    assert_eq!(changed, 1);
}

#[test]
fn a_quiet_watch_runs_a_full_pass_every_ten_minutes_where_the_folder_names_no_interval() {
    let (_dir, folder, _server, mut passes) = watched_notes(&["a.md"]);
    assert_eq!(
        ticks_of_full_passes(&mut passes, &folder, 1300),
        [600, 1200]
    );
}

#[test]
fn a_quiet_watch_runs_a_full_pass_every_interval_the_folder_names() {
    let (_dir, folder, _server, mut passes) = watched_notes_in(
        serde_json::json!({ "query": {}, "full_pass_interval_seconds": 90 }),
        &["a.md"],
    );
    assert_eq!(
        ticks_of_full_passes(&mut passes, &folder, 280),
        [90, 180, 270]
    );
}

#[test]
fn a_changed_interval_takes_effect_in_the_running_watch() {
    let (_dir, folder, _server, mut passes) = watched_notes_in(
        serde_json::json!({ "query": {}, "full_pass_interval_seconds": 3600 }),
        &["a.md"],
    );
    assert_eq!(
        ticks_of_full_passes(&mut passes, &folder, 200),
        Vec::<usize>::new()
    );
    set_interval(&folder, serde_json::json!(240));
    assert_eq!(
        ticks_of_full_passes(&mut passes, &folder, 100),
        Vec::<usize>::new(),
        "the witness: a watch reads the settings again only where they may have changed"
    );
    passes.settings_may_have_changed();
    assert_eq!(
        ticks_of_full_passes(&mut passes, &folder, 100),
        [1],
        "counted from the last full pass, 300 ticks before"
    );
    set_interval(&folder, serde_json::Value::Null);
    passes.settings_may_have_changed();
    assert_eq!(
        ticks_of_full_passes(&mut passes, &folder, 600),
        [501],
        "a removed interval is the default, counted from the full pass 99 ticks before"
    );
}

#[test]
fn a_watch_keeps_its_pace_while_the_folders_interval_is_one_it_refuses() {
    let (_dir, folder, _server, _passes) = watched_notes_in(
        serde_json::json!({ "query": {}, "full_pass_interval_seconds": 120 }),
        &["a.md"],
    );
    set_interval(&folder, serde_json::json!(5));
    assert!(folder.settings().is_err(), "the witness: it is refused");
    assert_eq!(
        folder.watch_settings(Duration::from_secs(120)).1,
        Duration::from_secs(120)
    );
    set_interval(&folder, serde_json::json!(300));
    assert_eq!(
        folder.watch_settings(Duration::from_secs(120)).1,
        Duration::from_secs(300)
    );
}

#[test]
fn each_folder_of_a_machine_keeps_its_own_interval() {
    let (_a_dir, a, _a_server, mut a_passes) = watched_notes_in(
        serde_json::json!({ "query": {}, "full_pass_interval_seconds": 100 }),
        &["a.md"],
    );
    let (_b_dir, b, _b_server, mut b_passes) = watched_notes(&["b.md"]);
    let mut seen = (Vec::new(), Vec::new());
    for tick in 1..=700 {
        if a_passes.tick(&a).unwrap() {
            seen.0.push(tick);
        }
        if b_passes.tick(&b).unwrap() {
            seen.1.push(tick);
        }
    }
    assert_eq!(seen.0, [100, 200, 300, 400, 500, 600, 700]);
    assert_eq!(seen.1, [600]);
}

#[test]
fn a_quiet_watch_with_nothing_standing_pulls_at_most_once_an_interval() {
    let (_dir, folder, _server, mut passes) = watched_notes(&["a.md", "b.md"]);
    let pulls = two_quiet_intervals(&mut passes, &folder);
    assert!(
        once_an_interval(pulls),
        "{pulls} pulls in two quiet intervals"
    );
}

#[cfg(unix)]
#[test]
fn a_quiet_watch_over_a_directory_it_cannot_read_pulls_at_most_once_an_interval() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, folder, _server, mut passes) = watched_notes(&["a.md"]);
    let shut = dir.path().join("shut");
    std::fs::create_dir(&shut).unwrap();
    std::fs::write(shut.join("inside.md"), "inside\n").unwrap();
    std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
    let open = |shut: &Path| {
        std::fs::set_permissions(shut, std::fs::Permissions::from_mode(0o700)).unwrap();
    };
    // A superuser reads every directory, so there is nothing to stand.
    if std::fs::read_dir(&shut).is_ok() {
        open(&shut);
        return;
    }
    passes.run(&folder, false).unwrap();
    let pulls = two_quiet_intervals(&mut passes, &folder);
    let flagged = folder
        .scan_watching(false, Duration::ZERO)
        .unwrap()
        .directories;
    open(&shut);
    assert!(!flagged.is_empty(), "the witness: the directory stands");
    assert!(
        once_an_interval(pulls),
        "{pulls} pulls in two quiet intervals"
    );
}

#[test]
fn a_quiet_watch_looks_again_each_minute_for_a_delete_it_cannot_tell_from_a_move() {
    let (registry, _registry) = super::registry::tests::own_registry();
    let (dir, folder) = folder_with(
        "01a00000-0000-7000-8000-0000000026e1",
        serde_json::json!({ "query": {} }),
        None,
    );
    std::fs::write(dir.path().join("a.md"), "a words\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    let id = landed(&folder, "a.md");
    answered(&folder);
    let (folder, server) = served(dir.path(), folder);
    let mut passes = watch::Passes::default();
    passes.run(&folder, true).unwrap();
    settle(&folder, &mut passes);

    std::fs::remove_file(dir.path().join("a.md")).unwrap();
    assert_eq!(folder.scan().unwrap().missing, 1);
    past_the_grace(&folder, "a.md");
    // Another folder the file may have moved to cannot be told.
    let listed = std::fs::read(registry.path()).unwrap();
    std::fs::write(registry.path(), "not a registry").unwrap();
    passes.run(&folder, false).unwrap();
    let unsure = || matches!(kept(&folder, "a.md"), Some(state::Kept::Unsure(_)));
    assert!(unsure(), "{:?}", kept(&folder, "a.md"));

    // The pass runs once a minute, not each tick, and the full pass is ten
    // minutes off.
    assert_eq!(ticks_of_full_passes(&mut passes, &folder, 130), [60, 120]);
    assert!(unsure(), "the witness: the delete stands undecided");

    // The registry can be read again, which no event here tells. The server
    // is busy, so the delete the quick pass decides waits in the queue.
    std::fs::write(registry.path(), listed).unwrap();
    server.on(
        &format!("/items/{id}"),
        vec![crate::scripted::refusal(503, "unavailable")],
    );
    let decided_after = (1..=60).find(|_| {
        passes.tick(&folder).unwrap();
        state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    });
    assert_eq!(
        decided_after,
        Some(50),
        "the quick pass did not decide the delete a minute after the look at tick 120"
    );
    assert_eq!(deletes_queued(&folder).len(), 1);
}

#[test]
fn a_quiet_watch_over_a_paused_removal_rests_until_the_full_pass_finds_the_file_back() {
    let (_, _registry) = super::registry::tests::own_registry();
    let (dir, folder) = folder_with(
        "01a00000-0000-7000-8000-0000000026e3",
        serde_json::json!({
            "query": {},
            "removal_threshold": { "files": 0, "fraction": 0.0 }
        }),
        None,
    );
    std::fs::write(dir.path().join("a.md"), "a words\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    landed(&folder, "a.md");
    answered(&folder);
    let (folder, _server) = served(dir.path(), folder);
    let mut passes = watch::Passes::default();
    passes.run(&folder, true).unwrap();
    settle(&folder, &mut passes);

    let path = dir.path().join("a.md");
    let before = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(folder.scan().unwrap().missing, 1);
    past_the_grace(&folder, "a.md");
    passes.run(&folder, false).unwrap();
    let paused = || state::paused(&folder.core.conn().unwrap(), state::Removal::Disk).unwrap();
    assert_eq!(paused(), ["a.md"]);

    let pulls = two_quiet_intervals(&mut passes, &folder);
    assert!(
        once_an_interval(pulls),
        "{pulls} pulls in two quiet intervals"
    );
    assert_eq!(paused(), ["a.md"], "the witness: the removal stands paused");

    // The file comes back, which no event here tells.
    std::fs::write(&path, &before).unwrap();
    assert!(
        wakes_within_an_interval(&mut passes, &folder, || paused().is_empty()),
        "the full pass did not find the file back"
    );
    assert!(deletes_queued(&folder).is_empty());
}

#[test]
fn a_quiet_watch_rests_while_the_server_is_out_of_reach_and_wakes_once_it_is_back() {
    let (_dir, folder, _server, mut passes) = watched_notes(&["a.md"]);
    assert!(
        passes
            .reach(&folder, Some("the server could not be reached".into()))
            .unwrap()
    );
    let pulls = two_quiet_intervals(&mut passes, &folder);
    assert!(
        once_an_interval(pulls),
        "{pulls} pulls in two quiet intervals"
    );
    assert!(
        passes.reach(&folder, None).unwrap(),
        "the server's reach coming back ran no pass"
    );
}

#[test]
fn a_deleted_file_held_for_a_line_its_item_never_took_goes_to_the_bin() {
    let (dir, folder, _server, _passes, _) = held_note();
    deleted(&dir, &folder);
    goes_to_the_bin(&dir, &folder);
}

#[test]
fn a_deleted_file_held_for_a_name_two_items_have_goes_to_the_bin() {
    const ELSEWHERE: &str = "01a00000-0000-7000-8000-0000000026a2";
    let (dir, folder, _server, _) = deleted_after(
        r#"about: "[[B]]""#,
        r#"about: ["[[B]]", "[[Same]]"]"#,
        (nothing_found(), "more than one item"),
        |dir, folder| {
            crate::store::put_server_item(
                &folder.core.conn().unwrap(),
                &crate::store::testing::note(ELSEWHERE, "Same", "", "2026-01-01T00:00:00Z"),
                None,
                &crate::catalog::Catalog::empty(),
            )
            .unwrap();
            std::fs::write(dir.path().join("Same.md"), "same\n").unwrap();
        },
    );
    goes_to_the_bin(&dir, &folder);
}

#[test]
fn a_deleted_file_held_for_names_whose_lookup_was_refused_goes_to_the_bin() {
    let (dir, folder, _server, _) = deleted_after(
        r#"about: "[[B]]""#,
        r#"about: ["[[B]]", "[[Denied]]"]"#,
        (
            crate::scripted::refusal(403, "forbidden"),
            "is looked up once the server can be asked",
        ),
        |_, _| {},
    );
    goes_to_the_bin(&dir, &folder);
}

#[test]
fn a_deleted_held_file_comes_back_once_another_device_removes_an_edge_its_line_made() {
    let (dir, folder, _server, id) = deleted_after(
        r#"about: "[[B]]""#,
        r#"about: ["[[B]]", "[[Ghost]]"]"#,
        (nothing_found(), "matches no item"),
        |_, _| {},
    );
    let removed = folder
        .core
        .conn()
        .unwrap()
        .execute(
            "DELETE FROM edges WHERE edge_type = 'about' AND source_id = ?1",
            [id.as_str()],
        )
        .unwrap();
    assert_eq!(removed, 1, "the witness: the line's edge was there");
    let text = comes_back(&dir, &folder, &id);
    assert!(!text.contains("about"), "{text}");
}

#[test]
fn a_deleted_held_file_comes_back_once_another_device_adds_a_name_to_its_line() {
    const C: &str = "01a00000-0000-7000-8000-0000000026c1";
    let (dir, folder, _server, id) = deleted_after(
        r#"about: "[[B]]""#,
        r#"about: ["[[B]]", "[[Ghost]]"]"#,
        (nothing_found(), "matches no item"),
        |_, _| {},
    );
    {
        let conn = folder.core.conn().unwrap();
        crate::store::put_server_item(
            &conn,
            &crate::store::testing::note(C, "C", "", "2026-01-01T00:00:00Z"),
            None,
            &crate::catalog::Catalog::empty(),
        )
        .unwrap();
        crate::store::put_server_edge(
            &conn,
            &crate::store::testing::wire_edge("about-c", &id, C, "about"),
        )
        .unwrap();
    }
    let text = comes_back(&dir, &folder, &id);
    assert!(!text.contains("Ghost"), "{text}");
}

#[test]
fn a_deleted_held_file_whose_item_changed_elsewhere_comes_back() {
    let (dir, folder, _server, _passes, id) = held_note();
    deleted(&dir, &folder);
    changed_elsewhere(&folder, &id, "changed elsewhere");
    let text = comes_back(&dir, &folder, &id);
    assert!(text.contains("changed elsewhere"), "{text}");
}

#[test]
fn a_deleted_held_file_goes_to_the_bin_once_its_link_target_appears() {
    const B: &str = "01a00000-0000-7000-8000-0000000026b1";
    let (dir, folder, _server, _passes, _) = held_note();
    deleted(&dir, &folder);
    crate::store::put_server_item(
        &folder.core.conn().unwrap(),
        &crate::store::testing::note(B, "B", "", "2026-01-01T00:00:00Z"),
        None,
        &crate::catalog::Catalog::empty(),
    )
    .unwrap();
    past_the_grace(&folder, "A.md");
    let swept = folder.scan().unwrap();
    assert_eq!(swept.trashed, ["A.md"], "{swept:?}");
    let pulled = folder.pull().unwrap();
    assert!(!dir.path().join("A.md").exists(), "{pulled:?}");
}

#[test]
fn a_held_file_back_on_the_disk_inside_the_grace_stays_as_it_is() {
    let (dir, folder, _server, _passes, _) = held_note();
    let path = dir.path().join("A.md");
    let before = std::fs::read(&path).unwrap();
    deleted(&dir, &folder);
    std::fs::write(&path, &before).unwrap();
    let back = folder.scan().unwrap();
    assert_eq!((back.missing, back.trashed.len()), (0, 0), "{back:?}");
    assert!(
        state::journaled(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
    folder.pull().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(deletes_queued(&folder).is_empty());
    assert!(held(&folder, "A.md").is_some());
}

/// `A.md` changed by `change`, which the server refuses at the item's door
/// `door` and then reads back the row it owes the copy, and deleted.
fn deleted_after_refusal(door: &str, change: impl FnOnce(&Path)) -> (ScannedDir, Folder, Scripted) {
    let (dir, folder, server, mut passes) = watched_notes(&["A.md"]);
    let id = bound(&folder, "A.md").unwrap().item_id;
    let item = folder.core.get(&id).unwrap().unwrap();
    let refused = crate::scripted::refusal(422, "validation_error");
    let read_back = certified(crate::scripted::json(
        200,
        &serde_json::json!({ "item": item, "metadata": { "tags": [] }, "listed": true })
            .to_string(),
    ));
    if door.is_empty() {
        server.on(&format!("/items/{id}"), vec![refused, read_back]);
    } else {
        server.on(&format!("/items/{id}{door}"), vec![refused]);
        server.on(&format!("/items/{id}"), vec![read_back]);
    }
    change(&dir.path().join("A.md"));
    passes.run(&folder, false).unwrap();
    let refusing = bound(&folder, "A.md").unwrap();
    assert!(
        refusing.holds_refusal(),
        "the witness: the change was refused, {refusing:?}"
    );
    deleted(&dir, &folder);
    (dir, folder, server)
}

#[test]
fn a_deleted_file_held_for_its_refused_edit_goes_to_the_bin() {
    let (dir, folder, _server) = deleted_after_refusal("", their_own_edit);
    goes_to_the_bin(&dir, &folder);
}

#[test]
fn a_deleted_file_held_for_its_refused_tag_goes_to_the_bin() {
    let (dir, folder, _server) =
        deleted_after_refusal("/tags", |path| with_line(path, "tags: [kept-out]"));
    goes_to_the_bin(&dir, &folder);
}

#[test]
fn a_deleted_file_held_for_its_refused_state_goes_to_the_bin() {
    let (dir, folder, _server) =
        deleted_after_refusal("/transition", |path| with_line(path, "state: archived"));
    goes_to_the_bin(&dir, &folder);
}

/// Appends a line to the note at `path`.
fn their_own_edit(path: &Path) {
    let text = std::fs::read_to_string(path).unwrap();
    std::fs::write(path, format!("{text}their own edit\n")).unwrap();
}

#[test]
fn a_deleted_file_held_for_its_refused_edit_comes_back_once_its_item_is_archived_elsewhere() {
    let (dir, folder, _server) = deleted_after_refusal("", their_own_edit);
    let id = bound(&folder, "A.md").unwrap().item_id;
    // The server archives an item without a version step.
    let archived = folder
        .core
        .conn()
        .unwrap()
        .execute(
            "UPDATE items SET state = 'archived' WHERE id = ?1 AND state = 'active'",
            [id.as_str()],
        )
        .unwrap();
    assert_eq!(archived, 1, "the witness: the item was active");
    let text = comes_back(&dir, &folder, &id);
    assert!(text.contains("state: archived"), "{text}");
}

#[test]
fn a_deleted_file_held_for_its_refused_edit_comes_back_once_this_copy_edits_its_item() {
    let (dir, folder, _server) = deleted_after_refusal("", their_own_edit);
    let id = bound(&folder, "A.md").unwrap().item_id;
    let item = folder.core.get(&id).unwrap().unwrap();
    let mut properties = item.properties.clone();
    properties.insert("body".into(), Value::String("written here\n".into()));
    folder
        .core
        .update_item(
            &id,
            &crate::model::Edit {
                properties,
                base_version: Some(item.version),
                ..crate::model::Edit::default()
            },
        )
        .unwrap();
    assert_eq!(
        folder.core.get(&id).unwrap().unwrap().version,
        item.version,
        "the witness: the unanswered write sits in the copy at the same version"
    );
    let text = comes_back(&dir, &folder, &id);
    assert!(text.contains("written here"), "{text}");
}

#[test]
fn a_deleted_file_held_as_unreadable_goes_to_the_bin() {
    let (dir, folder, _server, _passes) = watched_notes(&["A.md"]);
    std::fs::write(dir.path().join("A.md"), b"caf\xe9\n").unwrap();
    folder.scan().unwrap();
    assert!(
        held(&folder, "A.md").is_some_and(|held| held.starts_with(state::UNREADABLE)),
        "the witness: the file is held as unreadable, {:?}",
        held(&folder, "A.md")
    );
    deleted(&dir, &folder);
    goes_to_the_bin(&dir, &folder);
}

#[test]
fn a_pass_that_wrote_a_file_leaves_the_folder_at_rest() {
    let (dir, folder, _server, mut passes) = watched_notes(&["a.md"]);
    let note = dir.path().join("a.md");
    let id = state::bound_at(&folder.core.conn().unwrap(), "a.md")
        .unwrap()
        .unwrap()
        .item_id;
    changed_elsewhere(&folder, &id, "words from another device\n");
    passes.run(&folder, false).unwrap();
    assert!(
        std::fs::read_to_string(&note)
            .unwrap()
            .contains("words from another device"),
        "the witness: the pass wrote the file"
    );
    assert!(
        folder.stands_as_read(&note),
        "the file the pull wrote is not as the folder last read it"
    );
    assert!(
        !passes.tick(&folder).unwrap(),
        "a tick ran another pass over the file the pull had just written"
    );

    // The witness: an event naming a file a person has since edited or
    // removed is not passed over.
    std::fs::write(&note, "a person's edit\n").unwrap();
    assert!(!folder.stands_as_read(&note));
    std::fs::remove_file(&note).unwrap();
    assert!(!folder.stands_as_read(&note));
}

#[test]
fn a_file_replaced_by_one_with_the_same_bytes_and_time_is_not_one_as_read() {
    let (dir, folder, _server, _passes) = watched_notes(&["a.md"]);
    let note = dir.path().join("a.md");
    assert!(
        folder.stands_as_read(&note),
        "the witness: the untouched file stands as read"
    );
    let before = std::fs::metadata(&note).unwrap();
    let aside = dir.path().join("a.md.replacement");
    std::fs::write(&aside, std::fs::read(&note).unwrap()).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&aside)
        .unwrap()
        .set_modified(before.modified().unwrap())
        .unwrap();
    std::fs::rename(&aside, &note).unwrap();
    let after = std::fs::metadata(&note).unwrap();
    assert_eq!(
        (before.len(), before.modified().unwrap()),
        (after.len(), after.modified().unwrap()),
        "the witness: size and time are as read"
    );
    assert!(
        !folder.stands_as_read(&note),
        "a different file with the same size, time and bytes was taken for the one read, \
         so a rename of it before the next full pass moves no item"
    );
}

#[cfg(debug_assertions)]
#[test]
fn a_save_made_just_after_the_pull_landed_a_file_is_read_by_the_next_pass() {
    let (dir, folder, _server, mut passes) = watched_notes(&["a.md"]);
    let note = dir.path().join("a.md");
    let id = bound(&folder, "a.md").unwrap().item_id;
    changed_elsewhere(&folder, &id, "words from another device\n");
    {
        let _saving = crate::fault::fail_on_this_thread("folder-pull-saved-after-landing");
        passes.run(&folder, false).unwrap();
    }
    let text = std::fs::read_to_string(&note).unwrap();
    assert!(
        text.contains("words from another device") && text.contains("saved after landing"),
        "the witness: the pull wrote the file and a person saved over it, {text}"
    );
    assert_ne!(
        bound(&folder, "a.md").unwrap().content_hash,
        state::hash(text.as_bytes()),
        "the witness: the binding describes the bytes the pull wrote"
    );
    folder.scan_watching(false, Duration::ZERO).unwrap();
    assert_eq!(
        bound(&folder, "a.md").unwrap().content_hash,
        state::hash(text.as_bytes()),
        "the next quick pass skipped the person's save as unchanged"
    );
}

#[cfg(debug_assertions)]
#[test]
fn a_quiet_watch_over_a_refused_placement_wakes_once_the_key_can_be_read_again() {
    let key = |grant: &str| {
        crate::scripted::json(
            200,
            &format!(r#"{{"id":"key","edge_permissions":{{"{grant}":"write"}}}}"#),
        )
    };
    let (_dir, folder, server, mut passes) = watched_notes(&["a.md", "b.md"]);
    server.on("/keys/current", vec![key("references")]);
    let id = super::tests::id_at(&folder, "a.md");
    // The server refused the placement under a key that may not place, and
    // the copy took it back.
    folder.withhold(&id, "a.md").unwrap();
    folder
        .core
        .conn()
        .unwrap()
        .execute(
            "DELETE FROM edges WHERE source_id = ?1 AND edge_type = ?2",
            [&id, PLACEMENT_EDGE],
        )
        .unwrap();
    passes.run(&folder, false).unwrap();
    assert!(
        folder.placement(&id).unwrap().is_none(),
        "a placement was sent under the refusal that withholds it"
    );

    // The witness for the rest: the watch is not run for the refusal at
    // every tick.
    for _ in 0..30 {
        assert!(
            !passes.tick(&folder).unwrap(),
            "a standing refusal ran a pass at a tick before the key could be read again"
        );
    }

    // The grant is back, which no event tells, and the minute the key's
    // answer stands for is over.
    server.on("/keys/current", vec![key("*")]);
    passes.elapse_key(&folder, Duration::from_secs(61));
    assert!(
        passes.tick(&folder).unwrap(),
        "a watch at rest slept past the minute the key is read again in"
    );
    assert!(
        folder.placement(&id).unwrap().is_some(),
        "the restored grant did not release the refused placement"
    );
}
