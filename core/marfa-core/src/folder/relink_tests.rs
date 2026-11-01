//! A body link to an item retitled since it was written is rewritten in the
//! folder's file to name the item by its new title
//! (`folders/body-link-retitled`).

use super::tests::{ScannedDir, scanned_folder};
use super::*;
use crate::store::{self, testing};

const TARGET: &str = "01a00000-0000-7000-8000-000000024371";
const HOST: &str = "01a00000-0000-7000-8000-000000024372";
const NAMESAKE: &str = "01a00000-0000-7000-8000-000000024373";
const BODY: &str = "See [[Old]], [[Old|the plan]] and [[Old#Steps]].\n\n`[[Old]]` stays.\n";

/// A synced folder holding `Old` and a note whose body links to it three
/// ways, both written out by a pull.
fn linked_folder() -> (ScannedDir, Folder) {
    let (dir, folder) = scanned_folder();
    {
        let conn = folder.core.conn().unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
        let catalog = Catalog::load(&conn).unwrap();
        let at = "2026-01-01T00:00:00Z";
        store::put_server_item(&conn, &testing::note(TARGET, "Old", "", at), None, &catalog)
            .unwrap();
        store::put_server_item(
            &conn,
            &testing::note(HOST, "Host", BODY, at),
            None,
            &catalog,
        )
        .unwrap();
        store::put_server_edge(
            &conn,
            &testing::wire_edge("references-old", HOST, TARGET, LINK_EDGE),
        )
        .unwrap();
        // Placed already, so the pull queues no placement of its own.
        let folder_id = "01a00000-0000-7000-8000-000000000001";
        for (id, path) in [(TARGET, "Old.md"), (HOST, "Host.md")] {
            let mut edge =
                testing::wire_edge(&format!("placed-{id}"), id, folder_id, PLACEMENT_EDGE);
            edge.properties.insert("path".into(), path.into());
            store::put_server_edge(&conn, &edge).unwrap();
        }
    }
    drop(folder);
    let folder = Folder::open(dir.path(), None).unwrap();
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.written, 2, "{pulled:?}");
    assert_eq!(read(&dir, "Host.md").matches("[[Old").count(), 4);
    (dir, folder)
}

/// Another device retitles `id`, and this copy hears it.
fn retitle(folder: &Folder, id: &str, title: &str, version: i64) {
    let conn = folder.core.conn().unwrap();
    let catalog = Catalog::load(&conn).unwrap();
    let mut item = testing::note(id, title, "", "2026-01-01T00:00:00Z");
    item.version = version;
    item.updated_at = format!("2026-01-0{version}T00:00:00Z");
    store::put_server_item(&conn, &item, None, &catalog).unwrap();
}

fn read(dir: &ScannedDir, path: &str) -> String {
    std::fs::read_to_string(dir.path().join(path)).unwrap()
}

fn body_of(text: &str) -> &str {
    text.rsplit_once("---\n").map_or(text, |(_, body)| body)
}

/// The body each queued update of `id` sends, with its `version_match`.
fn updates(folder: &Folder, id: &str) -> Vec<(String, Option<String>)> {
    let conn = folder.core.conn().unwrap();
    store::queued_writes(&conn)
        .unwrap()
        .into_iter()
        .filter(|write| {
            write.kind == crate::model::WriteKind::UpdateItem
                && write.item_id.as_deref() == Some(id)
        })
        .map(|write| {
            let sent: Value =
                serde_json::from_str(&store::payload_of(&conn, &write.id).unwrap()).unwrap();
            (
                sent["properties"]["body"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                sent["version_match"].as_str().map(str::to_string),
            )
        })
        .collect()
}

#[test]
fn a_link_to_a_retitled_item_names_it_by_its_new_title() {
    let (dir, folder) = linked_folder();
    retitle(&folder, TARGET, "New", 2);
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.relinked, 1, "{pulled:?}");
    let rewritten = "See [[New]], [[New|the plan]] and [[New#Steps]].\n\n`[[Old]]` stays.\n";
    assert_eq!(body_of(&read(&dir, "Host.md")), rewritten);
    // Its own file followed the title.
    assert!(dir.path().join("New.md").exists());
    // No frontmatter line stands in for a link that names the item still.
    assert!(
        !read(&dir, "Host.md").contains("references"),
        "{}",
        read(&dir, "Host.md")
    );
    assert_eq!(
        updates(&folder, HOST),
        [(rewritten.to_string(), Some("exact".to_string()))]
    );

    // Settled, the folder neither writes the file nor sends anything again.
    let scanned = folder.scan().unwrap();
    assert_eq!(scanned.updated, 0, "{scanned:?}");
    let again = folder.pull().unwrap();
    assert_eq!(again.relinked, 0, "{again:?}");
    assert_eq!(updates(&folder, HOST).len(), 1);
}

#[test]
fn a_title_another_item_answers_to_names_the_item_by_its_id() {
    let (dir, folder) = linked_folder();
    {
        let conn = folder.core.conn().unwrap();
        let catalog = Catalog::load(&conn).unwrap();
        store::put_server_item(
            &conn,
            &testing::note(NAMESAKE, "New", "", "2026-01-01T00:00:00Z"),
            None,
            &catalog,
        )
        .unwrap();
    }
    folder.pull().unwrap();
    retitle(&folder, TARGET, "New", 2);
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.relinked, 1, "{pulled:?}");
    assert_eq!(
        body_of(&read(&dir, "Host.md")),
        format!(
            "See [[{TARGET}|Old]], [[{TARGET}|the plan]] and [[{TARGET}#Steps|Old]].\n\n`[[Old]]` stays.\n"
        )
    );
}

#[test]
fn bytes_the_person_changed_are_kept_and_their_links_wait_for_their_answer() {
    let (dir, folder) = linked_folder();
    let edited = read(&dir, "Host.md").replace("stays.", "stays, edited.");
    std::fs::write(dir.path().join("Host.md"), &edited).unwrap();
    retitle(&folder, TARGET, "New", 2);
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.relinked, 0, "{pulled:?}");
    assert_eq!(read(&dir, "Host.md"), edited);
    assert!(updates(&folder, HOST).is_empty());

    // Once sent, the edit waits for its answer, and the link with it.
    let scanned = folder.scan().unwrap();
    assert_eq!(scanned.updated, 1, "{scanned:?}");
    assert_eq!(folder.pull().unwrap().relinked, 0);
    assert_eq!(updates(&folder, HOST).len(), 1);
}

#[test]
fn a_retitle_this_copy_has_not_heard_the_server_take_rewrites_nothing() {
    let (dir, folder) = linked_folder();
    let old = read(&dir, "Old.md");
    std::fs::write(
        dir.path().join("Old.md"),
        old.replace("title: Old", "title: New"),
    )
    .unwrap();
    let scanned = folder.scan().unwrap();
    assert_eq!(scanned.updated, 1, "{scanned:?}");
    let pulled = folder.pull().unwrap();
    assert_eq!(pulled.relinked, 0, "{pulled:?}");
    assert_eq!(body_of(&read(&dir, "Host.md")), BODY);
}
