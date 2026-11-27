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

/// The file a take-in read, and a person's save of it.
const TAKEN: &[u8] = b"as the server has it\n";
const SAVE: &[u8] = b"as the server has it\nthe person's edit\n";

/// A directory beside the folder's, as another folder's is.
fn beside(root: &Path) -> (tempfile::TempDir, PathBuf) {
    let other = tempfile::tempdir_in(root.join("..")).unwrap();
    let path = other.path().canonicalize().unwrap();
    (other, path)
}

fn displaced_at(folder: &Folder, place: &str, dir_at: (u64, u64), kept: &str, read: Object) {
    state::set_displaced(
        &folder.core.conn().unwrap(),
        &state::Displaced {
            dir: place.into(),
            dir_at,
            aside: place.into(),
            aside_at: dir_at,
            displacement: Displacement {
                id: kept[".marfa-kept-".len()..kept.len() - ".tmp".len()].into(),
                kind: Kind::Withdraw,
                target: "Recovery.md".into(),
                kept: kept.into(),
                ours: None,
                read,
            },
        },
    )
    .unwrap();
}

/// What a take-in that stopped in `dir` recorded, naming `dir` as `place`:
/// `Recovery.md` moved under its reserved name, which holds a person's save
/// where `save` and the file read otherwise. Answers the reserved file.
fn stopped_take_in(folder: &Folder, dir: &Path, place: &str, save: bool) -> PathBuf {
    let target = dir.join("Recovery.md");
    std::fs::write(&target, TAKEN).unwrap();
    let read = object_of(&target);
    let name = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
    let kept = dir.join(&name);
    std::fs::rename(&target, &kept).unwrap();
    if save {
        std::fs::write(&kept, SAVE).unwrap();
    }
    displaced_at(folder, place, at(dir), &name.to_string_lossy(), read);
    kept
}

/// The reasons `flagged` reports `path` kept for.
fn reported<'a>(flagged: &'a [Flagged], path: &Path) -> Vec<&'a str> {
    flagged
        .iter()
        .filter(|flagged| flagged.flag == "kept" && Path::new(&flagged.path) == path)
        .map(|flagged| flagged.reason.as_str())
        .collect()
}

/// Asserts `flagged` reports `path` once, as a file outside the folder that
/// came from `from`.
fn reported_outside(flagged: &[Flagged], path: &Path, from: &Path) {
    let reasons = reported(flagged, path);
    assert_eq!(reasons.len(), 1, "{} in {flagged:?}", path.display());
    assert!(
        reasons[0].contains(&*from.to_string_lossy()) && reasons[0].contains("outside this folder"),
        "{reasons:?}"
    );
}

/// A note scanned and answered, so a pull runs against the folder's copy.
fn pullable(root: &Path, folder: &Folder) {
    std::fs::write(root.join("Ready.md"), "ready\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    super::tests::landed(folder, "Ready.md");
}

fn records(folder: &Folder) -> usize {
    state::displaced(&folder.core.conn().unwrap())
        .unwrap()
        .len()
}

#[test]
fn a_record_outside_the_folder_is_never_acted_on_and_is_reported_every_pass() {
    for save in [true, false] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        pullable(&root, &folder);
        let (_other, other) = beside(&root);
        let kept = stopped_take_in(&folder, &other, &other.to_string_lossy(), save);
        // The witness: the same record in a directory in the folder settles.
        std::fs::create_dir(root.join("Projects")).unwrap();
        let inside = stopped_take_in(&folder, &root.join("Projects"), "Projects", save);
        let from = other.join("Recovery.md");

        for _ in 0..3 {
            let report = folder.scan().unwrap();
            reported_outside(&report.flagged, &kept, &from);
        }
        assert!(!inside.exists(), "save {save}: the witness did not settle");
        assert_eq!(root.join("Projects/Recovery.md").exists(), save);
        let pulled = folder.pull().unwrap();
        reported_outside(&pulled.flagged, &kept, &from);
        folder.scan_keeping_files().unwrap();

        assert_eq!(
            std::fs::read(&kept).unwrap(),
            if save { SAVE } else { TAKEN },
            "save {save}"
        );
        assert!(!from.exists(), "save {save}");
        assert_eq!(records(&folder), 1, "save {save}");
    }
}

#[test]
fn a_replacement_directory_at_an_outside_records_path_is_never_opened() {
    for holds in [true, false] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let (_other, other) = beside(&root);
        let name = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
        let kept = other.join(&name);
        // A directory at the path with the recorded inode, on another device
        // than the one recorded, as another volume mounted there is.
        let (device, inode) = at(&other);
        let mut read = Object {
            device: device ^ 1,
            inode: 0,
            length: None,
            modified: None,
            hash: Some(state::hash(TAKEN)),
        };
        if holds {
            std::fs::write(&kept, TAKEN).unwrap();
            read.inode = std::fs::metadata(&kept).unwrap().ino();
        }
        displaced_at(
            &folder,
            &other.to_string_lossy(),
            (device ^ 1, inode),
            &name.to_string_lossy(),
            read,
        );
        let from = other.join("Recovery.md");

        for _ in 0..2 {
            let report = folder.scan().unwrap();
            reported_outside(&report.flagged, &kept, &from);
        }
        assert_eq!(kept.exists(), holds, "holds {holds}");
        assert!(!from.exists(), "holds {holds}");
        assert_eq!(records(&folder), 1, "holds {holds}");
    }
}

/// Runs a quick pass, a scoped pass and a complete scan, and asserts each
/// reports `kept` as from `from` and the record stays.
fn kept_through_every_pass(folder: &Folder, kept: &Path, from: &Path) {
    let quick = folder.scan_holding_missing().unwrap();
    reported_outside(&quick.flagged, kept, from);
    let settle = std::time::Duration::from_millis(0);
    let scope = scoped::Scope::default();
    let scoped = folder
        .scan_watching_within(false, settle, scoped::Reading::Named(&scope))
        .unwrap();
    reported_outside(&scoped.flagged, kept, from);
    for _ in 0..2 {
        let report = folder.scan().unwrap();
        reported_outside(&report.flagged, kept, from);
    }
    assert_eq!(records(folder), 1);
}

#[test]
fn an_outside_record_is_kept_whatever_its_directory_answers() {
    for answer in ["locked", "a file", "absent"] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let (_other, other) = beside(&root);
        let kept = stopped_take_in(&folder, &other, &other.to_string_lossy(), true);
        let _locked = match answer {
            "locked" => Some(crate::test_folders::locked(&other, 0o000)),
            "a file" => {
                std::fs::remove_dir_all(&other).unwrap();
                std::fs::write(&other, "a file at the directory's path").unwrap();
                None
            }
            _ => {
                std::fs::remove_dir_all(&other).unwrap();
                None
            }
        };

        kept_through_every_pass(&folder, &kept, &other.join("Recovery.md"));
        drop(_locked);
        if answer == "locked" {
            assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
        }
        if answer == "a file" {
            std::fs::remove_file(&other).unwrap();
        }
    }
}

#[test]
fn a_record_with_a_parent_component_is_treated_as_outside() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    let place = format!("../{}", other.file_name().unwrap().to_string_lossy());
    let kept = stopped_take_in(&folder, &other, &place, true);
    let name = kept.file_name().unwrap().to_string_lossy();

    kept_through_every_pass(
        &folder,
        Path::new(&format!("{place}/{name}")),
        Path::new(&format!("{place}/Recovery.md")),
    );
    assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
    assert!(!other.join("Recovery.md").exists());
}

#[test]
fn an_unreadable_displaced_record_outside_the_folder_is_kept() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    std::fs::create_dir(root.join("Projects")).unwrap();
    let mut kept = Vec::new();
    for (id, place, there) in [
        ("1", other.to_string_lossy().into_owned(), other.clone()),
        ("2", "Projects".to_string(), root.join("Projects")),
    ] {
        let name = landing::reserved(id).to_string_lossy().into_owned();
        std::fs::write(there.join(&name), SAVE).unwrap();
        kept.push(there.join(&name));
        // No `kind`, so the record does not read.
        let value = serde_json::json!({
            "dir": place,
            "dir_at": at(&there),
            "aside": place,
            "aside_at": at(&there),
            "displacement": { "id": id, "target": "Recovery.md", "kept": name },
        });
        crate::store::meta_set(
            &folder.core.conn().unwrap(),
            &format!("folder_displaced:{id}"),
            &value.to_string(),
        )
        .unwrap();
    }

    for _ in 0..3 {
        let report = folder.scan().unwrap();
        reported_outside(&report.flagged, &kept[0], &other.join("Recovery.md"));
        // The witness: the record in the folder ends at the first pass.
        let keys: Vec<String> = folder
            .core
            .conn()
            .unwrap()
            .prepare("SELECT key FROM meta WHERE key LIKE 'folder_displaced:%'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(keys, ["folder_displaced:1"]);
    }
    assert_eq!(std::fs::read(&kept[0]).unwrap(), SAVE);
    assert_eq!(std::fs::read(&kept[1]).unwrap(), SAVE);
}

#[cfg(debug_assertions)]
#[test]
fn no_pass_writes_a_record_outside_the_folder() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    pullable(&root, &folder);
    let (_other, other) = beside(&root);
    let kept = stopped_take_in(&folder, &other, &other.to_string_lossy(), false);
    std::fs::create_dir(root.join("Projects")).unwrap();
    stopped_take_in(&folder, &root.join("Projects"), "Projects", false);
    let retained_in = |folder: &Folder| -> Vec<String> {
        state::retained(&folder.core.conn().unwrap())
            .unwrap()
            .into_iter()
            .map(|row| row.map_or_else(|row| row.aside, |row| row.dir))
            .collect()
    };

    {
        let _unknown = crate::fault::fail_on_this_thread("writers-unknown");
        folder.scan().unwrap();
        // The witness: in the folder, the fault keeps the file for a pass.
        assert_eq!(retained_in(&folder), ["Projects"]);
        folder.pull().unwrap();
        folder.discard_kept().unwrap();
    }
    assert!(retained_in(&folder).is_empty());
    assert_eq!(records(&folder), 1);
    assert_eq!(std::fs::read(&kept).unwrap(), TAKEN);
}

#[test]
fn place_dir_and_displaced_dir_refuse_places_outside_the_folder() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    let parent = format!("../{}", other.file_name().unwrap().to_string_lossy());
    std::fs::create_dir(root.join("Projects")).unwrap();
    // The witness: a place in the folder opens.
    assert!(folder.place_dir("Projects").is_ok());
    assert!(
        folder
            .displaced_dir("Projects", at(&root.join("Projects")))
            .is_ok()
    );
    for place in [other.to_string_lossy().into_owned(), parent] {
        let refused = |answer: std::io::Result<Directory>| answer.err().map(|error| error.kind());
        assert_eq!(
            refused(folder.place_dir(&place)),
            Some(std::io::ErrorKind::InvalidInput),
            "{place}"
        );
        assert_eq!(
            refused(folder.displaced_dir(&place, at(&other))),
            Some(std::io::ErrorKind::InvalidInput),
            "{place}"
        );
    }
}

/// A write to `Moved/Plan.md` bound before its bytes landed, with the file
/// moved out under a reserved name in `aside`, outside the folder, where
/// `aside_holds`. The record names `aside` as `place`. Answers the binding
/// and the reserved file.
fn waiting_write(
    folder: &Folder,
    root: &Path,
    aside: &Path,
    place: &str,
    aside_holds: bool,
) -> (state::Bound, PathBuf) {
    std::fs::create_dir(root.join("Moved")).unwrap();
    std::fs::write(root.join("Moved/Plan.md"), TAKEN).unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    super::tests::landed(folder, "Moved/Plan.md");
    folder.pull().unwrap();
    let read = object_of(&root.join("Moved/Plan.md"));
    let name = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
    if aside_holds {
        std::fs::rename(root.join("Moved/Plan.md"), aside.join(&name)).unwrap();
    } else {
        std::fs::remove_file(root.join("Moved/Plan.md")).unwrap();
    }
    let conn = folder.core.conn().unwrap();
    let mut bound = state::bound_at(&conn, "Moved/Plan.md").unwrap().unwrap();
    bound.writes.landing = Some(state::Landing { before: None });
    state::bind(&conn, &bound).unwrap();
    let kept = aside.join(&name);
    let name = name.to_string_lossy().into_owned();
    state::set_displaced(
        &conn,
        &state::Displaced {
            dir: "Moved".into(),
            dir_at: at(&root.join("Moved")),
            aside: place.into(),
            aside_at: at(aside),
            displacement: Displacement {
                id: name[".marfa-kept-".len()..name.len() - ".tmp".len()].into(),
                kind: Kind::Withdraw,
                target: "Plan.md".into(),
                kept: name,
                ours: None,
                read,
            },
        },
    )
    .unwrap();
    (bound, kept)
}

#[test]
fn a_row_with_an_outside_aside_keeps_its_in_folder_write_waiting() {
    for state in ["directory moved", "aside absent", "aside present"] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let (_other, other) = beside(&root);
        let place = other.to_string_lossy().into_owned();
        let (bound, _) = waiting_write(&folder, &root, &other, &place, state == "aside present");
        match state {
            "directory moved" => {
                std::fs::rename(root.join("Moved"), root.join("Elsewhere")).unwrap()
            }
            "aside absent" => std::fs::remove_dir_all(&other).unwrap(),
            _ => {}
        }
        let binding = |folder: &Folder| {
            state::bound_at(&folder.core.conn().unwrap(), "Moved/Plan.md").unwrap()
        };

        folder.scan_holding_missing().unwrap();
        assert_eq!(
            binding(&folder).as_ref(),
            Some(&bound),
            "{state}: quick pass"
        );
        assert!(journal_row(&folder).is_none(), "{state}: quick pass");
        folder.scan().unwrap();
        assert_eq!(
            binding(&folder).as_ref(),
            Some(&bound),
            "{state}: writing scan"
        );
        assert_eq!(records(&folder), 1, "{state}");
    }
}

#[test]
fn an_unreadable_displaced_record_with_no_aside_is_reported_where_main_lists_it() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    let name = landing::reserved("1").to_string_lossy().into_owned();
    std::fs::write(other.join(&name), SAVE).unwrap();
    // No `kind` and no `aside`, so the record does not read or show where its file is.
    let value = serde_json::json!({
        "dir": other.to_string_lossy(),
        "dir_at": at(&other),
        "displacement": { "id": "1", "target": "Recovery.md", "kept": name },
    });
    crate::store::meta_set(
        &folder.core.conn().unwrap(),
        "folder_displaced:1",
        &value.to_string(),
    )
    .unwrap();

    for _ in 0..2 {
        let report = folder.scan().unwrap();
        let reasons = reported(&report.flagged, Path::new(&name));
        assert_eq!(reasons.len(), 1, "{:?}", report.flagged);
        assert!(
            reasons[0].contains(&*other.join("Recovery.md").to_string_lossy())
                && reasons[0].contains("not the directory"),
            "{reasons:?}"
        );
        assert!(reported(&report.flagged, &other.join(&name)).is_empty());
    }
    assert_eq!(std::fs::read(other.join(&name)).unwrap(), SAVE);
    assert_eq!(records(&folder), 1);
}

#[cfg(debug_assertions)]
#[test]
fn a_scan_that_finds_the_root_replaced_leaves_outside_notices_for_the_next() {
    for case in ["locked", "outside"] {
        let (dir, folder) = scanned_folder();
        let root = dir.path().canonicalize().unwrap();
        let (_other, other) = beside(&root);
        // A record `main` also keeps and reports every pass is the witness.
        let kept = if case == "outside" {
            stopped_take_in(&folder, &other, &other.to_string_lossy(), true)
        } else {
            std::fs::create_dir(root.join("Locked")).unwrap();
            let kept = stopped_take_in(&folder, &root.join("Locked"), "Locked", true);
            Path::new("Locked").join(kept.file_name().unwrap())
        };
        let _locked =
            (case == "locked").then(|| crate::test_folders::locked(root.join("Locked"), 0o000));
        std::fs::create_dir(root.with_extension("replacement")).unwrap();

        // SAFETY: nextest runs each test in a process of its own, and nothing
        // else in this one reads the environment while it changes.
        unsafe { std::env::set_var("MARFA_TEST_FAULT", "replace-root-before-capture") };
        let ended = folder.scan();
        // SAFETY: as above.
        unsafe { std::env::remove_var("MARFA_TEST_FAULT") };
        let ended = ended.unwrap();
        assert!(ended.root_gone.is_some(), "{case}");
        assert!(kept_flags(&ended).is_empty(), "{case}: {:?}", ended.flagged);
        std::fs::rename(&root, root.with_extension("swapped")).unwrap();
        std::fs::rename(root.with_extension("original"), &root).unwrap();

        let report = folder.scan().unwrap();
        assert_eq!(
            reported(&report.flagged, &kept).len(),
            1,
            "{case}: {:?}",
            report.flagged
        );
        assert_eq!(records(&folder), 1, "{case}");
        drop(_locked);
        std::fs::remove_dir_all(root.with_extension("swapped")).unwrap();
    }
}

#[test]
fn an_outside_record_survives_a_scoped_pass() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("Ready.md"), "ready\n").unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    let (_other, other) = beside(&root);
    let kept = stopped_take_in(&folder, &other, &other.to_string_lossy(), true);
    let from = other.join("Recovery.md");
    let settle = std::time::Duration::from_millis(0);
    let captured = || super::tests::FILES_CAPTURED.with(std::cell::Cell::take);

    captured();
    let walked = folder
        .scan_watching_within(false, settle, scoped::Reading::Keeping)
        .unwrap();
    reported_outside(&walked.flagged, &kept, &from);
    assert!(captured() > 0, "the witness: a walk takes each file");
    let scope = scoped::Scope::default();
    let named = folder
        .scan_watching_within(false, settle, scoped::Reading::Named(&scope))
        .unwrap();
    assert_eq!(captured(), 0, "the pass walked: {named:?}");
    reported_outside(&named.flagged, &kept, &from);
    assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
    assert!(!from.exists());
    assert_eq!(records(&folder), 1);
}

#[test]
fn removing_a_folder_ends_its_outside_records_and_touches_their_files() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    let kept = stopped_take_in(&folder, &other, &other.to_string_lossy(), true);
    let from = other.join("Recovery.md");
    reported_outside(&folder.scan().unwrap().flagged, &kept, &from);

    folder.remove().unwrap();
    assert!(!root.join(STATE_DIR).join("core.sqlite").exists());
    assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
    assert!(!from.exists());
}

#[test]
fn a_reserved_name_met_in_the_folder_is_not_settled_against_an_outside_record() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    let projects = root.join("Projects");
    std::fs::create_dir(&projects).unwrap();
    std::fs::write(projects.join("Recovery.md"), TAKEN).unwrap();
    let read = object_of(&projects.join("Recovery.md"));
    let name = landing::reserved(&uuid::Uuid::now_v7().simple().to_string());
    std::fs::rename(projects.join("Recovery.md"), projects.join(&name)).unwrap();
    std::fs::write(projects.join(&name), SAVE).unwrap();
    // An absent directory outside the folder, recorded with `Projects`'s identity.
    let place = other.join("Gone").to_string_lossy().into_owned();
    displaced_at(
        &folder,
        &place,
        at(&projects),
        &name.to_string_lossy(),
        read,
    );
    let met = Path::new("Projects").join(&name);

    for _ in 0..2 {
        let report = folder.scan().unwrap();
        assert_eq!(
            reported(&report.flagged, &met).len(),
            1,
            "{:?}",
            report.flagged
        );
    }
    assert_eq!(std::fs::read(projects.join(&name)).unwrap(), SAVE);
    assert!(!projects.join("Recovery.md").exists());
    assert_eq!(records(&folder), 1);
}

const HELD: &str = "Moved/Plan.md";

/// The journal row at the waiting write's path, if any.
fn journal_row(folder: &Folder) -> Option<state::Journaled> {
    state::journaled(&folder.core.conn().unwrap())
        .unwrap()
        .into_iter()
        .find(|row| row.path == HELD)
}

/// Moves every journaled delete past the grace.
fn age_the_journal(folder: &Folder) {
    let long_ago = crate::store::iso_at(
        crate::clock::system_time() - RENAME_GRACE - std::time::Duration::from_secs(1),
    );
    folder
        .core
        .conn()
        .unwrap()
        .execute(
            "UPDATE folder_journal SET missing_since = ?1",
            [long_ago.as_str()],
        )
        .unwrap();
}

fn waiting_at_held(flagged: &[Flagged]) -> usize {
    flagged
        .iter()
        .filter(|flagged| flagged.path == HELD && flagged.flag == "waiting")
        .count()
}

/// Runs a scan, two more past the grace and a pull, and asserts the write at
/// `HELD`, whose file is absent, stayed held through each.
fn held_past_the_grace(folder: &Folder, root: &Path, bound: &state::Bound, case: &str) {
    let mut reports = vec![folder.scan().unwrap()];
    for _ in 0..2 {
        age_the_journal(folder);
        reports.push(folder.scan().unwrap());
    }
    folder.pull().unwrap();
    let trashed: Vec<&String> = reports.iter().flat_map(|report| &report.trashed).collect();
    assert!(trashed.is_empty(), "{case}: {trashed:?}");
    assert!(super::tests::deletes_queued(folder).is_empty(), "{case}");
    let conn = folder.core.conn().unwrap();
    let item = crate::store::items_by_ids(&conn, std::slice::from_ref(&bound.item_id))
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(item.state, ItemState::Active, "{case}");
    assert_eq!(
        state::bound_at(&conn, HELD).unwrap().as_ref(),
        Some(bound),
        "{case}"
    );
    drop(conn);
    assert!(!root.join(HELD).exists(), "{case}: a pull wrote it");
    assert!(journal_row(folder).is_none(), "{case}");
    assert_eq!(records(folder), 1, "{case}");
    for report in &reports {
        assert_eq!(
            waiting_at_held(&report.flagged),
            1,
            "{case}: {:?}",
            report.flagged
        );
    }
}

/// A write at `HELD` blocked by a record whose `aside`, beside the folder,
/// holds the file under its reserved name.
struct Blocked {
    _dir: super::tests::ScannedDir,
    folder: Folder,
    root: PathBuf,
    _other: tempfile::TempDir,
    other: PathBuf,
    bound: state::Bound,
    kept: PathBuf,
}

fn blocked() -> Blocked {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (other_dir, other) = beside(&root);
    let place = other.to_string_lossy().into_owned();
    let (bound, kept) = waiting_write(&folder, &root, &other, &place, true);
    Blocked {
        _dir: dir,
        folder,
        root,
        _other: other_dir,
        other,
        bound,
        kept,
    }
}

#[test]
fn a_blocked_write_whose_aside_holds_the_file_unchanged_never_trashes_its_item() {
    let at = blocked();
    let taken = std::fs::read(&at.kept).unwrap();
    held_past_the_grace(&at.folder, &at.root, &at.bound, "unchanged");
    assert_eq!(std::fs::read(&at.kept).unwrap(), taken);
}

#[test]
fn a_blocked_write_whose_aside_holds_a_save_never_trashes_its_item() {
    for before in [false, true] {
        let at = blocked();
        let (mut bound, kept) = (at.bound.clone(), at.kept.clone());
        std::fs::write(&kept, SAVE).unwrap();
        if before {
            let mut prior = bound.clone();
            prior.writes.landing = None;
            bound.writes.landing = Some(state::Landing {
                before: Some(Box::new(prior)),
            });
            state::bind(&at.folder.core.conn().unwrap(), &bound).unwrap();
        }
        held_past_the_grace(&at.folder, &at.root, &bound, &format!("before {before}"));
        assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
    }
}

#[test]
fn a_blocked_write_whose_aside_is_gone_never_trashes_its_item() {
    let at = blocked();
    std::fs::remove_dir_all(&at.other).unwrap();
    held_past_the_grace(&at.folder, &at.root, &at.bound, "gone");
}

#[test]
fn a_blocked_write_whose_aside_has_a_parent_component_never_trashes_its_item() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    let (_other, other) = beside(&root);
    let place = format!("../{}", other.file_name().unwrap().to_string_lossy());
    let (bound, kept) = waiting_write(&folder, &root, &other, &place, true);
    std::fs::write(&kept, SAVE).unwrap();
    held_past_the_grace(&folder, &root, &bound, "parent");
    assert_eq!(std::fs::read(&kept).unwrap(), SAVE);
}

#[test]
fn a_blocked_write_whose_directory_moved_away_never_trashes_its_item() {
    let at = blocked();
    let taken = std::fs::read(&at.kept).unwrap();
    std::fs::rename(at.root.join("Moved"), at.root.join("Elsewhere")).unwrap();
    held_past_the_grace(&at.folder, &at.root, &at.bound, "moved away");
    assert_eq!(std::fs::read(&at.kept).unwrap(), taken);
    assert!(!at.root.join("Elsewhere/Plan.md").exists());
}

#[test]
fn a_bound_file_removed_with_no_record_is_trashed_after_the_grace() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("Moved")).unwrap();
    std::fs::write(root.join(HELD), TAKEN).unwrap();
    assert_eq!(folder.scan().unwrap().created, 1);
    super::tests::landed(&folder, HELD);
    folder.pull().unwrap();
    std::fs::remove_file(root.join(HELD)).unwrap();

    assert!(folder.scan().unwrap().trashed.is_empty());
    age_the_journal(&folder);
    assert_eq!(folder.scan().unwrap().trashed, [HELD]);
    assert_eq!(super::tests::deletes_queued(&folder).len(), 1);
}

#[test]
fn a_blocked_write_whose_target_holds_the_landed_bytes_stays_pending() {
    let at = blocked();
    let mut bound = at.bound.clone();
    let landed = b"what the pull wrote\n";
    std::fs::write(at.root.join(HELD), landed).unwrap();
    bound.content_hash = state::hash(landed);
    state::bind(&at.folder.core.conn().unwrap(), &bound).unwrap();

    for _ in 0..3 {
        assert!(at.folder.scan().unwrap().trashed.is_empty());
        age_the_journal(&at.folder);
    }
    assert!(super::tests::deletes_queued(&at.folder).is_empty());
    let conn = at.folder.core.conn().unwrap();
    let held = state::bound_at(&conn, HELD).unwrap().unwrap();
    assert!(held.writes.landing.is_some());
    let item = crate::store::items_by_ids(&conn, std::slice::from_ref(&bound.item_id))
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(item.state, ItemState::Active);
    drop(conn);
    assert_eq!(std::fs::read(at.root.join(HELD)).unwrap(), landed);
    assert_eq!(records(&at.folder), 1);
}

#[test]
fn a_new_file_at_a_blocked_path_is_held_not_sent() {
    let at = blocked();
    let bound = &at.bound;
    std::fs::write(at.root.join(HELD), "a new plan\n").unwrap();
    let queued = at.folder.core.queue().unwrap().len();

    for _ in 0..2 {
        let report = at.folder.scan().unwrap();
        assert_eq!(report.created, 0);
        assert_eq!(waiting_at_held(&report.flagged), 1, "{:?}", report.flagged);
    }
    assert_eq!(at.folder.core.queue().unwrap().len(), queued);
    assert_eq!(
        state::bound_at(&at.folder.core.conn().unwrap(), HELD)
            .unwrap()
            .as_ref(),
        Some(bound)
    );
    assert_eq!(std::fs::read(at.root.join(HELD)).unwrap(), b"a new plan\n");
}

#[test]
fn a_watch_does_not_keep_passing_for_a_blocked_path() {
    let at = blocked();
    let report = at
        .folder
        .scan_watching(true, std::time::Duration::ZERO)
        .unwrap();
    assert_eq!(waiting_at_held(&report.flagged), 1, "{:?}", report.flagged);
    assert!(
        !at.folder
            .grace_running(crate::clock::system_time())
            .unwrap()
    );
    assert!(journal_row(&at.folder).is_none());
}

#[test]
fn status_lists_a_blocked_path_as_held() {
    let at = blocked();
    let bound = &at.bound;
    at.folder.scan().unwrap();
    let status = at.folder.status().unwrap();
    let file = status
        .files
        .iter()
        .find(|file| file.path == HELD)
        .unwrap_or_else(|| panic!("{:?}", status.files));
    assert_eq!(file.status, "held");
    assert_eq!(file.flag, Some("waiting"));
    assert_eq!(file.item_id.as_deref(), Some(bound.item_id.as_str()));
    assert!(
        file.reason
            .as_deref()
            .is_some_and(|reason| reason.contains("folders remove")),
        "{file:?}"
    );
}
