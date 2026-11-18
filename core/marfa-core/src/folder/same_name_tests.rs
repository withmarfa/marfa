//! Of items whose names compare as one, the one created later takes the
//! numbered name, whatever order the copy lists them in, and a file already
//! at a name keeps it.

use serde_json::json;

use super::tests::folder_with;
use super::*;
use crate::store::{self, meta_set};

const PAIRS: [(&str, &str); 3] = [("ΟΔΟΣ", "οδος"), ("Straße", "STRASSE"), ("ſtar", "Star")];

/// Ids that sort in the order the items are made, as a UUIDv7 does.
fn id(n: u32) -> String {
    format!("01a00000-0000-7000-8000-{n:012}")
}

fn at(second: u32) -> String {
    format!("2026-01-01T00:00:{second:02}.000Z")
}

struct Pulling {
    dir: tempfile::TempDir,
    folder: Folder,
    _registry: registry::tests::OwnRegistry,
}

fn pulling() -> Pulling {
    let (_, registry) = registry::tests::own_registry();
    let (dir, folder) = folder_with(&id(1), json!({ "query": {} }), None);
    {
        let conn = folder.core.conn().unwrap();
        meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
        meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }
    Pulling {
        dir,
        folder,
        _registry: registry,
    }
}

impl Pulling {
    /// A note the server holds, made at `second` past the minute.
    fn arrives(&self, n: u32, title: &str, second: u32) -> String {
        let conn = self.folder.core.conn().unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        let note = store::testing::note(&id(n), title, "words", &at(second));
        crate::reach::set_listed(&conn, &id(n), true).unwrap();
        store::put_server_item(&conn, &note, None, &catalog).unwrap();
        id(n)
    }

    /// The file an item's note was written to.
    fn file_of(&self, n: u32) -> String {
        let conn = self.folder.core.conn().unwrap();
        let bound = state::bound_to_item(&conn, &id(n))
            .unwrap()
            .unwrap_or_else(|| panic!("item {n} has no file"));
        assert!(
            self.dir.path().join(&bound.path).is_file(),
            "{} is not on disk",
            bound.path
        );
        bound.path
    }

    fn pull(&self) -> PullReport {
        self.folder.pull().unwrap()
    }
}

#[test]
fn of_two_notes_made_in_either_order_the_later_takes_the_numbered_name_on_a_first_sync() {
    for (first, second) in PAIRS {
        for (older, newer) in [(first, second), (second, first)] {
            // Both listing orders: the older item arrives first, then last.
            for older_arrives_first in [true, false] {
                let folder = pulling();
                let arrivals = [(2, older, 10), (3, newer, 20)];
                for (n, title, second) in if older_arrives_first {
                    arrivals.to_vec()
                } else {
                    arrivals.iter().rev().copied().collect()
                } {
                    folder.arrives(n, title, second);
                }
                let pulled = folder.pull();
                assert_eq!(pulled.beside, 1, "{older}/{newer}: {pulled:?}");
                assert_eq!(
                    folder.file_of(2),
                    format!("{older}.md"),
                    "{older} was made before {newer} and takes the plain name"
                );
                assert_eq!(
                    folder.file_of(3),
                    format!("{newer} (2).md"),
                    "{newer} was made after {older} and takes the number"
                );
            }
        }
    }
}

#[test]
fn notes_made_at_one_time_are_ordered_by_id() {
    for ids in [[2, 3], [3, 2]] {
        let folder = pulling();
        for n in ids {
            folder.arrives(n, "Plan", 10);
        }
        folder.pull();
        assert_eq!(folder.file_of(2), "Plan.md");
        assert_eq!(folder.file_of(3), "Plan (2).md");
    }
}

#[test]
fn a_later_note_arriving_beside_a_written_one_leaves_it_where_it_is() {
    for (older, newer) in PAIRS {
        let folder = pulling();
        folder.arrives(2, older, 10);
        folder.pull();
        let before = std::fs::read(folder.dir.path().join(folder.file_of(2))).unwrap();
        folder.arrives(3, newer, 20);
        let pulled = folder.pull();
        assert_eq!((pulled.moved, pulled.beside), (0, 1), "{pulled:?}");
        assert_eq!(folder.file_of(2), format!("{older}.md"));
        assert_eq!(folder.file_of(3), format!("{newer} (2).md"));
        assert_eq!(
            std::fs::read(folder.dir.path().join(folder.file_of(2))).unwrap(),
            before
        );
    }
}

#[test]
fn an_earlier_note_arriving_beside_a_written_one_takes_the_number_and_moves_nothing() {
    for (older, newer) in PAIRS {
        let folder = pulling();
        folder.arrives(3, newer, 20);
        folder.pull();
        assert_eq!(folder.file_of(3), format!("{newer}.md"));
        folder.arrives(2, older, 10);
        let pulled = folder.pull();
        assert_eq!((pulled.moved, pulled.beside), (0, 1), "{pulled:?}");
        assert_eq!(
            folder.file_of(3),
            format!("{newer}.md"),
            "a file already at the name keeps it, though an earlier note arrived"
        );
        assert_eq!(folder.file_of(2), format!("{older} (2).md"));
    }
}

#[test]
fn three_notes_with_one_name_are_numbered_in_the_order_they_were_made() {
    let made = [(2, 10), (3, 20), (4, 30)];
    for arrival in [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]] {
        let folder = pulling();
        for at in arrival {
            let (n, second) = made[at];
            folder.arrives(n, "Plan", second);
        }
        let pulled = folder.pull();
        assert_eq!(pulled.beside, 2, "{arrival:?}: {pulled:?}");
        assert_eq!(folder.file_of(2), "Plan.md", "{arrival:?}");
        assert_eq!(folder.file_of(3), "Plan (2).md", "{arrival:?}");
        assert_eq!(folder.file_of(4), "Plan (3).md", "{arrival:?}");
    }
}

#[test]
fn of_three_notes_the_written_one_keeps_the_plain_name_and_the_others_follow_in_order() {
    for arrival in [[2, 4], [4, 2]] {
        let folder = pulling();
        folder.arrives(3, "Plan", 20);
        folder.pull();
        for n in arrival {
            folder.arrives(n, "plan", n * 5);
        }
        folder.pull();
        assert_eq!(folder.file_of(3), "Plan.md", "{arrival:?}");
        assert_eq!(folder.file_of(2), "plan (2).md", "{arrival:?}");
        assert_eq!(folder.file_of(4), "plan (3).md", "{arrival:?}");
    }
}
