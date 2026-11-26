//! Files a write or a removal moved out of their path: kept, reported and
//! settled by the next pass.

use std::os::unix::fs::MetadataExt;

use super::landing::{Displaced as Kind, Displacement, Object};
use super::tests::scanned_folder;
use super::*;

fn object_of(path: &Path) -> Object {
    let metadata = std::fs::metadata(path).unwrap();
    Object {
        device: metadata.dev(),
        inode: metadata.ino(),
        length: None,
        modified: None,
        hash: Some(state::hash(&std::fs::read(path).unwrap())),
    }
}

fn kept_flags(report: &ScanReport) -> Vec<&str> {
    report
        .flagged
        .iter()
        .filter(|flagged| flagged.flag == "kept")
        .map(|flagged| flagged.path.as_str())
        .collect()
}

#[test]
fn a_file_under_a_reserved_name_is_reported_and_never_swept() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("Projects")).unwrap();
    let kept = root.join("Projects/.marfa-kept-0123abcd.tmp");
    std::fs::write(&kept, "a person's words").unwrap();
    // The witness: a file a crashed write left, beside it, is swept.
    let mut ended = std::process::Command::new("true").spawn().unwrap();
    let gone = ended.id();
    ended.wait().unwrap();
    let left = root.join(format!("Projects/.marfa-{gone}-0.tmp"));
    std::fs::write(&left, "unfinished").unwrap();

    for _ in 0..2 {
        let report = folder.scan().unwrap();
        assert_eq!(
            kept_flags(&report),
            ["Projects/.marfa-kept-0123abcd.tmp"],
            "{:?}",
            report.flagged
        );
        assert_eq!(std::fs::read(&kept).unwrap(), b"a person's words");
        assert!(!left.exists());
    }
    let bound = state::bound_paths(&folder.core.conn().unwrap()).unwrap();
    assert!(
        bound.iter().all(|(path, _)| !path.contains(".marfa-kept-")),
        "{bound:?}"
    );
}

#[test]
fn a_displacement_a_stopped_run_left_is_settled_by_the_next_scan() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("Projects")).unwrap();
    let read = root.join("Projects/.marfa-kept-00000000000000000000000000000001.tmp");
    let saved = root.join("Projects/.marfa-kept-00000000000000000000000000000002.tmp");
    std::fs::write(&read, "as last written").unwrap();
    std::fs::write(&saved, "the person's save").unwrap();
    let read_object = object_of(&read);
    // A removal stopped after it moved the file read aside, and another
    // stopped after it moved a person's save aside.
    let rows = [("1", "Old.md", &read), ("2", "Roadmap.md", &saved)];
    {
        let conn = folder.core.conn().unwrap();
        for (id, target, kept) in rows {
            state::set_displaced(
                &conn,
                &state::Displaced {
                    dir: "Projects".into(),
                    dir_at: at(&root.join("Projects")),
                    aside: "Projects".into(),
                    aside_at: at(&root.join("Projects")),
                    displacement: Displacement {
                        id: id.into(),
                        kind: Kind::Withdraw,
                        target: target.into(),
                        kept: kept.file_name().unwrap().to_string_lossy().into_owned(),
                        ours: None,
                        read: read_object.clone(),
                    },
                },
            )
            .unwrap();
        }
    }

    let report = folder.scan().unwrap();
    assert!(!read.exists(), "the file read, unchanged, goes");
    assert!(!root.join("Projects/Old.md").exists());
    assert!(!saved.exists());
    assert_eq!(
        std::fs::read(root.join("Projects/Roadmap.md")).unwrap(),
        b"the person's save"
    );
    assert!(kept_flags(&report).is_empty(), "{:?}", report.flagged);
    assert!(
        state::displaced(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_save_kept_beside_its_path_after_a_stopped_run_is_reported_once() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let saved = root.join(".marfa-kept-00000000000000000000000000000003.tmp");
    std::fs::write(&saved, "the person's save").unwrap();
    std::fs::write(root.join("Roadmap.md"), "another file at the path").unwrap();
    let read = root.join("elsewhere.txt");
    std::fs::write(&read, "as last written").unwrap();
    state::set_displaced(
        &folder.core.conn().unwrap(),
        &state::Displaced {
            dir: String::new(),
            dir_at: at(&root),
            aside: String::new(),
            aside_at: at(&root),
            displacement: Displacement {
                id: "3".into(),
                kind: Kind::Withdraw,
                target: "Roadmap.md".into(),
                kept: saved.file_name().unwrap().to_string_lossy().into_owned(),
                ours: None,
                read: object_of(&read),
            },
        },
    )
    .unwrap();

    let report = folder.scan().unwrap();
    assert_eq!(
        std::fs::read(root.join("Roadmap (2).md")).unwrap(),
        b"the person's save"
    );
    assert_eq!(
        std::fs::read(root.join("Roadmap.md")).unwrap(),
        b"another file at the path"
    );
    assert!(!saved.exists());
    assert_eq!(
        kept_flags(&report),
        ["Roadmap (2).md"],
        "{:?}",
        report.flagged
    );
    // Reported once: the next pass names it no more.
    assert!(kept_flags(&folder.scan().unwrap()).is_empty());
}

fn at(dir: &Path) -> (u64, u64) {
    landing::identity(&std::fs::metadata(dir).unwrap())
}

#[cfg(debug_assertions)]
fn reserved_in(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| landing::is_reserved(Path::new(name)))
        .collect()
}

/// The file as a save after the last look leaves it.
#[cfg(debug_assertions)]
const SAVED: &[u8] = b"as last writtensaved after the last look\n";

/// Writes over `Projects/Roadmap.md`, with a person's save renamed over it
/// after the last look, and stops after the exchange: the save is under a
/// reserved name in `Projects`, and its row waits in the folder's state.
#[cfg(debug_assertions)]
fn stopped_after_the_exchange(folder: &Folder, root: &Path) {
    std::fs::create_dir(root.join("Projects")).unwrap();
    let target = root.join("Projects/Roadmap.md");
    std::fs::write(&target, "as last written").unwrap();
    // Its own connection, so the stop poisons none the folder holds.
    let conn = rusqlite::Connection::open(root.join(STATE_DIR).join("core.sqlite")).unwrap();
    let stopped = {
        let _save = crate::fault::fail_on_this_thread("save-after-last-look");
        let _stop = crate::fault::fail_on_this_thread("crash-after-exchange");
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            folder.land(
                &conn,
                &target,
                |file, _| std::io::Write::write_all(file, b"from the server"),
                |_| true,
            )
        }))
    };
    assert!(stopped.is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"from the server");
    assert_eq!(reserved_in(&root.join("Projects")).len(), 1);
}

#[cfg(debug_assertions)]
#[test]
fn a_save_whose_directory_moved_after_a_stopped_write_is_put_back_where_it_went() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    std::fs::rename(root.join("Projects"), root.join("Plans")).unwrap();
    // Another directory takes the old one's name, and is left alone.
    std::fs::create_dir(root.join("Projects")).unwrap();
    std::fs::write(root.join("Projects/Roadmap.md"), "a new file").unwrap();

    let report = folder.scan().unwrap();
    assert_eq!(std::fs::read(root.join("Plans/Roadmap.md")).unwrap(), SAVED);
    assert!(reserved_in(&root.join("Plans")).is_empty());
    assert_eq!(
        std::fs::read(root.join("Projects/Roadmap.md")).unwrap(),
        b"a new file"
    );
    assert!(reserved_in(&root.join("Projects")).is_empty());
    assert!(kept_flags(&report).is_empty(), "{:?}", report.flagged);
    assert!(
        state::displaced(&folder.core.conn().unwrap())
            .unwrap()
            .is_empty()
    );
}

/// The status files flagged `kept`, by path.
#[cfg(debug_assertions)]
fn kept_in_status(folder: &Folder) -> Vec<String> {
    folder
        .status()
        .unwrap()
        .files
        .into_iter()
        .filter(|file| file.flag == Some("kept"))
        .map(|file| file.path)
        .collect()
}

#[cfg(debug_assertions)]
fn rows(folder: &Folder) -> usize {
    state::displaced(&folder.core.conn().unwrap())
        .unwrap()
        .len()
}

#[cfg(debug_assertions)]
#[test]
fn a_save_whose_directory_left_the_folder_is_reported_once_and_let_go() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    let elsewhere = tempfile::tempdir_in(root.join("..")).unwrap();
    std::fs::rename(root.join("Projects"), elsewhere.path().join("Projects")).unwrap();

    let status = kept_in_status(&folder);
    assert_eq!(status.len(), 1, "{status:?}");
    assert!(status[0].starts_with("Projects/.marfa-kept-"), "{status:?}");
    // A quick pass ends nothing, and leaves the report to the full one.
    let quick = folder.scan_holding_missing().unwrap();
    assert!(kept_flags(&quick).is_empty(), "{:?}", quick.flagged);
    assert_eq!(rows(&folder), 1);

    let report = folder.scan().unwrap();
    let kept: Vec<&Flagged> = report
        .flagged
        .iter()
        .filter(|flagged| flagged.flag == "kept")
        .collect();
    assert_eq!(kept.len(), 1, "{:?}", report.flagged);
    assert_eq!(kept[0].path, status[0]);
    assert!(
        kept[0].reason.contains("no longer in the folder"),
        "{:?}",
        kept[0]
    );
    assert_eq!(rows(&folder), 0);
    assert!(kept_flags(&folder.scan().unwrap()).is_empty());
    assert!(kept_in_status(&folder).is_empty());
    if let Ok(pulled) = folder.pull() {
        assert!(
            pulled.flagged.iter().all(|flagged| flagged.flag != "kept"),
            "{:?}",
            pulled.flagged
        );
    }
    // The file itself stays where the directory went.
    assert_eq!(
        reserved_in(&elsewhere.path().join("Projects")).len(),
        1,
        "the file moved out of its path is gone"
    );
}

#[cfg(debug_assertions)]
#[test]
fn a_report_of_a_save_that_left_the_folder_survives_a_pass_that_ends_early() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    let elsewhere = tempfile::tempdir_in(root.join("..")).unwrap();
    std::fs::rename(root.join("Projects"), elsewhere.path().join("Projects")).unwrap();
    std::fs::create_dir(root.with_extension("replacement")).unwrap();

    // SAFETY: nextest runs each test in a process of its own, and nothing
    // else in this one reads the environment while it changes.
    unsafe { std::env::set_var("MARFA_TEST_FAULT", "replace-root-before-capture") };
    let ended = folder.scan();
    // SAFETY: as above.
    unsafe { std::env::remove_var("MARFA_TEST_FAULT") };
    assert!(ended.unwrap().root_gone.is_some());
    std::fs::rename(&root, root.with_extension("swapped")).unwrap();
    std::fs::rename(root.with_extension("original"), &root).unwrap();

    let report = folder.scan().unwrap();
    let kept: Vec<&Flagged> = report
        .flagged
        .iter()
        .filter(|flagged| flagged.flag == "kept")
        .collect();
    assert_eq!(
        kept.len(),
        1,
        "the report of a save that left the folder was lost with the pass that ended early: {:?}",
        report.flagged
    );
    assert!(
        kept[0].reason.contains("no longer in the folder"),
        "{kept:?}"
    );
    assert!(kept_flags(&folder.scan().unwrap()).is_empty());
    std::fs::remove_dir_all(root.with_extension("swapped")).unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn a_deleted_directorys_row_is_let_go_after_one_report() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    std::fs::remove_dir_all(root.join("Projects")).unwrap();

    assert_eq!(kept_flags(&folder.scan().unwrap()).len(), 1);
    assert_eq!(rows(&folder), 0);
    for _ in 0..2 {
        let report = folder.scan().unwrap();
        assert!(kept_flags(&report).is_empty(), "{:?}", report.flagged);
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_save_whose_directory_moved_is_reported_only_where_the_walk_meets_it() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    std::fs::rename(root.join("Projects"), root.join("Plans")).unwrap();

    // A pass that writes no file settles nothing, and reports the file once.
    for _ in 0..2 {
        let report = folder.scan_keeping_files().unwrap();
        let kept = kept_flags(&report);
        assert_eq!(kept.len(), 1, "{:?}", report.flagged);
        assert!(kept[0].starts_with("Plans/.marfa-kept-"), "{kept:?}");
        assert_eq!(rows(&folder), 1);
    }
    let status = kept_in_status(&folder);
    assert_eq!(status.len(), 1, "{status:?}");
    assert!(status[0].starts_with("Plans/.marfa-kept-"), "{status:?}");

    // The witness: a pass that writes files settles it there.
    let report = folder.scan().unwrap();
    assert_eq!(std::fs::read(root.join("Plans/Roadmap.md")).unwrap(), SAVED);
    assert!(kept_flags(&report).is_empty(), "{:?}", report.flagged);
    assert_eq!(rows(&folder), 0);
}

#[cfg(debug_assertions)]
#[test]
fn a_copy_of_a_reserved_name_elsewhere_is_kept_and_the_row_settles_in_its_own_directory() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    std::fs::rename(root.join("Projects"), root.join("Plans")).unwrap();
    std::fs::create_dir(root.join("A copy")).unwrap();
    let name = reserved_in(&root.join("Plans")).remove(0);
    for file in [name.as_str(), "Roadmap.md"] {
        std::fs::copy(
            root.join("Plans").join(file),
            root.join("A copy").join(file),
        )
        .unwrap();
    }
    let mut walked = folder.walked(&folder.settings().unwrap().lists().unwrap());
    walked.kept.sort_by(|a, b| a.1.cmp(&b.1));
    assert!(
        walked.kept[0].1.starts_with("A copy/"),
        "the copy is not met first, so nothing below is about it: {:?}",
        walked.kept.iter().map(|(_, path)| path).collect::<Vec<_>>()
    );

    assert!(folder.settle_found(&walked.kept).unwrap());
    assert_eq!(std::fs::read(root.join("Plans/Roadmap.md")).unwrap(), SAVED);
    assert!(reserved_in(&root.join("Plans")).is_empty());
    assert_eq!(rows(&folder), 0);
    let copy = root.join("A copy").join(&name);
    assert_eq!(std::fs::read(&copy).unwrap(), SAVED);
    let report = folder.scan().unwrap();
    assert_eq!(kept_flags(&report), [format!("A copy/{name}").as_str()]);
    assert!(copy.exists());
}

#[cfg(debug_assertions)]
#[test]
fn a_row_settles_where_the_volume_was_mounted_again() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    // As if recorded before the volume was mounted again, under another
    // device number than it has now.
    {
        let conn = folder.core.conn().unwrap();
        let mut row = state::displaced(&conn).unwrap().remove(0).unwrap();
        let earlier = |device: u64| device ^ 1;
        row.dir_at.0 = earlier(row.dir_at.0);
        row.aside_at.0 = earlier(row.aside_at.0);
        row.displacement.read.device = earlier(row.displacement.read.device);
        if let Some((_, ours)) = row.displacement.ours.as_mut() {
            ours.device = earlier(ours.device);
        }
        state::set_displaced(&conn, &row).unwrap();
    }

    let report = folder.scan().unwrap();
    assert_eq!(
        std::fs::read(root.join("Projects/Roadmap.md")).unwrap(),
        SAVED
    );
    assert!(reserved_in(&root.join("Projects")).is_empty());
    assert!(!root.join("Projects/Roadmap (2).md").exists());
    assert!(kept_flags(&report).is_empty(), "{:?}", report.flagged);
    assert_eq!(rows(&folder), 0);
}

/// A note at `Projects/Kept.md` bound to its item, changed elsewhere, and a
/// pull that writes it stopped after the exchange, unless `stop` is false.
/// Answers the folder, opened again, and the item's id.
#[cfg(debug_assertions)]
fn pulled_into_projects(dir: &Path, folder: Folder, stop: bool) -> (Folder, String) {
    std::fs::create_dir(dir.join("Projects")).unwrap();
    std::fs::write(dir.join("Projects/Kept.md"), "as it was\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    let id = super::tests::landed(&folder, "Projects/Kept.md");
    folder.pull().unwrap();
    super::tests::changed_elsewhere(&folder, &id, "changed elsewhere\n");
    if stop {
        let _stop = crate::fault::fail_on_this_thread("crash-after-exchange");
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| folder.pull()));
        assert!(stopped.is_err());
        assert_eq!(reserved_in(&dir.join("Projects")).len(), 1);
    } else {
        folder.pull().unwrap();
    }
    assert!(
        std::fs::read_to_string(dir.join("Projects/Kept.md"))
            .unwrap()
            .contains("changed elsewhere")
    );
    drop(folder);
    (Folder::open(dir, None).unwrap(), id)
}

#[cfg(debug_assertions)]
#[test]
fn an_item_follows_its_file_where_its_directory_moved_after_a_stopped_write() {
    for stop in [false, true] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let (folder, id) = pulled_into_projects(&root, folder, stop);
        std::fs::rename(root.join("Projects"), root.join("Plans")).unwrap();
        std::fs::create_dir(root.join("Projects")).unwrap();
        std::fs::write(root.join("Projects/Kept.md"), "a new file\n").unwrap();

        let report = folder.scan().unwrap();
        assert!(reserved_in(&root.join("Plans")).is_empty(), "stop {stop}");
        let conn = folder.core.conn().unwrap();
        let bound = |path: &str| state::bound_at(&conn, path).unwrap().map(|row| row.item_id);
        assert_eq!(
            bound("Plans/Kept.md").as_deref(),
            Some(id.as_str()),
            "stop {stop}: {report:?}"
        );
        assert!(
            bound("Projects/Kept.md").is_some_and(|other| other != id),
            "stop {stop}: {report:?}"
        );
        assert_eq!(
            (report.created, report.renamed),
            (1, 1),
            "stop {stop}: {report:?}"
        );
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_file_deleted_after_a_stopped_write_with_no_exchange_is_not_brought_back() {
    for (stop, deleted) in [
        ("crash-after-aside-landing", true),
        ("crash-after-withdraw", false),
    ] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let target = root.join("Roadmap.md");
        std::fs::write(&target, "as last written").unwrap();
        let conn = rusqlite::Connection::open(root.join(STATE_DIR).join("core.sqlite")).unwrap();
        let stopped = {
            let _no_exchange = crate::fault::fail_on_this_thread("rename-exchange-unsupported");
            let _stop = crate::fault::fail_on_this_thread(stop);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                folder.land(
                    &conn,
                    &target,
                    |file, _| std::io::Write::write_all(file, b"from the server"),
                    |_| true,
                )
            }))
        };
        assert!(stopped.is_err(), "{stop}");
        if deleted {
            assert_eq!(std::fs::read(&target).unwrap(), b"from the server");
            std::fs::remove_file(&target).unwrap();
        } else {
            assert!(!target.exists(), "{stop}");
        }

        let report = folder.scan().unwrap();
        let kept = reserved_in(&root);
        if deleted {
            assert!(
                !target.exists(),
                "a file the person deleted was brought back"
            );
            assert_eq!(kept.len(), 1, "{kept:?}");
            assert_eq!(
                std::fs::read(root.join(&kept[0])).unwrap(),
                b"as last written"
            );
            assert!(
                kept_flags(&report).contains(&kept[0].as_str()),
                "{:?}",
                report.flagged
            );
        } else {
            // The witness: where the new file never landed, the old one goes
            // back.
            assert_eq!(std::fs::read(&target).unwrap(), b"as last written");
            assert!(kept.is_empty(), "{kept:?}");
        }
        assert_eq!(rows(&folder), 0, "{stop}");
    }
}

#[cfg(debug_assertions)]
#[test]
fn a_second_save_of_the_settings_file_is_kept_in_the_root_and_reported() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let settings = root.join(STATE_DIR).join("folder.yaml");
    assert!(matches!(
        folder
            .write_settings_file(&serde_json::Map::new(), 1, None)
            .unwrap(),
        settings_file::Wrote::Written
    ));
    let wrote = {
        let _first = crate::fault::fail_on_this_thread("save-after-last-look");
        let _second = crate::fault::fail_on_this_thread("save-during-put-back");
        folder
            .write_settings_file(&serde_json::Map::new(), 2, None)
            .unwrap()
    };
    assert!(matches!(wrote, settings_file::Wrote::Overtaken));
    assert!(
        std::fs::read_to_string(&settings)
            .unwrap()
            .ends_with("saved after the last look\n")
    );
    let state_files: Vec<String> = std::fs::read_dir(root.join(STATE_DIR))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("folder"))
        .collect();
    assert_eq!(state_files, ["folder.yaml"]);
    let kept = reserved_in(&root);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(
        std::fs::read_to_string(root.join(&kept[0]))
            .unwrap()
            .ends_with("saved again\n")
    );

    let report = folder.scan().unwrap();
    assert_eq!(
        kept_flags(&report),
        [kept[0].as_str()],
        "{:?}",
        report.flagged
    );
    assert_eq!(report.created, 0);
    // Reported again by the walk while it stays, and never sent.
    let report = folder.scan().unwrap();
    assert_eq!(kept_flags(&report), [kept[0].as_str()]);
    assert_eq!(report.created, 0);
}

/// What a take-in from another folder recorded as it stopped, with the file
/// it took moved aside under its reserved name in `source`, which now holds
/// the person's save.
fn stopped_take_in(source: &Path) -> state::Displaced {
    let target = source.join("Recovery.md");
    std::fs::write(&target, "as the server has it\n").unwrap();
    let read = object_of(&target);
    let id = uuid::Uuid::now_v7().simple().to_string();
    let kept = source.join(landing::reserved(&id));
    std::fs::rename(&target, &kept).unwrap();
    std::fs::write(&kept, SAVE).unwrap();
    let place = source.to_string_lossy().into_owned();
    state::Displaced {
        dir: place.clone(),
        dir_at: at(source),
        aside: place,
        aside_at: at(source),
        displacement: Displacement {
            id,
            kind: Kind::Withdraw,
            target: "Recovery.md".into(),
            kept: kept.file_name().unwrap().to_string_lossy().into_owned(),
            ours: None,
            read,
        },
    }
}

const SAVE: &[u8] = b"as the server has it\nthe person's edit\n";

fn displaced_rows(folder: &Folder) -> usize {
    state::displaced(&folder.core.conn().unwrap())
        .unwrap()
        .len()
}

fn retained_rows(folder: &Folder) -> usize {
    state::retained(&folder.core.conn().unwrap()).unwrap().len()
}

fn kept_paths(folder: &Folder) -> Vec<String> {
    folder
        .kept_files()
        .unwrap()
        .into_iter()
        .map(|file| file.path)
        .collect()
}

/// The paths the folder's status holds as `kept`.
fn held_as_kept(root: &Path) -> Vec<String> {
    Folder::status_of(root)
        .unwrap()
        .files
        .into_iter()
        .filter(|file| file.status == "held" && file.flag == Some("kept"))
        .map(|file| file.path)
        .collect()
}

/// Asserts the record of `path` is kept and listed in `folders kept` and in
/// the status, after a scan and after the owner's discard.
fn kept_and_listed(folder: &Folder, root: &Path, path: &Path, case: &str) {
    let path = path.to_string_lossy().into_owned();
    folder.scan().unwrap();
    folder.scan().unwrap();
    assert_eq!(kept_paths(folder), std::slice::from_ref(&path), "{case}");
    assert!(
        held_as_kept(root).contains(&path),
        "{case}: the status does not hold it"
    );
    let done = folder.discard_kept().unwrap();
    assert!(done.discarded.is_empty(), "{case}: {done:?}");
    assert!(
        done.forgotten.is_empty(),
        "{case}: the record was forgotten, and the save it names may be on a volume not mounted: {done:?}"
    );
    assert_eq!(
        done.kept.iter().map(|file| &file.path).collect::<Vec<_>>(),
        [&path],
        "{case}"
    );
    assert!(
        done.kept[0].reason.contains("marfa folders remove"),
        "{case}: the owner is not told how to end it: {}",
        done.kept[0].reason
    );
    assert_eq!(kept_paths(folder), [path], "{case}");
}

/// A record of a take-in from another folder holds its directory's device
/// and inode and no birth time, which another directory at its path can
/// share, so no shape of it is ever acted on.
#[test]
fn a_take_in_record_in_another_folders_directory_is_kept_and_listed_never_acted_on() {
    type Change = fn(&mut state::Displaced, &Path);
    let shapes: [(&str, Change); 6] = [
        ("as a take-in wrote it", |_, _| {}),
        ("an exchange", |row, _| {
            row.displacement.kind = Kind::Exchange;
        }),
        ("a replace with a new file waiting", |row, _| {
            let waiting = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
            row.displacement.ours = Some((
                waiting.to_string_lossy().into_owned(),
                row.displacement.read.clone(),
            ));
        }),
        ("its reserved name in another directory", |row, source| {
            let aside = source.parent().unwrap().join("Aside");
            std::fs::create_dir(&aside).unwrap();
            std::fs::rename(
                source.join(&row.displacement.kept),
                aside.join(&row.displacement.kept),
            )
            .unwrap();
            row.aside = aside.to_string_lossy().into_owned();
            row.aside_at = at(&aside);
        }),
        ("a reserved name its id does not give", |row, source| {
            let other = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
            std::fs::rename(source.join(&row.displacement.kept), source.join(&other)).unwrap();
            row.displacement.kept = other.to_string_lossy().into_owned();
        }),
        ("a target outside its directory", |row, _| {
            row.displacement.target = "../Recovery.md".into();
        }),
    ];
    for (shape, change) in shapes {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let other = tempfile::tempdir_in(root.join("..")).unwrap();
        let source = other.path().canonicalize().unwrap().join("Source");
        std::fs::create_dir(&source).unwrap();
        let mut row = stopped_take_in(&source);
        change(&mut row, &source);
        let kept = Path::new(&row.aside).join(&row.displacement.kept);
        state::set_displaced(&folder.core.conn().unwrap(), &row).unwrap();

        kept_and_listed(&folder, &root, &kept, shape);

        let put_back = [source.join("Recovery.md"), source.join("../Recovery.md")]
            .into_iter()
            .find(|path| path.exists());
        assert_eq!(put_back, None, "{shape}: a file was put back");
        assert_eq!(std::fs::read(&kept).unwrap(), SAVE, "{shape}");
        assert_eq!(displaced_rows(&folder), 1, "{shape}");
    }
}

/// Two volume roots have the same inode, so a row recorded on one names the
/// directory that another volume mounted at the same path has; a test cannot
/// mount a volume, so the recorded device stands for the one that was there.
#[test]
fn another_volume_at_a_take_ins_recorded_path_is_never_settled_against() {
    for case in [
        "lacks the reserved name",
        "no directory at the path",
        "holds the reserved name",
    ] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let other = tempfile::tempdir_in(root.join("..")).unwrap();
        let source = other.path().canonicalize().unwrap().join("Source");
        std::fs::create_dir(&source).unwrap();
        let mut row = stopped_take_in(&source);
        let was = row.dir_at.0 ^ 1;
        row.dir_at.0 = was;
        row.aside_at.0 = was;
        row.displacement.read.device = was;
        let kept = source.join(&row.displacement.kept);
        match case {
            "lacks the reserved name" => std::fs::remove_file(&kept).unwrap(),
            "no directory at the path" => std::fs::remove_dir_all(&source).unwrap(),
            _ => {}
        }
        state::set_displaced(&folder.core.conn().unwrap(), &row).unwrap();

        kept_and_listed(&folder, &root, &kept, case);

        assert!(
            !source.join("Recovery.md").exists(),
            "{case}: a file was put back in a directory on another volume"
        );
        assert_eq!(kept.exists(), case == "holds the reserved name", "{case}");
        assert_eq!(displaced_rows(&folder), 1, "{case}");
    }
}

#[test]
fn a_take_in_record_is_listed_whatever_its_directory_answers() {
    for case in ["not a directory", "unreadable"] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let other = tempfile::tempdir_in(root.join("..")).unwrap();
        let source = other.path().canonicalize().unwrap().join("Source");
        std::fs::create_dir(&source).unwrap();
        let row = stopped_take_in(&source);
        let kept = source.join(&row.displacement.kept);
        state::set_displaced(&folder.core.conn().unwrap(), &row).unwrap();
        let _locked = if case == "not a directory" {
            std::fs::remove_dir_all(&source).unwrap();
            std::fs::write(&source, "a file at the directory's path\n").unwrap();
            None
        } else {
            Some(crate::test_folders::locked(&source, 0o000))
        };

        folder.scan().unwrap();

        let path = kept.to_string_lossy().into_owned();
        assert_eq!(kept_paths(&folder), std::slice::from_ref(&path), "{case}");
        assert!(held_as_kept(&root).contains(&path), "{case}");
        assert_eq!(displaced_rows(&folder), 1, "{case}");
    }
}

/// A file a take-in from another folder kept under its reserved name in
/// `source` because a program might still write to it, recorded with the
/// directory's identity on the device `device`, long enough ago that a file
/// kept in the folder would be ended for its age.
fn kept_by_a_take_in(source: &Path, device: u64) -> state::Retained {
    let id = uuid::Uuid::now_v7().simple().to_string();
    let kept = source.join(landing::reserved(&id));
    std::fs::write(&kept, "as the take-in read it\n").unwrap();
    let metadata = std::fs::metadata(&kept).unwrap();
    let place = source.to_string_lossy().into_owned();
    let at = (device, at(source).1);
    state::Retained {
        dir: place.clone(),
        dir_at: at,
        aside: place,
        aside_at: at,
        retained: landing::Retained {
            id,
            kind: Kind::Withdraw,
            target: "Recovery.md".into(),
            kept: kept.file_name().unwrap().to_string_lossy().into_owned(),
            ours: None,
            read: Object {
                device,
                inode: metadata.ino(),
                length: Some(metadata.len()),
                modified: None,
                hash: Some(state::hash(b"as the take-in read it\n")),
            },
            changed: None,
            since: 0,
            writers: Some(super::writers::Writers::Unknown),
        },
    }
}

/// As above, the recorded device stands for another volume.
#[test]
fn a_file_kept_in_another_folders_directory_is_never_deleted_or_ended() {
    for case in [
        "as recorded",
        "another volume at its path",
        "an exchange",
        "no directory at the path",
    ] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let other = tempfile::tempdir_in(root.join("..")).unwrap();
        let source = other.path().canonicalize().unwrap().join("Source");
        std::fs::create_dir(&source).unwrap();
        let here = at(&source).0;
        let mut row = kept_by_a_take_in(
            &source,
            if case == "another volume at its path" {
                here ^ 1
            } else {
                here
            },
        );
        if case == "an exchange" {
            row.retained.kind = Kind::Exchange;
        }
        let kept = source.join(&row.retained.kept);
        if case == "no directory at the path" {
            std::fs::remove_dir_all(&source).unwrap();
        }
        state::set_retained(&folder.core.conn().unwrap(), &row).unwrap();

        kept_and_listed(&folder, &root, &kept, case);

        assert_eq!(kept.exists(), case != "no directory at the path", "{case}");
        assert_eq!(retained_rows(&folder), 1, "{case}");
    }
}

#[test]
fn a_record_whose_id_is_not_its_key_is_read_as_one_that_does_not_read() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let other = tempfile::tempdir_in(root.join("..")).unwrap();
    let source = other.path().canonicalize().unwrap();
    let conn = folder.core.conn().unwrap();
    let key = uuid::Uuid::now_v7().simple().to_string();
    let displaced = stopped_take_in(&source);
    crate::store::meta_set(
        &conn,
        &format!("folder_displaced:{key}"),
        &serde_json::to_string(&displaced).unwrap(),
    )
    .unwrap();
    let retained = kept_by_a_take_in(&source, at(&source).0);
    crate::store::meta_set(
        &conn,
        &format!("folder_retained:{key}"),
        &serde_json::to_string(&retained).unwrap(),
    )
    .unwrap();

    match &state::displaced(&conn).unwrap()[..] {
        [Err(row)] => {
            assert_eq!(row.id, key);
            assert!(!row.inside, "{row:?}");
        }
        rows => panic!("read under another record's id: {rows:?}"),
    }
    match &state::retained(&conn).unwrap()[..] {
        [Err(row)] => assert_eq!(row.id, key),
        rows => panic!("read under another record's id: {rows:?}"),
    }
}

#[test]
fn a_record_outside_the_folder_that_does_not_read_is_kept_and_listed() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let other = tempfile::tempdir_in(root.join("..")).unwrap();
    let source = other.path().canonicalize().unwrap().join("Source");
    std::fs::create_dir(&source).unwrap();
    let row = stopped_take_in(&source);
    let kept = source.join(&row.displacement.kept);
    let mut value = serde_json::to_value(&row).unwrap();
    value["displacement"]
        .as_object_mut()
        .unwrap()
        .remove("kind");
    let key = format!("folder_displaced:{}", row.displacement.id);
    crate::store::meta_set(&folder.core.conn().unwrap(), &key, &value.to_string()).unwrap();

    kept_and_listed(&folder, &root, &kept, "no kind");

    assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
    assert!(
        crate::store::meta_get(&folder.core.conn().unwrap(), &key)
            .unwrap()
            .is_some(),
        "the record was dropped"
    );
}

/// A stopped discard's record proves its directory, but the kept file's own
/// record is a take-in's, which nothing proves.
#[cfg(debug_assertions)]
#[test]
fn a_stopped_discard_of_a_take_ins_file_is_never_settled() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let other = tempfile::tempdir_in(root.join("..")).unwrap();
    let source = other.path().canonicalize().unwrap().join("Source");
    std::fs::create_dir(&source).unwrap();
    let row = kept_by_a_take_in(&source, at(&source).0);
    let private = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
    std::fs::rename(source.join(&row.retained.kept), source.join(&private)).unwrap();
    let conn = folder.core.conn().unwrap();
    state::set_retained(&conn, &row).unwrap();
    state::set_discarding(
        &conn,
        &state::Discarding {
            id: row.retained.id.clone(),
            aside: row.aside.clone(),
            aside_at: identity::Seen::of(&std::fs::metadata(&source).unwrap()),
            kept: row.retained.kept.clone(),
            private: private.to_string_lossy().into_owned(),
            from: joined(&row.dir, &row.retained.target),
            left: None,
        },
    )
    .unwrap();
    drop(conn);

    folder.scan().unwrap();

    assert!(
        source.join(&private).exists(),
        "a file in another folder's directory was renamed"
    );
    assert!(!source.join(&row.retained.kept).exists());
    assert!(
        kept_paths(&folder).contains(&source.join(&private).to_string_lossy().into_owned()),
        "{:?}",
        kept_paths(&folder)
    );
}
