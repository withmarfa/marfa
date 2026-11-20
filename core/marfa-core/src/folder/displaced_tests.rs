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

#[cfg(debug_assertions)]
#[test]
fn a_save_whose_directory_left_the_folder_is_reported_until_it_is_back() {
    let (dir, folder) = scanned_folder();
    let root = dir.path().canonicalize().unwrap();
    stopped_after_the_exchange(&folder, &root);
    let elsewhere = tempfile::tempdir_in(root.join("..")).unwrap();
    std::fs::rename(root.join("Projects"), elsewhere.path().join("Projects")).unwrap();

    for _ in 0..2 {
        let report = folder.scan().unwrap();
        let kept = kept_flags(&report);
        assert_eq!(kept.len(), 1, "{:?}", report.flagged);
        assert!(kept[0].starts_with("Projects/.marfa-kept-"), "{kept:?}");
    }
    let status = folder.status().unwrap();
    assert!(
        status
            .files
            .iter()
            .any(|file| file.flag == Some("kept") && file.path.starts_with("Projects/.marfa-kept-")),
        "{:?}",
        status.files
    );

    // Back inside the folder, under another name, it is settled there.
    std::fs::rename(elsewhere.path().join("Projects"), root.join("Back")).unwrap();
    let report = folder.scan().unwrap();
    assert_eq!(std::fs::read(root.join("Back/Roadmap.md")).unwrap(), SAVED);
    assert!(reserved_in(&root.join("Back")).is_empty());
    assert!(kept_flags(&report).is_empty(), "{:?}", report.flagged);
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
