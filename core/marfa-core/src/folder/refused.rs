//! A folder's store that another build of the core made. Where it holds no
//! write still to be sent and no answer the folder has yet to record, the
//! store holds three things: a copy of the server's rows, which a hydration fills
//! again; the folder's record of its files, in tables whose shape seldom
//! changes; and what the folder records of itself in the store's meta. So a
//! folder's writer replaces it with a store of this build's shape that keeps
//! the record and the meta, as a hydration does (`folders/refused-store-replaced`).

use std::path::Path;
use std::sync::Arc;

use super::first;
use crate::directory::Directory;
use crate::lock::WriterLock;
use crate::{Core, CoreError, FolderStore, Result, Server, store};

/// Whether the meta key `key` is one the folder records of itself and no
/// hydration brings back: every key a folder sets starts `folder_`; the
/// server the store was filled from goes with them, so the new store is
/// filled from the same instance (`folders/refused-store-kept`,
/// `folders/refused-store-origin-kept`); and so does each purge remembered
/// of a pinned row, since no hydration brings a purged row back and only
/// that record tells the folder its file goes (`folders/refused-store-purge-kept`).
/// What else a hydration keeps no folder needs: the source a credential was
/// learned to stamp, which is asked again; the file cache's budget, which
/// only a device's own store is given; and what each write in the queue,
/// which the replacement does not carry, needed.
fn carried(key: &str) -> bool {
    key.starts_with("folder_")
        || key.starts_with(store::PURGED_PIN)
        || key == store::META_SERVER_ORIGIN
        || key == store::META_INSTANCE_ID
}

/// Opens the folder's store in `state` under `lock`, refused with
/// `ReadingHandle` unless `lock` is the writer's. A store this build
/// refuses `wrong_schema` that holds nothing unsent and that this build can
/// carry is replaced first, and the reason it was refused is answered with
/// the store. `adding` replaces one that names no folder too, since the add
/// names it.
pub(super) fn opened(
    state: &Directory,
    label: &Path,
    server: Option<Server>,
    lock: Arc<WriterLock>,
    adding: bool,
) -> Result<(Core, Option<String>)> {
    // Before the open, which adds a table the store lacks.
    lock.refuse_unless_writer()?;
    let reason = match Core::open_claimed(state, label, server.clone(), Arc::clone(&lock)) {
        Ok(core) => return Ok((core, None)),
        Err(CoreError::WrongSchema {
            reason,
            unsent: Some(0),
            folder: Some(folder),
            ..
        }) if folder == FolderStore::Replaceable || (adding && folder == FolderStore::Unnamed) => {
            reason
        }
        Err(error) => return Err(error),
    };
    store::replace_folder_store(state, label, carried)?;
    let core = Core::open_claimed(state, label, server, lock)?;
    Ok((core, Some(reason)))
}

/// Whether the folder's store lacks a table this build makes, which the
/// folder's writer adds on open.
pub(super) fn lacks_table(state: &Directory) -> bool {
    crate::directory_vfs::DirectoryVfs::new(state.file())
        .and_then(|vfs| store::folder_store_lacks_table(&vfs))
        .unwrap_or(false)
}

/// The origin the folder's store was hydrated from and whether its first
/// sync waits, read from a store this build refuses `wrong_schema` while it
/// holds nothing unsent, which the folder's writer replaces on open, or from
/// one that lacks a table the writer adds.
pub(super) fn recorded(state: &Directory) -> Result<(Option<String>, bool)> {
    let vfs = crate::directory_vfs::DirectoryVfs::new(state.file())?;
    let mut held =
        store::refused_folder_meta(&vfs, &[store::META_SERVER_ORIGIN, first::META_FIRST_SYNC])?;
    Ok((
        held.remove(store::META_SERVER_ORIGIN),
        held.contains_key(first::META_FIRST_SYNC),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::super::{Folder, STATE_DIR, settings_file, state};
    use crate::{Core, CoreError, FolderStore, store};

    const FOLDER: &str = "01a00000-0000-7000-8000-000000000001";
    const ORIGIN: &str = "https://marfa.example";

    /// What the folder records of its files, in each table a replacement
    /// carries, and a list it keeps in its meta.
    const RECORD: &str = "
        INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, writes, seen_at)
          VALUES ('Note.md', 'note', 'h', '[]', '[]', '{\"save\":2,\"queued\":[],\"refused\":[]}', '2026-01-01T00:00:00Z');
        INSERT INTO folder_journal (path, item_id, missing_since, kept)
          VALUES ('Gone.md', 'gone', '2026-01-01T00:00:00Z', 'arriving');
        INSERT INTO folder_stats (path, stat) VALUES ('Note.md', '12:34');
        INSERT INTO pins (item_id) VALUES ('note'), ('gone');
        INSERT INTO meta (key, value) VALUES ('folder_paused_disk', '[\"Gone.md\"]');
    ";

    /// A folder whose store another build of the core made: a column this
    /// build does not make. `bound` names the folder in it, and `sql` runs
    /// on it before it is given the column.
    fn refused_folder(bound: bool, sql: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let path = state.join(store::FOLDER_STORE);
        let core = Core::open(&path, None).unwrap();
        store::meta_set(&core.conn().unwrap(), store::META_SERVER_ORIGIN, ORIGIN).unwrap();
        if bound {
            settings_file::bind(&core, FOLDER).unwrap();
        }
        drop(core);
        if bound {
            Folder::open(dir.path(), None)
                .unwrap()
                .wait_for_confirmation()
                .unwrap();
        }
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(sql).unwrap();
        conn.execute_batch("ALTER TABLE items ADD COLUMN stray TEXT")
            .unwrap();
        (dir, path)
    }

    fn read(path: &Path, sql: &str) -> Vec<String> {
        let conn =
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut statement = conn.prepare(sql).unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// Every row the folder records of its files, as text.
    fn recorded(path: &Path) -> Vec<String> {
        [
            "SELECT path || ' ' || item_id || ' ' || writes FROM folder_files",
            "SELECT path || ' ' || item_id || ' ' || kept FROM folder_journal",
            "SELECT path || ' ' || stat FROM folder_stats",
            "SELECT item_id FROM pins ORDER BY item_id",
            "SELECT value FROM meta WHERE key = 'folder_paused_disk'",
        ]
        .into_iter()
        .flat_map(|sql| read(path, sql))
        .collect()
    }

    fn stray(path: &Path) -> bool {
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap()
            .prepare("SELECT stray FROM items")
            .is_ok()
    }

    fn made_left(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir.join(STATE_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(store::FOLDER_STORE_MADE))
            .collect()
    }

    #[test]
    fn a_folder_store_holding_nothing_unsent_is_replaced_keeping_what_the_folder_records() {
        let (dir, path) = refused_folder(true, RECORD);
        let record = recorded(&path);
        assert_eq!(record.len(), 6, "{record:?}");
        // The witness: this build refuses the store as it is.
        assert!(matches!(
            Core::open(&path, None),
            Err(CoreError::WrongSchema {
                unsent: Some(0),
                ..
            })
        ));

        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(
            folder
                .replaced_store()
                .is_some_and(|reason| reason.contains("items")),
            "{:?}",
            folder.replaced_store()
        );
        assert_eq!(folder.folder_id(), FOLDER);
        assert!(
            folder.awaiting_confirmation().unwrap(),
            "the first sync's wait was dropped"
        );
        assert_eq!(
            store::meta_get(&folder.core().conn().unwrap(), store::META_SERVER_ORIGIN).unwrap(),
            Some(ORIGIN.to_string())
        );
        drop(folder);
        assert!(!stray(&path), "the store another build made was kept");
        assert_eq!(recorded(&path), record, "the folder's record was not kept");
        assert!(made_left(dir.path()).is_empty());
        assert!(
            Folder::open(dir.path(), None)
                .unwrap()
                .replaced_store()
                .is_none(),
            "a store this build made was replaced"
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_folder_store_that_cannot_be_made_leaves_the_refused_one_where_it_was() {
        let (dir, path) = refused_folder(true, RECORD);
        let failed = {
            let _fault = crate::fault::fail_on_this_thread("replace-refused-make");
            Folder::open(dir.path(), None)
        };
        assert!(
            matches!(&failed, Err(CoreError::Store(reason)) if reason.contains("cannot be replaced")),
            "{:?}",
            failed.err()
        );
        assert!(stray(&path), "the refused store was not left where it was");
        assert!(
            made_left(dir.path()).is_empty(),
            "{:?}",
            made_left(dir.path())
        );
        assert!(
            Folder::open(dir.path(), None)
                .unwrap()
                .replaced_store()
                .is_some()
        );
    }

    #[test]
    fn a_refused_store_that_names_no_folder_is_left_alone_and_promises_no_replacement() {
        let (dir, path) = refused_folder(false, "");
        let before = std::fs::read(&path).unwrap();
        let refused = Folder::open(dir.path(), None).err().unwrap();
        assert!(
            matches!(
                &refused,
                CoreError::WrongSchema {
                    unsent: Some(0),
                    folder: Some(FolderStore::Unnamed),
                    ..
                }
            ),
            "{refused:?}"
        );
        let said = refused.to_string();
        assert!(!said.contains("next push"), "{said}");
        assert!(said.contains("marfa folders add"), "{said}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(stray(&path));
    }

    #[test]
    fn a_refused_store_whose_record_of_its_files_is_of_another_shape_is_left_alone() {
        let (dir, path) = refused_folder(
            true,
            &format!("{RECORD} ALTER TABLE folder_journal ADD COLUMN since_build TEXT;"),
        );
        let before = std::fs::read(&path).unwrap();
        let refused = Folder::open(dir.path(), None).err().unwrap();
        assert!(
            matches!(
                &refused,
                CoreError::WrongSchema {
                    unsent: Some(0),
                    folder: Some(FolderStore::Uncarried(table)),
                    ..
                } if table == "folder_journal"
            ),
            "{refused:?}"
        );
        let said = refused.to_string();
        assert!(!said.contains("next push"), "{said}");
        assert!(said.contains("marfa folders remove"), "{said}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    /// A file's state waiting on the answer of the write `id`, which the
    /// server took, and the write in the queue.
    fn answered_waited_on(id: &str, queued: bool) -> String {
        let mut sql = format!(
            "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, writes, seen_at)
               VALUES ('Note.md', 'note', 'h', '[]', '[]', '{{\"save\":1,\"queued\":[{{\"id\":\"{id}\",\"save\":1}}],\"refused\":[]}}', '2026-01-01T00:00:00Z');"
        );
        if queued {
            sql.push_str(&format!(
                "INSERT INTO queue (id, kind, item_id, idempotency_key, payload, depends_on, verdict, queued_at, answered_at)
                   VALUES ('{id}', 'update_item', 'note', '{id}', '{{}}', '[]', 'accepted', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z');"
            ));
        }
        sql
    }

    #[test]
    fn a_refused_store_with_an_answer_a_file_still_waits_on_is_left_alone() {
        let (dir, path) = refused_folder(true, &answered_waited_on("waited", true));
        let before = std::fs::read(&path).unwrap();
        let refused = Folder::open(dir.path(), None).err().unwrap();
        assert!(
            matches!(
                &refused,
                CoreError::WrongSchema {
                    unsent: Some(1),
                    folder: Some(FolderStore::Replaceable),
                    ..
                }
            ),
            "{refused:?}"
        );
        assert!(refused.to_string().contains("marfa folders push"));
        assert_eq!(std::fs::read(&path).unwrap(), before);

        // The witness: the same store whose queue no longer holds the write
        // is replaced, the file's state carried as it was.
        let (dir, path) = refused_folder(true, &answered_waited_on("waited", false));
        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(folder.replaced_store().is_some());
        drop(folder);
        assert_eq!(
            read(&path, "SELECT writes FROM folder_files"),
            ["{\"save\":1,\"queued\":[{\"id\":\"waited\",\"save\":1}],\"refused\":[]}"]
        );
    }

    /// A write the server refused that the folder has recorded against its
    /// file, as a file held after its item went to the bin is, stays in the
    /// queue until a person discards it, which no folder asks for.
    fn recorded_refusal(verdict: &str) -> String {
        format!(
            "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, writes, seen_at)
               VALUES ('Note.md', 'note', 'h', '[]', '[]', '{{\"save\":2,\"queued\":[],\"refused\":[{{\"change\":\"edit\",\"save\":2,\"reason\":\"item_not_found\"}}]}}', '2026-01-01T00:00:00Z');
             INSERT INTO queue (id, kind, item_id, idempotency_key, payload, depends_on, verdict, queued_at, answered_at)
               VALUES ('edit', 'update_item', 'note', 'edit', '{{}}', '[]', '{verdict}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z');"
        )
    }

    /// A write in the queue answered `verdict`, of `kind` to the item `note`
    /// unless `extra` names another, with the columns and payload `extra`
    /// names.
    fn answered(id: &str, kind: &str, verdict: &str, extra: &[(&str, &str)]) -> String {
        let mut columns = vec!["id", "kind", "item_id", "idempotency_key", "depends_on"];
        let mut values = vec![
            format!("'{id}'"),
            format!("'{kind}'"),
            "'note'".to_string(),
            format!("'{id}'"),
            "'[]'".to_string(),
        ];
        let mut payload = "{}".to_string();
        for (column, value) in extra {
            if *column == "payload" {
                payload = (*value).to_string();
            } else if *column == "item_id" {
                values[2] = format!("'{value}'");
            } else {
                columns.push(column);
                values.push(format!("'{value}'"));
            }
        }
        format!(
            "INSERT INTO queue ({}, payload, verdict, queued_at, answered_at)
               VALUES ({}, '{payload}', '{verdict}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z');",
            columns.join(", "),
            values.join(", ")
        )
    }

    /// The file `Note.md`, bound to the item `note`, recording `refused`.
    fn bound_recording(refused: &[state::Refused]) -> String {
        let writes = state::Writes {
            save: 2,
            refused: refused.to_vec(),
            ..Default::default()
        };
        format!(
            "INSERT INTO folder_files (path, item_id, content_hash, links, edge_lines, writes, seen_at)
               VALUES ('Note.md', 'note', 'h', '[]', '[]', '{}', '2026-01-01T00:00:00Z');",
            serde_json::to_string(&writes).unwrap()
        )
    }

    fn refused_with(dir: &Path) -> CoreError {
        Folder::open(dir, None)
            .err()
            .expect("the store was replaced")
    }

    fn unsent_of(error: &CoreError) -> Option<u64> {
        match error {
            CoreError::WrongSchema { unsent, .. } => *unsent,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_refused_or_dead_write_the_folder_has_not_recorded_keeps_its_store_refused() {
        // A dead write may yet have landed, and no file records a delete, a
        // restore or a metadata write: nothing but the queue holds them.
        for (kind, verdict, extra) in [
            ("delete_item", "dead", vec![]),
            ("delete_item", "refused", vec![]),
            ("restore_item", "refused", vec![]),
            ("update_item", "dead", vec![]),
            ("add_tag", "dead", vec![("tag", "kept")]),
            ("replace_metadata", "refused", vec![]),
        ] {
            let row = answered("unrecorded", kind, verdict, &extra);
            let (dir, path) = refused_folder(true, &format!("{RECORD} {row}"));
            let before = std::fs::read(&path).unwrap();
            let refused = refused_with(dir.path());
            assert_eq!(
                unsent_of(&refused),
                Some(1),
                "{kind} {verdict}: {refused:?}"
            );
            assert!(
                refused.to_string().contains("marfa folders remove"),
                "{refused}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), before, "{kind} {verdict}");

            // The witness: the same write taken by the server is replaced.
            let row = answered("taken", kind, "accepted", &extra);
            let (dir, _) = refused_folder(true, &format!("{RECORD} {row}"));
            assert!(
                Folder::open(dir.path(), None)
                    .unwrap()
                    .replaced_store()
                    .is_some(),
                "{kind}"
            );
        }
    }

    #[test]
    fn a_refused_write_to_an_item_a_file_is_bound_to_does_not_keep_its_store_refused() {
        let line = state::Line {
            edge_type: "references".into(),
            end: crate::catalog::End::Source,
            other: "other".into(),
        };
        let edge = "{\"edge_type\":\"references\",\"source_id\":\"note\",\"target_id\":\"other\"}";
        let to_note =
            "{\"edge_type\":\"references\",\"source_id\":\"other\",\"target_id\":\"note\"}";
        for (kind, extra) in [
            ("update_item", vec![]),
            ("add_tag", vec![("tag", "kept")]),
            ("remove_tag", vec![("tag", "kept")]),
            (
                "transition_item",
                vec![("payload", "{\"state\":\"archived\"}")],
            ),
            (
                "create_edge",
                vec![("target_id", "other"), ("payload", edge)],
            ),
            (
                "create_edge",
                vec![
                    ("item_id", "other"),
                    ("target_id", "note"),
                    ("payload", to_note),
                ],
            ),
            (
                "delete_edge",
                vec![("target_id", "other"), ("payload", edge)],
            ),
            (
                "update_edge",
                vec![
                    ("target_id", "was"),
                    ("edge_id", "e"),
                    ("payload", "{\"target_id\":\"other\"}"),
                ],
            ),
        ] {
            let row = answered("refused", kind, "refused", &extra);
            // Recorded against the file, and cleared from it once a later
            // save was taken.
            let recorded = state::Refused {
                change: state::Change::Edge {
                    line: line.clone(),
                    shown: true,
                },
                save: 2,
                reason: "validation_error".into(),
            };
            for record in [vec![recorded], vec![]] {
                let (dir, _) = refused_folder(true, &format!("{} {row}", bound_recording(&record)));
                assert!(
                    Folder::open(dir.path(), None)
                        .map(|folder| folder.replaced_store().is_some())
                        .unwrap_or_else(|error| panic!("{kind} {extra:?}: {error:?}")),
                    "{kind} {extra:?}"
                );
            }

            // The witness: no file is bound to either end, so the refusal is
            // the queue's alone.
            let (dir, _) = refused_folder(true, &row);
            assert_eq!(
                unsent_of(&refused_with(dir.path())),
                Some(1),
                "{kind} {extra:?}"
            );
        }
    }

    #[test]
    fn a_refusal_a_later_accepted_save_cleared_does_not_keep_its_store_refused() {
        // A save the server took after a refused one clears the file's record
        // of the refusal, and the refused write stays in the queue.
        let refused = answered("refused", "update_item", "refused", &[("sent", "1")]);
        let accepted = answered("accepted", "update_item", "accepted", &[("sent", "1")]);
        let (dir, path) = refused_folder(true, &format!("{RECORD} {refused} {accepted}"));
        let record = recorded(&path);
        let folder = Folder::open(dir.path(), None)
            .unwrap_or_else(|error| panic!("the store was left: {error:?}"));
        assert!(folder.replaced_store().is_some());
        drop(folder);
        assert_eq!(recorded(&path), record);

        // The witness: the same refusal of an item no file is bound to is the
        // queue's alone.
        let refused = answered(
            "refused",
            "update_item",
            "refused",
            &[("sent", "1"), ("item_id", "unbound")],
        );
        let (dir, _) = refused_folder(true, &format!("{RECORD} {refused} {accepted}"));
        assert_eq!(unsent_of(&refused_with(dir.path())), Some(1));
    }

    #[test]
    fn a_placement_refusal_of_a_bound_file_does_not_keep_its_store_refused() {
        let placement = |item: &str| {
            answered(
                "placed",
                "create_edge",
                "refused",
                &[
                    ("item_id", item),
                    ("target_id", FOLDER),
                    (
                        "payload",
                        "{\"edge_type\":\"in-folder\",\"properties\":{\"path\":\"Note.md\"}}",
                    ),
                ],
            )
        };
        let record = "INSERT INTO meta (key, value) VALUES ('folder_placements_refused',
            '{\"key\":null,\"settings\":1,\"placements\":{\"note\":{\"path\":\"Note.md\",\"at\":null}}}');";
        // Recorded as a refused placement, and as one made over another
        // machine's, which the folder records nowhere.
        for recorded in [record, ""] {
            let (dir, path) =
                refused_folder(true, &format!("{RECORD} {} {recorded}", placement("note")));
            assert!(
                Folder::open(dir.path(), None)
                    .unwrap()
                    .replaced_store()
                    .is_some()
            );
            assert_eq!(
                read(
                    &path,
                    "SELECT value FROM meta WHERE key = 'folder_placements_refused'"
                )
                .len(),
                usize::from(!recorded.is_empty())
            );
        }

        // The witness: a placement of an item no file is bound to.
        let (dir, _) = refused_folder(true, &format!("{RECORD} {}", placement("unbound")));
        assert_eq!(unsent_of(&refused_with(dir.path())), Some(1));
    }

    #[test]
    fn a_replaced_store_keeps_the_purge_of_a_bound_item() {
        let purged = "INSERT INTO meta (key, value) VALUES ('purged_pin/note', 'true');";
        let (dir, path) = refused_folder(true, &format!("{RECORD} {purged}"));
        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(folder.replaced_store().is_some());
        assert!(store::purged(&folder.core().conn().unwrap(), "note").unwrap());
        drop(folder);
        assert_eq!(
            read(&path, "SELECT key FROM meta WHERE key LIKE 'purged_pin/%'"),
            ["purged_pin/note"]
        );
    }

    #[test]
    fn a_refusal_the_folder_has_recorded_does_not_keep_its_store_refused() {
        let (dir, path) = refused_folder(true, &recorded_refusal("refused"));
        let record = read(&path, "SELECT writes FROM folder_files");
        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(folder.replaced_store().is_some());
        drop(folder);
        assert_eq!(read(&path, "SELECT writes FROM folder_files"), record);

        // The witness: a write still to be sent keeps it refused.
        let (dir, _) = refused_folder(true, &recorded_refusal("blocked"));
        let refused = Folder::open(dir.path(), None).err().unwrap();
        assert!(
            matches!(
                &refused,
                CoreError::WrongSchema {
                    unsent: Some(1),
                    ..
                }
            ),
            "{refused:?}"
        );
    }
}
