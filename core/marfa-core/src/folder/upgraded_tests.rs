use serde_json::json;

use super::tests::{folder_with, landed, past_the_grace};
use super::*;

fn store_of(dir: &Path) -> PathBuf {
    dir.join(STATE_DIR).join(crate::store::FOLDER_STORE)
}

fn read(dir: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(store_of(dir), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
}

fn version(dir: &Path) -> i64 {
    read(dir)
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

/// Each row of the folder's record of missing files, with its item, why it
/// is kept and the binding's identity and bytes.
fn journal(dir: &Path) -> Vec<String> {
    read(dir)
        .prepare(
            "SELECT path || ' ' || item_id || ' ' || missing_since || ' ' || ifnull(kept, '-')
                    || ' ' || ifnull(reason, '-') || ' ' || ifnull(identity, '-')
                    || ' ' || ifnull(content_hash, '-')
             FROM folder_journal ORDER BY path, item_id",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn upgradable(refused: &CoreError) -> bool {
    matches!(
        refused,
        CoreError::WrongSchema {
            folder: Some(crate::FolderStore::Upgradable),
            ..
        }
    )
}

#[test]
fn a_folder_at_schema_11_is_read_without_advice_to_remove_it_and_upgraded_by_its_next_scan_with_every_held_file()
 {
    let (_, _registry) = registry::tests::own_registry();
    let query = json!({ "query": {} });
    let (from, a) = folder_with("01a00000-0000-7000-8000-0000000036a1", query.clone(), None);
    let (other, b) = folder_with("01a00000-0000-7000-8000-0000000036a2", query, None);
    b.scan().unwrap();
    for name in ["held.txt", "later.txt"] {
        std::fs::write(from.path().join(name), format!("{name} words\n")).unwrap();
    }
    assert_eq!(a.scan().unwrap().created, 2);
    let held_item = landed(&a, "held.txt");
    landed(&a, "later.txt");
    // Another folder is on the computer, so the delete is held for the person.
    std::fs::remove_file(from.path().join("held.txt")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 1);
    past_the_grace(&a, "held.txt");
    let swept = a.scan().unwrap();
    assert_eq!(swept.deleted, 0, "{swept:?}");
    assert!(
        swept.unsure.iter().any(|file| file.path == "held.txt"),
        "{swept:?}"
    );
    let held_before = journal(from.path());
    assert!(
        held_before
            .iter()
            .any(|row| row.starts_with(&format!("held.txt {held_item} "))
                && row.contains(" unsure ")),
        "{held_before:?}"
    );
    drop(a);
    drop(b);
    for dir in [from.path(), other.path()] {
        crate::store::testing::as_schema_11(&store_of(dir));
        assert_eq!(version(dir), 11);
    }

    // A command that only reads leaves it, and says the next writer upgrades it.
    for refused in [
        Folder::status_of(from.path()).err().unwrap(),
        Folder::held_of(from.path()).err().unwrap(),
    ] {
        assert!(upgradable(&refused), "{refused:?}");
        let said = refused.to_string();
        assert!(
            said.contains("next push, pull, scan or watch upgrades it in place"),
            "{said}"
        );
        for advice in ["folders remove", "folders add", "MARFA_VERSION"] {
            assert!(!said.contains(advice), "{advice}: {said}");
        }
    }
    assert_eq!(version(from.path()), 11, "a read changed the store");

    let a = Folder::open(from.path(), None).unwrap();
    assert_eq!(a.replaced_store(), None, "the store was replaced");
    assert_eq!(version(from.path()), crate::store::SCHEMA_VERSION);
    assert_eq!(journal(from.path()), held_before);

    // The other folder, not yet upgraded, holds the next delete for the person.
    std::fs::remove_file(from.path().join("later.txt")).unwrap();
    assert_eq!(a.scan().unwrap().missing, 2);
    past_the_grace(&a, "later.txt");
    let swept = a.scan().unwrap();
    assert_eq!(swept.deleted, 0, "{swept:?}");
    let reason = swept
        .unsure
        .iter()
        .find(|file| file.path == "later.txt")
        .map(|file| file.reason.clone())
        .unwrap_or_else(|| panic!("{swept:?}"));
    assert!(
        reason.contains(&other.path().display().to_string()) && reason.contains("upgrades"),
        "{reason}"
    );
    assert!(!reason.contains("folders remove"), "{reason}");
    assert_eq!(version(other.path()), 11, "a peer's read changed its store");

    let mut listed: Vec<String> = Folder::held_of(from.path())
        .unwrap()
        .into_iter()
        .map(|file| file.path)
        .collect();
    listed.sort();
    assert_eq!(listed, ["held.txt", "later.txt"]);
    Folder::status_of(from.path()).unwrap();
    let settled = a
        .settle_held(&["held.txt".to_string()], Settle::Trash)
        .unwrap();
    assert_eq!(settled.trashed, ["held.txt"], "{settled:?}");

    let b = Folder::open(other.path(), None).unwrap();
    assert_eq!(b.replaced_store(), None, "the other store was replaced");
    assert_eq!(version(other.path()), crate::store::SCHEMA_VERSION);
    b.scan().unwrap();
}

#[test]
fn a_folder_at_schema_11_is_listed_paused_only_while_its_sync_is_paused() {
    let (_, _registry) = registry::tests::own_registry();
    let query = json!({ "query": {} });
    let (paused, a) = folder_with("01a00000-0000-7000-8000-0000000036c1", query.clone(), None);
    let (running, b) = folder_with("01a00000-0000-7000-8000-0000000036c2", query, None);
    assert!(a.pause_sync().unwrap());
    drop(a);
    drop(b);
    for dir in [paused.path(), running.path()] {
        crate::store::testing::as_schema_11(&store_of(dir));
    }

    assert!(
        Folder::paused_at(paused.path()),
        "a paused folder was listed running"
    );
    assert!(!Folder::paused_at(running.path()));
    assert_eq!(version(paused.path()), 11, "a read changed the store");
}

/// Gives the folder store at `root`, which no connection holds open, the
/// records of stopped removals and discards in the shape v0.0.113 wrote
/// them, at the schema version it wrote.
pub(super) fn as_written_by_v0_0_113(root: &Path) {
    rusqlite::Connection::open(store_of(root))
        .unwrap()
        .execute_batch(
            "UPDATE meta SET value = json_object(
                'item_id', json_extract(value, '$.item_id'),
                'at', json_array(json_extract(value, '$.file.device'), json_extract(value, '$.file.inode')),
                'born', json_extract(value, '$.file.born'),
                'hash', json_extract(value, '$.hash'))
             WHERE key >= 'folder_taken:' AND key < 'folder_taken;' AND json_valid(value);
             UPDATE meta SET value = json_remove(value, '$.aside_at')
             WHERE key >= 'folder_discarding:' AND key < 'folder_discarding;' AND json_valid(value);
             PRAGMA user_version = 12;",
        )
        .unwrap();
}
