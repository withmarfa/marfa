//! The server's refusals of an edge write that a copy can reach on its own,
//! judged from the catalog and the rows and edges the copy holds.
//!
//! What the copy does not hold it leaves to the server: an edge type or an
//! item type outside its catalog, a constraint only the part of a type's
//! parent chain it cannot read would decide (a parent outside its catalog,
//! or a chain that loops), an end outside its slice, and a cycle that closes
//! only through edges it does not hold. Those writes are queued, and
//! the server's verdict on them stands.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};

use crate::catalog::{self, EdgeType, Lineage};
use crate::error::CoreError;

type Result<T> = std::result::Result<T, CoreError>;

/// The source of an edge being judged: a row the copy may hold, or the item a
/// create is making, which is not in the copy yet.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Source<'a> {
    Held(&'a str),
    Made { id: &'a str, r#type: &'a str },
}

impl Source<'_> {
    fn id(&self) -> &str {
        match self {
            Source::Held(id) | Source::Made { id, .. } => id,
        }
    }
}

/// An edge as a write would leave it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Proposed<'a> {
    pub edge_type: &'a str,
    pub source: Source<'a>,
    pub target_id: &'a str,
    /// The held edge a move changes, which the cycle walk leaves out.
    pub replacing: Option<&'a str>,
}

/// The edge type, where the copy holds it.
fn held_edge_type(conn: &Connection, id: &str) -> Result<Option<EdgeType>> {
    match catalog::edge_type(conn, id) {
        Ok(edge_type) => Ok(Some(edge_type)),
        Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The type of a held row and whether it is in the bin.
fn held_row(conn: &Connection, id: &str) -> Result<Option<(String, bool)>> {
    let mut statement = conn.prepare_cached("SELECT type, state FROM items WHERE id = ?1")?;
    Ok(statement
        .query_row([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)? == "trashed",
            ))
        })
        .optional()?)
}

fn end_not_found(end: &str, id: &str) -> CoreError {
    CoreError::NotFound {
        code: "item_not_found".into(),
        message: format!("Edge {end} item not found: {id}"),
    }
}

fn refused_end(edge_type: &str, end: &str, r#type: &str) -> CoreError {
    CoreError::Validation {
        code: "edge_constraint_violation".into(),
        message: format!("Edge \"{edge_type}\" does not allow {end} type \"{type}\""),
    }
}

fn refused_nesting(edge_type: &str) -> CoreError {
    CoreError::Validation {
        code: "edge_constraint_violation".into(),
        message: format!(
            "Edge \"{edge_type}\" does not take a source its target constraints admit; use \"parent-of\" for hierarchy"
        ),
    }
}

/// Lineages read once per call, since a retype judges every edge at an item.
#[derive(Default)]
struct Lineages(HashMap<String, Option<Lineage>>);

impl Lineages {
    fn of(&mut self, conn: &Connection, r#type: &str) -> Result<Option<&Lineage>> {
        if !self.0.contains_key(r#type) {
            let lineage = catalog::lineage(conn, r#type)?;
            self.0.insert(r#type.to_string(), lineage);
        }
        Ok(self.0.get(r#type).and_then(Option::as_ref))
    }
}

/// Refuses an edge the server would refuse for its ends or its shape, in the
/// server's order: an end in the bin, an end of a type the edge type does not
/// admit, a source a flat edge type does not take, then a cycle.
pub(crate) fn refuse_unwritable_edge(conn: &Connection, edge: &Proposed) -> Result<()> {
    let Some(edge_type) = held_edge_type(conn, edge.edge_type)? else {
        return Ok(());
    };
    let source_type = match edge.source {
        Source::Made { r#type, .. } => Some(r#type.to_string()),
        Source::Held(id) => match held_row(conn, id)? {
            Some((_, true)) => return Err(end_not_found("source", id)),
            Some((r#type, false)) => Some(r#type),
            None => None,
        },
    };
    let target_type = match held_row(conn, edge.target_id)? {
        Some((_, true)) => return Err(end_not_found("target", edge.target_id)),
        Some((r#type, false)) => Some(r#type),
        None => None,
    };
    let mut lineages = Lineages::default();
    if let Some(r#type) = &source_type
        && let Some(lineage) = lineages.of(conn, r#type)?
        && lineage.admitted_by(&edge_type.source_type_constraints) == Some(false)
    {
        return Err(refused_end(edge.edge_type, "source", r#type));
    }
    if let Some(r#type) = &target_type
        && let Some(lineage) = lineages.of(conn, r#type)?
        && lineage.admitted_by(&edge_type.target_type_constraints) == Some(false)
    {
        return Err(refused_end(edge.edge_type, "target", r#type));
    }
    if edge_type.flat
        && let Some(r#type) = &source_type
        && let Some(lineage) = lineages.of(conn, r#type)?
        && lineage.admitted_by(&edge_type.target_type_constraints) == Some(true)
    {
        return Err(refused_nesting(edge.edge_type));
    }
    if edge_type.acyclic && closes_cycle(conn, edge)? {
        return Err(CoreError::Validation {
            code: "edge_cycle".into(),
            message: format!("Edge \"{}\" would close a cycle", edge.edge_type),
        });
    }
    Ok(())
}

/// Whether the target reaches the source through the held edges of the type,
/// those still waiting to be sent among them.
fn closes_cycle(conn: &Connection, edge: &Proposed) -> Result<bool> {
    let mut statement = conn.prepare_cached(
        "WITH RECURSIVE reached(id) AS (
            SELECT ?1
            UNION
            SELECT e.target_id FROM edges e JOIN reached r ON e.source_id = r.id
             WHERE e.edge_type = ?3 AND e.id IS NOT ?4
         )
         SELECT EXISTS (SELECT 1 FROM reached WHERE id = ?2)",
    )?;
    Ok(statement.query_row(
        params![
            edge.target_id,
            edge.source.id(),
            edge.edge_type,
            edge.replacing
        ],
        |row| row.get(0),
    )?)
}

/// Refuses a move of an item to `next_type` that an edge the copy holds at
/// the item would not admit, as the server holds a retype to every edge
/// standing at the item.
pub(crate) fn refuse_retype_breaking_edges(
    conn: &Connection,
    item_id: &str,
    next_type: &str,
) -> Result<()> {
    let mut lineages = Lineages::default();
    let Some(lineage) = lineages.of(conn, next_type)? else {
        return Ok(());
    };
    let mut statement = conn.prepare_cached(
        "SELECT edge_type, source_id = ?1, target_id = ?1 FROM edges
          WHERE (source_id = ?1 OR target_id = ?1) AND source_id != target_id
          ORDER BY created_at, id",
    )?;
    let edges = statement
        .query_map([item_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut edge_types: HashMap<String, Option<EdgeType>> = HashMap::new();
    for (id, from, to) in edges {
        if !edge_types.contains_key(&id) {
            let held = held_edge_type(conn, &id)?;
            edge_types.insert(id.clone(), held);
        }
        let Some(Some(edge_type)) = edge_types.get(&id) else {
            continue;
        };
        if from && lineage.admitted_by(&edge_type.source_type_constraints) == Some(false) {
            return Err(refused_end(&id, "source", next_type));
        }
        if from
            && edge_type.flat
            && lineage.admitted_by(&edge_type.target_type_constraints) == Some(true)
        {
            return Err(refused_nesting(&id));
        }
        if to && lineage.admitted_by(&edge_type.target_type_constraints) == Some(false) {
            return Err(refused_end(&id, "target", next_type));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::catalog::Catalog;
    use crate::wire::{WireCatalog, WireType};
    use crate::{Core, CoreError, Draft, EdgeDraft, EdgeEdit, Edit, reach, store};

    const NOTE_A: &str = "0190f3a0-0000-7000-8000-00000000000a";
    const NOTE_B: &str = "0190f3a0-0000-7000-8000-00000000000b";
    const NOTE_C: &str = "0190f3a0-0000-7000-8000-00000000000c";
    const TASK: &str = "0190f3a0-0000-7000-8000-000000000001";
    const IMAGE: &str = "0190f3a0-0000-7000-8000-000000000002";
    const ALBUM: &str = "0190f3a0-0000-7000-8000-000000000003";
    const SERIES: &str = "0190f3a0-0000-7000-8000-000000000004";
    const BINNED: &str = "0190f3a0-0000-7000-8000-000000000005";
    /// An item outside the slice, which the copy does not hold.
    const FAR: &str = "0190f3a0-0000-7000-8000-000000000006";

    fn edge_type(
        id: &str,
        cardinality: &str,
        ends: [&[&str]; 2],
        acyclic: bool,
        flat: bool,
    ) -> Value {
        json!({
            "id": id,
            "cardinality": cardinality,
            "source_type_constraints": ends[0],
            "target_type_constraints": ends[1],
            "cascade_on_delete": "orphan",
            "property_schema": {},
            "written_at": "source",
            "shipped": false,
            "acyclic": acyclic,
            "flat": flat,
        })
    }

    fn item_type(id: &str, parent: Option<&str>, roles: &[&str]) -> WireType {
        let mut held = store::testing::wire_type(id, parent, Some("title"));
        if !roles.is_empty() {
            held.rest.insert("roles".into(), json!(roles));
        }
        held
    }

    /// No edge type here is named for what the server does with it, so each
    /// one's rules come from its listing alone.
    fn copy() -> Core {
        copy_with(Vec::new(), Vec::new())
    }

    /// The same, with these types and edge types in its catalog too.
    fn copy_with(more_types: Vec<WireType>, more_edge_types: Vec<Value>) -> Core {
        let many = "many-to-many";
        let core = Core::open_in_memory(None).unwrap();
        {
            let conn = core.conn().unwrap();
            let mut types = vec![
                item_type("core.note", None, &[]),
                item_type("core.task", None, &[]),
                item_type("core.file", None, &[]),
                item_type("core.file.image", Some("core.file"), &[]),
                item_type("core.collection", None, &["container"]),
                item_type("user.album", Some("core.collection"), &[]),
            ];
            types.extend(more_types);
            store::replace_catalog(
                &conn,
                &WireCatalog {
                    types,
                    edge_types: more_edge_types
                        .into_iter()
                        .chain([
                            edge_type(
                                "mock.notes",
                                many,
                                [&["core.note"], &["core.note"]],
                                false,
                                false,
                            ),
                            edge_type(
                                "mock.next-note",
                                "one-to-one",
                                [&["core.note"], &["core.note"]],
                                false,
                                false,
                            ),
                            edge_type("mock.files", many, [&["*"], &["core.file"]], false, false),
                            edge_type(
                                "mock.member",
                                many,
                                [&["*"], &["role:container"]],
                                false,
                                true,
                            ),
                            edge_type("mock.tree", many, [&[], &[]], true, false),
                            edge_type("mock.under", "many-to-one", [&[], &[]], true, false),
                            edge_type("mock.loose", many, [&[], &[]], false, false),
                        ])
                        .collect(),
                },
            )
            .unwrap();
            store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
            store::meta_set(&conn, reach::FENCE, crate::scripted::FENCE).unwrap();
            store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
            store::meta_set(
                &conn,
                store::META_SLICE_TYPES,
                r#"["core.note","core.task","core.file","core.collection"]"#,
            )
            .unwrap();
            store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
            for (id, r#type, state) in [
                (NOTE_A, "core.note", "active"),
                (NOTE_B, "core.note", "active"),
                (NOTE_C, "core.note", "active"),
                (TASK, "core.task", "active"),
                (IMAGE, "core.file.image", "active"),
                (ALBUM, "user.album", "active"),
                (SERIES, "core.collection", "active"),
                (BINNED, "core.note", "trashed"),
            ] {
                let row = store::testing::wire_item(
                    id,
                    r#type,
                    state,
                    "2026-01-01T00:00:00Z",
                    json!({ "title": r#type }),
                );
                store::put_server_item(&conn, &row, None, &Catalog::empty()).unwrap();
            }
        }
        core
    }

    fn edge(source: &str, target: &str, edge_type: &str) -> EdgeDraft {
        EdgeDraft {
            source_id: source.into(),
            target_id: target.into(),
            edge_type: edge_type.into(),
            ..EdgeDraft::default()
        }
    }

    fn hold(core: &Core, id: &str, source: &str, target: &str, edge_type: &str) {
        let conn = core.conn().unwrap();
        store::put_server_edge(
            &conn,
            &store::testing::wire_edge(id, source, target, edge_type),
        )
        .unwrap();
    }

    fn queued(core: &Core) -> usize {
        core.queue().unwrap().len()
    }

    fn assert_refused<T: std::fmt::Debug>(outcome: crate::Result<T>, code: &str, what: &str) {
        let failure = outcome.expect_err(what);
        let refused = match &failure {
            CoreError::Validation { code, .. } | CoreError::NotFound { code, .. } => code,
            _ => panic!("{what}: {failure:?}"),
        };
        assert_eq!(refused, code, "{what}: {failure:?}");
    }

    /// The check and the create give the same refusal, and nothing is queued.
    fn assert_create_refused(core: &Core, draft: &EdgeDraft, code: &str, what: &str) {
        let before = queued(core);
        assert_refused(core.check_edge(draft), code, what);
        assert_refused(core.create_edge(draft), code, what);
        assert_eq!(queued(core), before, "{what}: a refused edge was queued");
    }

    /// The check passes without queuing, and the create queues the edge.
    fn assert_create_queued(core: &Core, draft: &EdgeDraft, what: &str) {
        let before = queued(core);
        core.check_edge(draft)
            .unwrap_or_else(|failure| panic!("{what}: {failure:?}"));
        assert_eq!(queued(core), before, "{what}: the check queued a write");
        core.create_edge(draft)
            .unwrap_or_else(|failure| panic!("{what}: {failure:?}"));
        assert_eq!(queued(core), before + 1, "{what}: nothing was queued");
    }

    #[test]
    fn an_end_of_a_type_the_edge_type_does_not_admit_is_refused() {
        let core = copy();
        assert_create_queued(&core, &edge(NOTE_A, NOTE_B, "mock.notes"), "two notes");
        assert_create_refused(
            &core,
            &edge(TASK, NOTE_B, "mock.notes"),
            "edge_constraint_violation",
            "a task as the source",
        );
        assert_create_refused(
            &core,
            &edge(NOTE_A, TASK, "mock.notes"),
            "edge_constraint_violation",
            "a task as the target",
        );
    }

    #[test]
    fn an_end_beneath_an_admitted_type_is_taken_and_another_is_refused() {
        let core = copy();
        assert_create_queued(
            &core,
            &edge(NOTE_A, IMAGE, "mock.files"),
            "an image, beneath the file type the edge type admits",
        );
        assert_create_refused(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.files"),
            "edge_constraint_violation",
            "a note, which is no file",
        );
    }

    #[test]
    fn a_role_admits_a_type_that_inherits_it_and_a_flat_edge_type_refuses_nesting() {
        let core = copy();
        assert_create_queued(
            &core,
            &edge(NOTE_A, ALBUM, "mock.member"),
            "a note joining an album, which inherits the container role",
        );
        assert_create_refused(
            &core,
            &edge(NOTE_A, TASK, "mock.member"),
            "edge_constraint_violation",
            "a task, which plays no container role",
        );
        assert_create_refused(
            &core,
            &edge(SERIES, ALBUM, "mock.member"),
            "edge_constraint_violation",
            "a collection joining an album, as nesting",
        );
        // The witness: the same two collections on an edge type that is not flat.
        assert_create_queued(&core, &edge(SERIES, ALBUM, "mock.loose"), "a loose edge");
    }

    #[test]
    fn a_parent_chain_the_copy_cannot_read_to_its_top_is_left_to_the_server() {
        const CLIP: &str = "0190f3a0-0000-7000-8000-000000000011";
        const LOOPED: &str = "0190f3a0-0000-7000-8000-000000000012";
        let core = copy_with(
            vec![
                item_type("user.clip", Some("user.reel"), &[]),
                item_type("user.loop-a", Some("user.loop-b"), &[]),
                item_type("user.loop-b", Some("user.loop-a"), &[]),
            ],
            vec![
                edge_type(
                    "mock.reels",
                    "many-to-many",
                    [&["*"], &["user.reel"]],
                    false,
                    false,
                ),
                edge_type("mock.any", "many-to-many", [&["*"], &["*"]], false, false),
            ],
        );
        for (id, r#type) in [(CLIP, "user.clip"), (LOOPED, "user.loop-a")] {
            let row = store::testing::wire_item(
                id,
                r#type,
                "active",
                "2026-01-01T00:00:00Z",
                json!({ "title": r#type }),
            );
            store::put_server_item(&core.conn().unwrap(), &row, None, &Catalog::empty()).unwrap();
        }
        assert_create_queued(
            &core,
            &edge(NOTE_A, CLIP, "mock.reels"),
            "a clip, beneath the reel type the copy does not hold",
        );
        assert_create_queued(
            &core,
            &edge(NOTE_A, CLIP, "mock.files"),
            "a clip, which a reel the copy does not hold may make a file",
        );
        assert_create_queued(
            &core,
            &edge(CLIP, ALBUM, "mock.member"),
            "a clip joining an album, which a reel may make a container",
        );
        assert_create_queued(
            &core,
            &edge(NOTE_A, LOOPED, "mock.any"),
            "an item whose parent chain loops, on an edge type that admits every type",
        );
        assert_create_queued(
            &core,
            &edge(NOTE_A, LOOPED, "mock.files"),
            "an item whose parent chain loops, which only the server can judge",
        );
        // The witness: a chain read to its top is still judged.
        assert_create_refused(
            &core,
            &edge(NOTE_A, TASK, "mock.files"),
            "edge_constraint_violation",
            "a task, which is no file",
        );
    }

    #[test]
    fn an_edge_closing_a_cycle_through_held_edges_is_refused() {
        let core = copy();
        hold(&core, "ab", NOTE_A, NOTE_B, "mock.tree");
        hold(&core, "b-far", NOTE_B, FAR, "mock.tree");
        hold(&core, "far-c", FAR, NOTE_C, "mock.tree");
        assert_create_refused(
            &core,
            &edge(NOTE_C, NOTE_A, "mock.tree"),
            "edge_cycle",
            "the edge that closes a, b, an item outside the slice, c",
        );
        // The witness: the same edges on an edge type that is not acyclic.
        hold(&core, "ab-loose", NOTE_A, NOTE_B, "mock.loose");
        hold(&core, "bc-loose", NOTE_B, NOTE_C, "mock.loose");
        assert_create_queued(&core, &edge(NOTE_C, NOTE_A, "mock.loose"), "a loose cycle");
    }

    #[test]
    fn a_cycle_through_an_edge_the_copy_does_not_hold_is_left_to_the_server() {
        let core = copy();
        hold(&core, "ab", NOTE_A, NOTE_B, "mock.tree");
        // The server also holds b to c, which this copy was never sent.
        assert_create_queued(
            &core,
            &edge(NOTE_C, NOTE_A, "mock.tree"),
            "an edge whose cycle runs through an edge outside the copy",
        );
    }

    #[test]
    fn a_queued_edge_counts_toward_a_cycle() {
        let core = copy();
        core.create_edge(&edge(NOTE_A, NOTE_B, "mock.tree"))
            .unwrap();
        core.create_edge(&edge(NOTE_B, NOTE_C, "mock.tree"))
            .unwrap();
        assert_create_refused(
            &core,
            &edge(NOTE_C, NOTE_A, "mock.tree"),
            "edge_cycle",
            "the edge that closes two queued ones",
        );
    }

    #[test]
    fn an_edge_to_or_from_an_item_in_the_bin_is_refused_as_missing() {
        let core = copy();
        assert_create_refused(
            &core,
            &edge(NOTE_A, BINNED, "mock.notes"),
            "item_not_found",
            "a target in the bin",
        );
        assert_create_refused(
            &core,
            &edge(BINNED, NOTE_A, "mock.notes"),
            "item_not_found",
            "a source in the bin",
        );
    }

    #[test]
    fn an_edge_type_or_an_end_the_copy_does_not_hold_is_left_to_the_server() {
        let core = copy();
        assert_create_queued(
            &core,
            &edge(NOTE_A, TASK, "mock.unknown"),
            "an edge type the catalog does not hold",
        );
        assert_create_queued(
            &core,
            &edge(NOTE_A, FAR, "mock.notes"),
            "a target outside the slice",
        );
    }

    #[test]
    fn a_move_is_judged_as_the_edge_it_would_leave() {
        let core = copy();
        hold(&core, "next", NOTE_A, NOTE_B, "mock.next-note");
        let target = |id: &str| EdgeEdit {
            base_version: Some(1),
            target_id: Some(id.into()),
            ..EdgeEdit::default()
        };
        let before = queued(&core);
        assert_refused(
            core.update_edge("next", &target(TASK)),
            "edge_constraint_violation",
            "a move onto a task",
        );
        assert_refused(
            core.update_edge("next", &target(BINNED)),
            "item_not_found",
            "a move onto an item in the bin",
        );
        hold(&core, "ab", NOTE_A, NOTE_B, "mock.under");
        hold(&core, "bc", NOTE_B, NOTE_C, "mock.under");
        assert_refused(
            core.update_edge("bc", &target(NOTE_A)),
            "edge_cycle",
            "a move of b to c onto a, closing a, b, a",
        );
        assert_eq!(queued(&core), before, "a refused move was queued");
        core.update_edge("next", &target(NOTE_C)).unwrap();
        core.update_edge("bc", &target(FAR)).unwrap();
    }

    #[test]
    fn a_retype_that_breaks_a_standing_edge_is_refused() {
        let core = copy();
        hold(&core, "notes", NOTE_A, NOTE_B, "mock.notes");
        let retype = |r#type: &str| Edit {
            base_version: Some(1),
            r#type: Some(r#type.into()),
            ..Edit::default()
        };
        let before = queued(&core);
        assert_refused(
            core.update_item(NOTE_A, &retype("core.task")),
            "edge_constraint_violation",
            "the source of a notes edge made a task",
        );
        assert_refused(
            core.update_item(NOTE_B, &retype("core.task")),
            "edge_constraint_violation",
            "the target of a notes edge made a task",
        );
        hold(&core, "member", NOTE_C, ALBUM, "mock.member");
        assert_refused(
            core.update_item(NOTE_C, &retype("core.collection")),
            "edge_constraint_violation",
            "an album's member made a collection",
        );
        assert_eq!(queued(&core), before, "a refused retype was queued");
        // The witness: the same retypes pass once the edges are gone.
        {
            let conn = core.conn().unwrap();
            conn.execute("DELETE FROM edges WHERE id IN ('notes', 'member')", [])
                .unwrap();
        }
        core.update_item(NOTE_A, &retype("core.task")).unwrap();
        core.update_item(NOTE_C, &retype("core.collection"))
            .unwrap();
    }

    #[test]
    fn an_inline_edge_of_a_create_is_judged_with_the_item_it_makes() {
        let core = copy();
        let draft = |r#type: &str, edge_type: &str, target: &str| Draft {
            r#type: r#type.into(),
            properties: json!({ "title": "made" }).as_object().unwrap().clone(),
            edges: [(edge_type.to_string(), vec![target.to_string()])].into(),
            ..Draft::default()
        };
        let before = queued(&core);
        assert_refused(
            core.create_item(&draft("core.task", "mock.notes", NOTE_A)),
            "edge_constraint_violation",
            "a task made as the source",
        );
        assert_refused(
            core.create_item(&draft("core.note", "mock.notes", TASK)),
            "edge_constraint_violation",
            "a note made with a task as the target",
        );
        assert_refused(
            core.create_item(&draft("core.collection", "mock.member", ALBUM)),
            "edge_constraint_violation",
            "a collection made inside an album",
        );
        assert_refused(
            core.create_item(&draft("core.note", "mock.notes", BINNED)),
            "item_not_found",
            "a note made with a target in the bin",
        );
        assert_eq!(queued(&core), before, "a refused create was queued");
        core.create_item(&draft("core.note", "mock.notes", NOTE_A))
            .unwrap();
    }
}
