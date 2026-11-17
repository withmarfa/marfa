use super::testing::*;
use super::*;
use marfa_rules::search::FtsText;
use serde_json::json;

#[test]
fn statement_journals_are_held_in_memory_only_while_a_page_is_written() {
    let temp = tempfile::tempdir().unwrap();
    let mut conn = super::open(&temp.path().join("core.sqlite")).unwrap();
    let read = |conn: &rusqlite::Connection| {
        conn.query_row("PRAGMA temp_store", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    let (default, memory) = (0, 2);
    assert_eq!(read(&conn), default);
    let inside = super::with_journals_in_memory(&mut conn, |tx| Ok(read(tx))).unwrap();
    assert_eq!(inside, memory);
    assert_eq!(read(&conn), default);
    let failed = super::with_journals_in_memory(&mut conn, |tx| {
        assert_eq!(read(tx), memory);
        Err::<(), _>(super::CoreError::Canceled)
    });
    assert!(matches!(failed, Err(super::CoreError::Canceled)));
    assert_eq!(
        read(&conn),
        default,
        "a failed write left journals in memory"
    );
}

fn indexed(conn: &rusqlite::Connection, word: &str) -> Vec<String> {
    conn.prepare(
        "SELECT items.id FROM items_fts JOIN items ON items.seq = items_fts.rowid
             WHERE items_fts MATCH ?1 ORDER BY items.id",
    )
    .unwrap()
    .query_map([word], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

#[test]
fn a_page_write_indexes_the_rows_it_wrote_once_it_has_written_all_of_them() {
    let mut conn = conn();
    let note = |id: &str, state: &str, title: &str| {
        wire_item(
            id,
            "core.note",
            state,
            "2026-01-01T00:00:00Z",
            json!({ "title": title }),
        )
    };
    let indexing = Indexing::default();
    upsert_item(&conn, &note("a", "active", "alpha"), None, &indexing).unwrap();
    assert_eq!(indexed(&conn, "alpha"), ["a"], "a write outside a page");
    super::with_page_write(&mut conn, |tx| {
        upsert_item(tx, &note("a", "active", "gamma"), None, &indexing)?;
        upsert_item(tx, &note("b", "active", "gamma"), None, &indexing)?;
        upsert_item(tx, &note("c", "trashed", "gamma"), None, &indexing)?;
        upsert_item(tx, &note("d", "active", "gamma"), None, &indexing)?;
        forget_item(tx, "d")?;
        assert_eq!(
            indexed(tx, "alpha"),
            ["a"],
            "held until the page is written"
        );
        assert!(indexed(tx, "gamma").is_empty());
        Ok(())
    })
    .unwrap();
    assert!(indexed(&conn, "alpha").is_empty());
    assert_eq!(indexed(&conn, "gamma"), ["a", "b"]);
    upsert_item(&conn, &note("e", "active", "delta"), None, &indexing).unwrap();
    assert_eq!(indexed(&conn, "delta"), ["e"], "a write after the page");
}

#[test]
fn a_page_write_that_fails_leaves_nothing_held_for_the_next_write() {
    let mut conn = conn();
    let note = wire_item(
        "a",
        "core.note",
        "active",
        "2026-01-01T00:00:00Z",
        json!({ "title": "alpha" }),
    );
    let failed = super::with_page_write(&mut conn, |tx| {
        upsert_item(tx, &note, None, &Indexing::default())?;
        Err::<(), _>(super::CoreError::Canceled)
    });
    assert!(matches!(failed, Err(super::CoreError::Canceled)));
    assert!(indexed(&conn, "alpha").is_empty());
    upsert_item(&conn, &note, None, &Indexing::default()).unwrap();
    assert_eq!(indexed(&conn, "alpha"), ["a"]);
}

#[test]
fn the_log_may_grow_through_a_hydration_and_is_emptied_after_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("core.sqlite");
    let conn = super::open(&path).unwrap();
    let interval = |conn: &rusqlite::Connection| -> i64 {
        conn.query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .unwrap()
    };
    let kept = interval(&conn);
    assert_eq!(super::lengthen_log_interval(&conn).unwrap(), kept);
    assert!(interval(&conn) > kept);
    for n in 0..3000 {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)",
            params![format!("filler/{n}"), "x".repeat(2000)],
        )
        .unwrap();
    }
    let log = temp.path().join("core.sqlite-wal");
    assert!(
        std::fs::metadata(&log).unwrap().len() > 4_000_000,
        "the log held what was written"
    );
    super::restore_log_interval(&conn, kept).unwrap();
    assert_eq!(interval(&conn), kept);
    assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
}

#[test]
fn a_copy_without_reach_proof_is_unreadable() {
    let conn = testing::conn();
    meta_set(&conn, META_EVENT_CURSOR, "10").unwrap();
    meta_set(&conn, META_SLICE_TYPES, "[\"core.note\"]").unwrap();
    meta_set(&conn, META_SLICE_TIER, "library").unwrap();
    assert!(!hydrated(&conn).unwrap());
    assert!(matches!(
        refuse_unless_hydrated(&conn),
        Err(CoreError::HydrationIncomplete)
    ));
}

#[test]
fn a_changed_catalog_indexes_every_held_row_again() {
    let conn = conn();
    let photo = |cover: &str| {
        let mut wire = wire_type("acme.photo", None, None);
        wire.rest.insert(
            "fields".into(),
            json!({ "cover": { "type": cover, "searchable": cover == "string" } }),
        );
        wire
    };
    replace_types(&conn, &[photo("string")]).unwrap();
    let properties = json!({
        "title": "Holiday",
        "cover": "unicornsXYZ",
        "undeclared": "narwhalsABC",
    });
    let indexing = crate::catalog::load(&conn).unwrap().indexing("acme.photo");
    for (id, state) in [("held", "active"), ("binned", "trashed")] {
        let row = wire_item(
            id,
            "acme.photo",
            state,
            "2026-01-01T00:00:00Z",
            properties.clone(),
        );
        upsert_item(&conn, &row, Some(&["summer".into()]), &indexing).unwrap();
    }
    let entry = |id: &str| -> Option<(String, String)> {
        conn.query_row(
            "SELECT extra, tags FROM items_fts WHERE rowid = (SELECT seq FROM items WHERE id = ?1)",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap()
    };
    let (extra, tags) = entry("held").expect("the held row has no entry");
    assert_eq!(
        extra, "unicornsXYZ",
        "a declared string is indexed, an undeclared one is not"
    );
    assert_eq!(tags, "summer");
    assert_eq!(entry("binned"), None);

    replace_types(&conn, &[photo("thumbnail")]).unwrap();
    let (extra, tags) = entry("held").expect("the catalog changed and the held row lost its entry");
    assert_eq!(
        extra, "",
        "the type no longer declares a string there and the entry still holds it"
    );
    assert_eq!(
        tags, "summer",
        "the entry written again dropped the row's tags"
    );
    assert_eq!(
        entry("binned"),
        None,
        "the entry written again put a row in the bin into the index"
    );
}

#[test]
fn reindex_contains_malformed_properties() {
    check_unreadable_reindex(r#"{"title":"#);
}

#[test]
fn reindex_contains_nonobject_properties() {
    for damaged in ["[1]", "null", "7", "true", r#""text""#] {
        check_unreadable_reindex(damaged);
    }
}

fn check_unreadable_reindex(damaged: &str) {
    let conn = conn();
    let catalog = |cover: &str| {
        let mut ty = wire_type("acme.photo", None, Some("title"));
        ty.rest
            .insert("fields".into(), json!({"cover": {"type": cover}}));
        WireCatalog {
            types: vec![ty],
            edge_types: vec![],
        }
    };
    replace_catalog(&conn, &catalog("string")).unwrap();
    let indexing = crate::catalog::load(&conn).unwrap().indexing("acme.photo");
    for (id, state) in [
        ("damaged", "active"),
        ("healthy", "active"),
        ("binned", "trashed"),
    ] {
        let row = wire_item(
            id,
            "acme.photo",
            state,
            "2026-01-01T00:00:00Z",
            json!({
                "title": "staletitle",
                "body": "stalebody",
                "description": "staledescription",
                "name": "stalename",
                "cover": "stalecover",
            }),
        );
        upsert_item(&conn, &row, Some(&["genuinetag".into()]), &indexing).unwrap();
    }
    let matches = |query: &str| -> Vec<String> {
        conn.prepare(
            "SELECT items.id FROM items_fts
                 JOIN items ON items.seq = items_fts.rowid
                 WHERE items_fts MATCH ?1 ORDER BY items.id",
        )
        .unwrap()
        .query_map([query], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    };
    for query in [
        "staletitle",
        "stalebody",
        "staledescription",
        "stalename",
        "stalecover",
        "genuinetag",
    ] {
        assert_eq!(matches(query), ["damaged", "healthy"], "{query}");
    }
    conn.execute(
        "UPDATE items SET properties = ?1 WHERE id IN ('damaged', 'binned')",
        [damaged],
    )
    .unwrap();
    assert!(items_by_ids(&conn, &["damaged".into()]).is_err());
    let mut unreadable = Unreadable::Keep(HashMap::new());
    items_by_ids_with(&conn, &["damaged".into()], &mut unreadable).unwrap();
    let why = unreadable.why("damaged").unwrap();
    let version = catalog_version(&conn).unwrap();

    assert!(
        replace_catalog(&conn, &catalog("thumbnail"))
            .unwrap()
            .is_changed(),
        "{damaged}"
    );

    assert_ne!(catalog_version(&conn).unwrap(), version);
    for query in ["staletitle", "stalebody", "staledescription", "stalename"] {
        assert_eq!(matches(query), ["healthy"], "{damaged}: {query}");
    }
    assert!(
        matches("stalecover").is_empty(),
        "the healthy row was not reindexed"
    );
    assert_eq!(matches("genuinetag"), ["damaged", "healthy"]);
    let raw: String = conn
        .query_row(
            "SELECT properties FROM items WHERE id = 'damaged'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, damaged);
    let mut unreadable = Unreadable::Keep(HashMap::new());
    let held = items_by_ids_with(&conn, &["damaged".into()], &mut unreadable).unwrap();
    assert!(held[0].properties.is_empty());
    assert_eq!(unreadable.why("damaged"), Some(why));
    assert!(items_by_ids(&conn, &["damaged".into()]).is_err());
}

#[test]
fn reindex_database_errors_still_roll_back_a_catalog_replacement() {
    let conn = conn();
    let original = WireCatalog {
        types: vec![wire_type("core.note", None, Some("title"))],
        edge_types: vec![],
    };
    replace_catalog(&conn, &original).unwrap();
    upsert_item(
        &conn,
        &note("held", "held", "body", "2026-01-01T00:00:00Z"),
        Some(&[]),
        &Indexing::default(),
    )
    .unwrap();
    let held = type_rows(&conn).unwrap();
    let version = catalog_version(&conn).unwrap();
    let mut changed = original;
    changed.types[0].label = Some("Changed".into());
    conn.execute_batch("DROP TABLE items_fts").unwrap();
    let failure = replace_catalog(&conn, &changed).unwrap_err();
    assert!(matches!(failure, CoreError::Store(_)), "{failure:?}");
    assert_eq!(type_rows(&conn).unwrap(), held);
    assert_eq!(catalog_version(&conn).unwrap(), version);
}

/// A refresh that changes only a type's icon adopts the catalog and moves
/// its version without reindexing a row; any other change reindexes.
#[test]
fn an_icon_only_catalog_change_reindexes_no_row() {
    let conn = conn();
    let original = WireCatalog {
        types: vec![wire_type("core.note", None, Some("title"))],
        edge_types: vec![],
    };
    replace_catalog(&conn, &original).unwrap();
    upsert_item(
        &conn,
        &note("held", "findable", "body", "2026-01-01T00:00:00Z"),
        Some(&[]),
        &Indexing::default(),
    )
    .unwrap();
    // Emptying the index is the witness: a reindex writes the row again.
    let indexed = || -> i64 {
        conn.query_row("SELECT count(*) FROM items_fts", [], |row| row.get(0))
            .unwrap()
    };
    let emptied = || conn.execute("DELETE FROM items_fts", []).unwrap();
    let version = catalog_version(&conn).unwrap();

    let mut icon_only = original.clone();
    icon_only.types[0].display_hints.as_mut().unwrap().icon = Some("lucide:sticky-note".into());
    emptied();
    assert_eq!(
        replace_catalog(&conn, &icon_only).unwrap(),
        CatalogChange::IconsOnly
    );
    assert_eq!(indexed(), 0, "no row was reindexed");
    assert_ne!(catalog_version(&conn).unwrap(), version);
    assert!(
        type_rows(&conn).unwrap()[0]
            .1
            .contains("lucide:sticky-note")
    );

    let mut cleared = icon_only.clone();
    cleared.types[0].display_hints.as_mut().unwrap().icon = None;
    assert_eq!(
        replace_catalog(&conn, &cleared).unwrap(),
        CatalogChange::IconsOnly
    );
    assert_eq!(indexed(), 0, "removing the icon reindexed no row");

    let mut relabelled = icon_only;
    relabelled.types[0].label = Some("Changed".into());
    assert_eq!(
        replace_catalog(&conn, &relabelled).unwrap(),
        CatalogChange::Changed
    );
    assert_eq!(indexed(), 1, "the witness: another change reindexes");
}

/// One answer for one replacement: the hydration that decides whether to
/// resume and the reindex that decides whether to run read the same
/// verdict, so they cannot disagree.
#[test]
fn a_replacement_says_whether_nothing_icons_only_or_more_changed() {
    let conn = conn();
    let original = WireCatalog {
        types: vec![wire_type("core.note", None, Some("title"))],
        edge_types: vec![],
    };
    assert_eq!(
        replace_catalog(&conn, &original).unwrap(),
        CatalogChange::Changed,
        "the first catalog held is a change, not icons only"
    );
    assert_eq!(
        replace_catalog(&conn, &original).unwrap(),
        CatalogChange::Unchanged
    );

    let mut icon_only = original.clone();
    icon_only.types[0].display_hints.as_mut().unwrap().icon = Some("lucide:sticky-note".into());
    assert_eq!(
        replace_catalog(&conn, &icon_only).unwrap(),
        CatalogChange::IconsOnly
    );

    let mut and_label = icon_only.clone();
    and_label.types[0].display_hints.as_mut().unwrap().icon = Some("lucide:star".into());
    and_label.types[0].label = Some("Changed".into());
    assert_eq!(
        replace_catalog(&conn, &and_label).unwrap(),
        CatalogChange::Changed
    );

    let mut icon_and_edge = and_label.clone();
    icon_and_edge.types[0].display_hints.as_mut().unwrap().icon = Some("lucide:moon".into());
    icon_and_edge.edge_types = vec![json!({
        "id": "mentor-of", "from_type_constraints": ["*"],
        "to_type_constraints": ["*"], "cardinality": "many-to-many",
        "cascade_on_delete": "orphan", "property_schema": {},
        "written_from": "from", "shipped": false
    })];
    assert_eq!(
        replace_catalog(&conn, &icon_and_edge).unwrap(),
        CatalogChange::Changed,
        "an icon beside an edge type change is more than icons"
    );

    // A copy's own catalog is replaced by a server's whatever the rows say.
    let local = crate::store::open_in_memory().unwrap();
    hold_local_catalog(&local).unwrap();
    let shipped = marfa_rules::builtin::catalog().unwrap();
    assert_eq!(
        replace_catalog(&local, &shipped).unwrap(),
        CatalogChange::Changed
    );
}

#[test]
fn the_index_holds_tags_in_byte_order_whatever_order_they_were_written_in() {
    let conn = conn();
    let note = note("n1", "Hello", "world", "2026-01-01T00:00:00Z");
    let written: Vec<String> = ["zeta", "alpha", "mid"].map(String::from).into();
    upsert_item(&conn, &note, Some(&written), &Indexing::default()).unwrap();
    let indexed: String = conn
        .query_row(
            "SELECT tags FROM items_fts WHERE rowid = (SELECT seq FROM items WHERE id = 'n1')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, "alpha mid zeta");
}

#[test]
fn the_index_text_is_the_core_four_and_the_declared_strings() {
    let properties = json!({
        "title": "T",
        "body": "B",
        "name": 5,
        "blurb": "X",
        "empty": "",
        "later": "Y",
        "count": 5,
        "undeclared": "Z",
        "nested": { "deep": ["x"] }
    });
    let indexing = Indexing {
        opted_out: vec!["body".into()],
        extra: vec!["blurb".into(), "empty".into(), "later".into()],
    };
    assert_eq!(
        fts_text(properties.as_object().unwrap(), &indexing),
        FtsText {
            title: "T".into(),
            body: String::new(),
            description: String::new(),
            name: String::new(),
            extra: "X Y".into(),
        }
    );
    assert_eq!(
        fts_text(properties.as_object().unwrap(), &Indexing::default()),
        FtsText {
            title: "T".into(),
            body: "B".into(),
            ..FtsText::default()
        }
    );
}
