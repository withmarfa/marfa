//! The server's refusals of an edge write that a copy can reach on its own,
//! judged from the catalog and the rows and edges the copy holds.
//!
//! What the copy does not hold it leaves to the server: an edge type or an
//! item type outside its catalog, a constraint only the part of a type's
//! parent chain it cannot read would decide (a parent outside its catalog,
//! or a chain that loops), an end outside its slice, and a duplicate, a full
//! end or a cycle that turns only on edges it does not hold. Those writes
//! are queued, and the server's verdict on them stands.
//!
//! The edges the copy holds are the server's and the copy's own waiting
//! writes as they leave them: a waiting create or move shows its edge where
//! it will stand, and a waiting delete shows none, so each counts as the
//! server will hold it once the writes before this one reach it.
//!
//! A write the server refused while a drain could not read its row back
//! leaves its effect in the copy until that read lands. While a refused edge
//! create, move or other edge edit owes the read of its edge, or a refused
//! item create owes the read of its item, the edge it shows (the item
//! create's inline edges) counts for nothing in the duplicate, cardinality,
//! cycle and retype checks: counting it could refuse a write the server
//! takes, while leaving it out can only let through a write the server may
//! refuse, which is kept with its verdict. Once the read lands, the copy
//! shows the server's row and counts it as it is.
//!
//! Each `edge_constraint_violation` carries the `details` the server's answer
//! to the same write carries, so an app reads it one way whichever refused it.
//! An `edge_cycle` carries none.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::catalog::{self, EdgeType, End, Lineage};
use crate::error::CoreError;
use crate::model::{Draft, Subject, Verdict, WriteKind};
use crate::store;

type Result<T> = std::result::Result<T, CoreError>;

/// The source of an edge being judged: a row the copy may hold, or the item a
/// create is making or landing on. The server replaces a row's outbound
/// edges of each type a create names, so those the row holds are not
/// counted against the ones named.
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

    /// The row whose outbound edges of the type the write replaces.
    fn replaced(&self) -> Option<&str> {
        match self {
            Source::Held(_) => None,
            Source::Made { id, .. } => Some(id),
        }
    }
}

/// An edge as a write would leave it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Proposed<'a> {
    pub edge_type: &'a str,
    pub source: Source<'a>,
    pub target_id: &'a str,
    /// The held edge the write is: the edge a move changes, or the one a
    /// create names by id, which the server acknowledges or refuses by its
    /// id before it counts edges. The write's own checks leave it out.
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

fn constraint_violation(message: String, details: Value) -> CoreError {
    CoreError::Validation {
        code: "edge_constraint_violation".into(),
        message,
        details: Some(Box::new(details)),
    }
}

fn refused_end(edge_type: &EdgeType, end: End, r#type: &str) -> CoreError {
    let id = &edge_type.id;
    let (end, allowed) = match end {
        End::Source => ("source", &edge_type.source_type_constraints),
        End::Target => ("target", &edge_type.target_type_constraints),
    };
    let mut details = serde_json::Map::new();
    details.insert("edge_type".into(), json!(id));
    details.insert(format!("{end}_type"), json!(r#type));
    details.insert("allowed".into(), json!(allowed));
    constraint_violation(
        format!("Edge \"{id}\" does not allow {end} type \"{type}\""),
        Value::Object(details),
    )
}

fn refused_nesting(edge_type: &str, source_id: &str, source_type: &str) -> CoreError {
    constraint_violation(
        format!(
            "Edge \"{edge_type}\" does not take a source its target constraints admit; use \"parent-of\" for hierarchy"
        ),
        json!({
            "edge_type": edge_type,
            "source_id": source_id,
            "source_type": source_type,
            "constraint": "nesting",
        }),
    )
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

/// Refuses the edges one write makes where the server would refuse one, in
/// the server's order (`edges/create-order`): for each edge, an end in the
/// bin, an end of a type the edge type does not admit and a source a flat
/// edge type does not take; then, edge by edge, a triple the copy holds, an
/// end that already holds the one edge of the type it may, and a cycle. Each
/// edge is counted with those before it in the same write, as the server
/// counts a batch.
pub(crate) fn refuse_unwritable_edges(conn: &Connection, edges: &[Proposed]) -> Result<()> {
    let mut lineages = Lineages::default();
    let refused = shown_by_unread_refusals(conn)?;
    let mut judged = Vec::with_capacity(edges.len());
    for edge in edges {
        if let Some(edge_type) = held_edge_type(conn, edge.edge_type)? {
            refuse_unfitting_ends(conn, &mut lineages, edge, &edge_type)?;
            judged.push((edge, edge_type));
        }
    }
    for (index, (edge, edge_type)) in judged.iter().enumerate() {
        let earlier = || judged[..index].iter().map(|(earlier, _)| *earlier);
        if holds_triple(conn, edge, &refused)?
            || earlier().any(|earlier| {
                earlier.edge_type == edge.edge_type
                    && earlier.source.id() == edge.source.id()
                    && earlier.target_id == edge.target_id
            })
        {
            return Err(constraint_violation(
                format!(
                    "Edge \"{}\" already exists between these items",
                    edge.edge_type
                ),
                json!({
                    "edge_type": edge.edge_type,
                    "source_id": edge.source.id(),
                    "target_id": edge.target_id,
                    "constraint": "duplicate",
                }),
            ));
        }
        for end in [End::Source, End::Target] {
            if !edge_type.one_at(end) {
                continue;
            }
            let at = |edge: &Proposed| match end {
                End::Source => edge.source.id().to_string(),
                End::Target => edge.target_id.to_string(),
            };
            if holds_at(conn, edge, end, &refused)?
                || earlier()
                    .any(|earlier| earlier.edge_type == edge.edge_type && at(earlier) == at(edge))
            {
                return Err(refused_cardinality(edge_type, end, &at(edge)));
            }
        }
        if edge_type.acyclic && closes_cycle(conn, edge, &refused)? {
            return Err(CoreError::Validation {
                code: "edge_cycle".into(),
                message: format!("Edge \"{}\" would close a cycle", edge.edge_type),
                details: None,
            });
        }
    }
    Ok(())
}

fn refused_cardinality(edge_type: &EdgeType, end: End, at: &str) -> CoreError {
    let (end, edge) = match end {
        End::Source => ("source", "outbound"),
        End::Target => ("target", "inbound"),
    };
    let mut details = serde_json::Map::new();
    details.insert("edge_type".into(), json!(edge_type.id));
    details.insert(format!("{end}_id"), json!(at));
    details.insert("constraint".into(), json!("cardinality"));
    constraint_violation(
        format!(
            "Edge \"{}\" is {}; {end} already has an {edge} edge of this type",
            edge_type.id, edge_type.cardinality
        ),
        Value::Object(details),
    )
}

/// The edges the copy shows only because of a write the server refused,
/// while a read of the server's row is owed for it (see the module), as a
/// JSON array for `json_each`. A refused edge create, move or other edit
/// shows its edge; a refused item create shows its inline edges, under the
/// item's own id or, for a keyed create, the row it landed on.
fn shown_by_unread_refusals(conn: &Connection) -> Result<String> {
    let mut owed: HashSet<(Subject, String)> = HashSet::new();
    for read in store::owed_read_backs(conn)? {
        owed.insert((read.subject, read.id));
    }
    if owed.is_empty() {
        return Ok("[]".into());
    }
    let mut statement = conn.prepare_cached(
        "SELECT id, kind, item_id, edge_id FROM queue
          WHERE verdict = ?1 AND kind IN (?2, ?3, ?4)",
    )?;
    let refused = statement
        .query_map(
            params![
                Verdict::Refused.as_str(),
                WriteKind::CreateEdge.as_str(),
                WriteKind::UpdateEdge.as_str(),
                WriteKind::CreateItem.as_str()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let landings = store::pending_landings(conn)?;
    let mut shown = Vec::new();
    for (row, kind, item_id, edge_id) in refused {
        if kind != WriteKind::CreateItem.as_str() {
            if let Some(edge_id) = edge_id
                && owed.contains(&(Subject::Edge, edge_id.clone()))
            {
                shown.push(edge_id);
            }
            continue;
        }
        let Some(item_id) = item_id else {
            continue;
        };
        let read_owed = owed.contains(&(Subject::Item, item_id.clone()))
            || landings
                .get(&row)
                .is_some_and(|landed| owed.contains(&(Subject::Item, landed.clone())));
        if read_owed {
            let draft = Draft::from_payload(&store::payload_of(conn, &row)?)?;
            shown.extend(
                draft
                    .projected_edges(&item_id, "")
                    .into_iter()
                    .map(|edge| edge.id),
            );
        }
    }
    Ok(serde_json::to_string(&shown)?)
}

/// The held edges the write leaves standing beside the proposed one: every
/// edge of its type but the one the write is, those a create replaces and
/// those only a refused write shows.
const STANDING: &str = "edge_type = ?2 AND id IS NOT ?3 AND source_id IS NOT ?4
    AND id NOT IN (SELECT value FROM json_each(?1))";

/// Whether the copy holds an edge of the proposed triple.
fn holds_triple(conn: &Connection, edge: &Proposed, refused: &str) -> Result<bool> {
    let mut statement = conn.prepare_cached(&format!(
        "SELECT EXISTS (SELECT 1 FROM edges
          WHERE {STANDING} AND source_id = ?5 AND target_id = ?6)"
    ))?;
    Ok(statement.query_row(
        params![
            refused,
            edge.edge_type,
            edge.replacing,
            edge.source.replaced(),
            edge.source.id(),
            edge.target_id
        ],
        |row| row.get(0),
    )?)
}

/// Whether the copy holds an edge of the proposed type at the proposed
/// edge's `end`.
fn holds_at(conn: &Connection, edge: &Proposed, end: End, refused: &str) -> Result<bool> {
    let (column, id) = match end {
        End::Source => ("source_id", edge.source.id()),
        End::Target => ("target_id", edge.target_id),
    };
    let mut statement = conn.prepare_cached(&format!(
        "SELECT EXISTS (SELECT 1 FROM edges WHERE {STANDING} AND {column} = ?5)"
    ))?;
    Ok(statement.query_row(
        params![
            refused,
            edge.edge_type,
            edge.replacing,
            edge.source.replaced(),
            id
        ],
        |row| row.get(0),
    )?)
}

/// Refuses an edge the server would refuse for its ends: an end in the bin,
/// an end of a type the edge type does not admit, then a source a flat edge
/// type does not take.
fn refuse_unfitting_ends(
    conn: &Connection,
    lineages: &mut Lineages,
    edge: &Proposed,
    edge_type: &EdgeType,
) -> Result<()> {
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
    if let Some(r#type) = &source_type
        && let Some(lineage) = lineages.of(conn, r#type)?
        && lineage.admitted_by(&edge_type.source_type_constraints) == Some(false)
    {
        return Err(refused_end(edge_type, End::Source, r#type));
    }
    if let Some(r#type) = &target_type
        && let Some(lineage) = lineages.of(conn, r#type)?
        && lineage.admitted_by(&edge_type.target_type_constraints) == Some(false)
    {
        return Err(refused_end(edge_type, End::Target, r#type));
    }
    if edge_type.flat
        && let Some(r#type) = &source_type
        && let Some(lineage) = lineages.of(conn, r#type)?
        && lineage.admitted_by(&edge_type.target_type_constraints) == Some(true)
    {
        return Err(refused_nesting(edge.edge_type, edge.source.id(), r#type));
    }
    Ok(())
}

/// Whether the target reaches the source through the held edges of the type,
/// those still waiting to be sent among them and those only a refused write
/// shows left out.
fn closes_cycle(conn: &Connection, edge: &Proposed, refused: &str) -> Result<bool> {
    let mut statement = conn.prepare_cached(
        "WITH RECURSIVE reached(id) AS (
            SELECT ?1
            UNION
            SELECT e.target_id FROM edges e JOIN reached r ON e.source_id = r.id
             WHERE e.edge_type = ?3 AND e.id IS NOT ?4
               AND e.id NOT IN (SELECT value FROM json_each(?5))
         )
         SELECT EXISTS (SELECT 1 FROM reached WHERE id = ?2)",
    )?;
    Ok(statement.query_row(
        params![
            edge.target_id,
            edge.source.id(),
            edge.edge_type,
            edge.replacing,
            refused
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
    let refused = shown_by_unread_refusals(conn)?;
    let mut statement = conn.prepare_cached(
        "SELECT edge_type, source_id = ?1, target_id = ?1 FROM edges
          WHERE (source_id = ?1 OR target_id = ?1) AND source_id != target_id
            AND id NOT IN (SELECT value FROM json_each(?2))
          ORDER BY created_at, id",
    )?;
    let edges = statement
        .query_map(params![item_id, refused], |row| {
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
            return Err(refused_end(edge_type, End::Source, next_type));
        }
        if from
            && edge_type.flat
            && lineage.admitted_by(&edge_type.target_type_constraints) == Some(true)
        {
            return Err(refused_nesting(&id, item_id, next_type));
        }
        if to && lineage.admitted_by(&edge_type.target_type_constraints) == Some(false) {
            return Err(refused_end(edge_type, End::Target, next_type));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::catalog::Catalog;
    use crate::wire::{WireCatalog, WireType};
    use crate::{Core, CoreError, Draft, EdgeDraft, EdgeEdit, Edit, End, reach, store};

    const NOTE_A: &str = "0190f3a0-0000-7000-8000-00000000000a";
    const NOTE_B: &str = "0190f3a0-0000-7000-8000-00000000000b";
    const NOTE_C: &str = "0190f3a0-0000-7000-8000-00000000000c";
    const NOTE_D: &str = "0190f3a0-0000-7000-8000-00000000000d";
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
        copy_of(None, more_types, more_edge_types)
    }

    /// The same copy, drained to `server`.
    fn copy_served(server: &crate::scripted::Scripted) -> Core {
        let server = crate::Server {
            url: server.url(),
            key: "k".into(),
        };
        copy_of(Some(server), Vec::new(), Vec::new())
    }

    fn copy_of(
        server: Option<crate::Server>,
        more_types: Vec<WireType>,
        more_edge_types: Vec<Value>,
    ) -> Core {
        let many = "many-to-many";
        let core = Core::open_in_memory(server).unwrap();
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
                            edge_type("mock.child", "one-to-many", [&[], &[]], true, false),
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
                (NOTE_D, "core.note", "active"),
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

    /// The server's `error.details` for an `edge_constraint_violation`.
    fn details_of<T: std::fmt::Debug>(outcome: crate::Result<T>, what: &str) -> Value {
        match outcome {
            Err(CoreError::Validation {
                code,
                message,
                details,
            }) => {
                assert_eq!(code, "edge_constraint_violation", "{what}: {message}");
                *details.unwrap_or_else(|| panic!("{what}: no details on {message}"))
            }
            other => panic!("{what}: {other:?}"),
        }
    }

    /// A duplicate and a cardinality refusal share their code; an app tells
    /// them apart by `details.constraint`, and a full end by the end the
    /// details name.
    #[derive(Debug, Clone, Copy, PartialEq)]
    enum Refusal {
        Duplicate,
        SourceFull,
        TargetFull,
    }

    const DUPLICATE: Refusal = Refusal::Duplicate;
    const SOURCE_FULL: Refusal = Refusal::SourceFull;
    const TARGET_FULL: Refusal = Refusal::TargetFull;

    fn assert_refused_for<T: std::fmt::Debug>(
        outcome: crate::Result<T>,
        refusal: Refusal,
        what: &str,
    ) {
        let details = details_of(outcome, what);
        let constraint = if refusal == DUPLICATE {
            "duplicate"
        } else {
            "cardinality"
        };
        assert_eq!(details["constraint"], constraint, "{what}: {details}");
        let names = |end: &str| details.get(end).is_some();
        let ends = match refusal {
            Refusal::Duplicate => (true, true),
            Refusal::SourceFull => (true, false),
            Refusal::TargetFull => (false, true),
        };
        assert_eq!(
            (names("source_id"), names("target_id")),
            ends,
            "{what}: {details}"
        );
    }

    /// The check and the create give the same refusal, and nothing is queued.
    fn assert_create_refused_for(core: &Core, draft: &EdgeDraft, refusal: Refusal, what: &str) {
        let before = queued(core);
        assert_refused_for(core.check_edge(draft), refusal, what);
        assert_refused_for(core.create_edge(draft), refusal, what);
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

    const HELD_EDGE: &str = "0190f3a0-0000-7000-8000-0000000000e1";
    const OTHER_EDGE: &str = "0190f3a0-0000-7000-8000-0000000000e2";

    #[test]
    fn a_second_edge_naming_a_held_triple_is_refused_as_a_duplicate() {
        let core = copy();
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.notes");
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.notes"),
            DUPLICATE,
            "a second notes edge from a to b",
        );
        // The witnesses: the reverse triple, and a repeat of the held edge's
        // own id, which the server acknowledges rather than refuses.
        assert_create_queued(&core, &edge(NOTE_B, NOTE_A, "mock.notes"), "b to a");
        assert_create_queued(
            &core,
            &EdgeDraft {
                id: Some(HELD_EDGE.into()),
                ..edge(NOTE_A, NOTE_B, "mock.notes")
            },
            "a repeat of the held edge under its own id",
        );
    }

    #[test]
    fn each_end_a_cardinality_holds_to_one_edge_refuses_a_second() {
        let core = copy();
        hold(&core, "one-one", NOTE_A, NOTE_B, "mock.next-note");
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_C, "mock.next-note"),
            SOURCE_FULL,
            "a second one-to-one edge from a",
        );
        assert_create_refused_for(
            &core,
            &edge(NOTE_C, NOTE_B, "mock.next-note"),
            TARGET_FULL,
            "a second one-to-one edge to b",
        );

        hold(&core, "one-many", NOTE_A, NOTE_B, "mock.child");
        assert_create_refused_for(
            &core,
            &edge(NOTE_C, NOTE_B, "mock.child"),
            TARGET_FULL,
            "a second one-to-many edge to b",
        );
        assert_create_queued(
            &core,
            &edge(NOTE_A, NOTE_C, "mock.child"),
            "a second one-to-many edge from a, whose source holds many",
        );

        hold(&core, "many-one", NOTE_A, NOTE_B, "mock.under");
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_C, "mock.under"),
            SOURCE_FULL,
            "a second many-to-one edge from a",
        );
        assert_create_queued(
            &core,
            &edge(NOTE_C, NOTE_B, "mock.under"),
            "a second many-to-one edge to b, whose target holds many",
        );

        assert_create_queued(
            &core,
            &edge(NOTE_C, FAR, "mock.next-note"),
            "a one-to-one edge to an item outside the slice, at which the copy holds no edge",
        );
        hold(&core, "unknown", NOTE_A, NOTE_B, "mock.unknown");
        assert_create_queued(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.unknown"),
            "a second edge of a type the catalog does not hold",
        );
    }

    #[test]
    fn a_queued_edge_counts_and_a_queued_delete_frees_its_ends() {
        let core = copy();
        core.create_edge(&EdgeDraft {
            id: Some(OTHER_EDGE.into()),
            ..edge(NOTE_A, NOTE_B, "mock.next-note")
        })
        .unwrap();
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.next-note"),
            DUPLICATE,
            "the triple of an edge still waiting to be sent",
        );
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_C, "mock.next-note"),
            SOURCE_FULL,
            "a second edge from a source whose edge waits to be sent",
        );

        hold(&core, HELD_EDGE, NOTE_C, NOTE_D, "mock.next-note");
        assert_create_refused_for(
            &core,
            &edge(NOTE_C, NOTE_A, "mock.next-note"),
            SOURCE_FULL,
            "a second edge from c before its edge is deleted",
        );
        core.delete_edge(HELD_EDGE).unwrap();
        assert_create_queued(
            &core,
            &edge(NOTE_C, NOTE_D, "mock.next-note"),
            "the edge again once its delete waits to be sent",
        );
    }

    #[test]
    fn an_edge_whose_create_was_refused_counts_for_nothing() {
        let core = copy();
        let made = core
            .create_edge(&edge(NOTE_A, NOTE_B, "mock.next-note"))
            .unwrap();
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.next-note"),
            DUPLICATE,
            "the triple while its create waits for an answer",
        );
        crate::store::record_refusal(
            &core.conn().unwrap(),
            &made,
            "edge_constraint_violation",
            None,
            false,
        )
        .unwrap();
        for (draft, what) in [
            (edge(NOTE_A, NOTE_B, "mock.next-note"), "the triple again"),
            (
                edge(NOTE_A, NOTE_C, "mock.next-note"),
                "another edge from a",
            ),
            (edge(NOTE_C, NOTE_B, "mock.next-note"), "another edge to b"),
        ] {
            core.check_edge(&draft)
                .unwrap_or_else(|error| panic!("{what} once refused: {error:?}"));
        }
    }

    #[test]
    fn an_edge_the_server_refused_counts_for_nothing_while_its_read_is_owed() {
        let server = crate::scripted::Scripted::start();
        let core = copy_served(&server);
        core.create_edge(&EdgeDraft {
            id: Some(OTHER_EDGE.into()),
            ..edge(NOTE_A, NOTE_B, "mock.next-note")
        })
        .unwrap();
        server.on(
            "/edges",
            vec![crate::scripted::refusal(422, "edge_constraint_violation")],
        );
        server.on(
            &format!("/edges/{OTHER_EDGE}"),
            vec![crate::scripted::unnamed(503, "unavailable")],
        );
        let report = core.drain().unwrap();
        assert!(
            report.unavailable.is_some(),
            "the read went through: {report:?}"
        );
        // The witness: the refusal is recorded, the read is still owed, and
        // the copy still shows the refused edge.
        let queue = core.queue().unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].verdict, Some(crate::Verdict::Refused));
        assert!(
            !store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(
            core.edges_from(NOTE_A)
                .unwrap()
                .iter()
                .any(|shown| shown.id == OTHER_EDGE),
            "the copy put the refused edge back before its read landed"
        );
        for (draft, what) in [
            (edge(NOTE_A, NOTE_B, "mock.next-note"), "the triple again"),
            (
                edge(NOTE_A, NOTE_C, "mock.next-note"),
                "another edge from a",
            ),
            (edge(NOTE_C, NOTE_B, "mock.next-note"), "another edge to b"),
        ] {
            core.check_edge(&draft)
                .unwrap_or_else(|error| panic!("{what} once refused: {error:?}"));
        }
    }

    const MADE: &str = "0190f3a0-0000-7000-8000-0000000000f1";

    /// The read-back of the refused write is still owed, and its row the
    /// first in the queue.
    fn assert_refused_and_unread(core: &Core) {
        let queue = core.queue().unwrap();
        assert_eq!(queue[0].verdict, Some(crate::Verdict::Refused));
        assert!(
            !store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty(),
            "the read landed"
        );
    }

    #[test]
    fn an_inline_edge_of_a_refused_create_counts_for_nothing_while_its_read_is_owed() {
        let server = crate::scripted::Scripted::start();
        let core = copy_served(&server);
        core.create_item(&Draft {
            id: Some(MADE.into()),
            r#type: "core.note".into(),
            properties: json!({ "title": "made" }).as_object().unwrap().clone(),
            edges: [("mock.next-note".to_string(), vec![NOTE_B.to_string()])].into(),
            ..Draft::default()
        })
        .unwrap();
        assert_refused_for(
            core.check_edge(&edge(NOTE_C, NOTE_B, "mock.next-note")),
            TARGET_FULL,
            "another edge to b while the create waits",
        );
        server.on(
            "/items",
            vec![crate::scripted::refusal(422, "edge_constraint_violation")],
        );
        server.on(
            &format!("/items/{MADE}"),
            vec![crate::scripted::unnamed(503, "unavailable")],
        );
        let report = core.drain().unwrap();
        assert!(
            report.unavailable.is_some(),
            "the read went through: {report:?}"
        );
        assert_refused_and_unread(&core);
        assert!(
            core.edges_to(NOTE_B)
                .unwrap()
                .iter()
                .any(|shown| shown.source_id == MADE),
            "the copy put the refused create's edge back before its read landed"
        );
        core.check_edge(&edge(NOTE_C, NOTE_B, "mock.next-note"))
            .unwrap_or_else(|error| panic!("another edge to b once refused: {error:?}"));
    }

    /// A keyed create the server refused for the row its key names owes the
    /// read of that row, not of its own id; the drain records it as `land`
    /// does when that read fails.
    #[test]
    fn an_inline_edge_of_a_create_refused_onto_a_keyed_row_counts_for_nothing_while_that_read_is_owed()
     {
        let core = copy();
        let made = core
            .create_item(&Draft {
                id: Some(MADE.into()),
                r#type: "core.note".into(),
                properties: json!({ "title": "made" }).as_object().unwrap().clone(),
                edges: [("mock.next-note".to_string(), vec![NOTE_B.to_string()])].into(),
                ..Draft::default()
            })
            .unwrap();
        let other = edge(NOTE_C, NOTE_B, "mock.next-note");
        {
            let conn = core.conn().unwrap();
            store::record_verdict(
                &conn,
                &made.id,
                &store::Answered {
                    verdict: crate::Verdict::Refused,
                    reason: Some("version_conflict"),
                    answer: None,
                    conflicted_copy_id: None,
                },
            )
            .unwrap();
            store::meta_set(
                &conn,
                &format!("receipt_pending/{}", made.id),
                &format!("land:{NOTE_D}"),
            )
            .unwrap();
        }
        // The witness: refused, with no read owed, the edge still counts.
        assert_refused_for(
            core.check_edge(&other),
            TARGET_FULL,
            "another edge to b before the read is owed",
        );
        store::owe_read_back(
            &core.conn().unwrap(),
            &store::Owed {
                subject: crate::model::Subject::Item,
                id: NOTE_D.into(),
                source_id: None,
                edge_type: None,
                moved: false,
            },
        )
        .unwrap();
        core.check_edge(&other)
            .unwrap_or_else(|error| panic!("another edge to b once refused: {error:?}"));
    }

    #[test]
    fn a_refused_move_counts_for_nothing_at_either_end_while_its_read_is_owed() {
        let server = crate::scripted::Scripted::start();
        let core = copy_served(&server);
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.next-note");
        core.update_edge(
            HELD_EDGE,
            &EdgeEdit {
                base_version: Some(1),
                target_id: Some(NOTE_C.into()),
                ..EdgeEdit::default()
            },
        )
        .unwrap();
        assert_refused_for(
            core.check_edge(&edge(NOTE_D, NOTE_C, "mock.next-note")),
            TARGET_FULL,
            "another edge to c while the move waits",
        );
        server.on(
            &format!("/edges/{HELD_EDGE}"),
            vec![
                crate::scripted::refusal(422, "edge_constraint_violation"),
                crate::scripted::unnamed(503, "unavailable"),
            ],
        );
        let report = core.drain().unwrap();
        assert!(
            report.unavailable.is_some(),
            "the read went through: {report:?}"
        );
        assert_refused_and_unread(&core);
        assert!(
            core.edges_to(NOTE_C)
                .unwrap()
                .iter()
                .any(|shown| shown.id == HELD_EDGE),
            "the copy put the refused move back before its read landed"
        );
        core.check_edge(&edge(NOTE_D, NOTE_C, "mock.next-note"))
            .unwrap_or_else(|error| panic!("another edge to c once refused: {error:?}"));
    }

    #[test]
    fn an_edge_made_again_after_its_refusal_was_read_counts() {
        let server = crate::scripted::Scripted::start();
        let core = copy_served(&server);
        let named = || EdgeDraft {
            id: Some(OTHER_EDGE.into()),
            ..edge(NOTE_A, NOTE_B, "mock.next-note")
        };
        core.create_edge(&named()).unwrap();
        server.on(
            "/edges",
            vec![crate::scripted::refusal(422, "edge_constraint_violation")],
        );
        server.on(
            &format!("/edges/{OTHER_EDGE}"),
            vec![crate::scripted::certified(crate::scripted::refusal(
                404,
                "edge_not_found",
            ))],
        );
        core.drain().unwrap();
        // The witness: the refusal stays in the queue, and its read landed.
        assert_eq!(
            core.queue().unwrap()[0].verdict,
            Some(crate::Verdict::Refused)
        );
        assert!(
            store::owed_read_backs(&core.conn().unwrap())
                .unwrap()
                .is_empty(),
            "the read is still owed"
        );
        core.create_edge(&named()).unwrap();
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.next-note"),
            DUPLICATE,
            "the triple of the edge made again",
        );
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_C, "mock.next-note"),
            SOURCE_FULL,
            "a second edge from the source of the edge made again",
        );
    }

    #[test]
    fn each_refusal_carries_the_details_the_server_gives_it() {
        let core = copy();
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.next-note");
        for (draft, details, what) in [
            (
                edge(TASK, NOTE_B, "mock.notes"),
                json!({
                    "edge_type": "mock.notes",
                    "source_type": "core.task",
                    "allowed": ["core.note"],
                }),
                "a source of a type the edge type does not admit",
            ),
            (
                edge(NOTE_A, TASK, "mock.notes"),
                json!({
                    "edge_type": "mock.notes",
                    "target_type": "core.task",
                    "allowed": ["core.note"],
                }),
                "a target of a type the edge type does not admit",
            ),
            (
                edge(SERIES, ALBUM, "mock.member"),
                json!({
                    "edge_type": "mock.member",
                    "source_id": SERIES,
                    "source_type": "core.collection",
                    "constraint": "nesting",
                }),
                "a collection nested in an album",
            ),
            (
                edge(NOTE_A, NOTE_B, "mock.next-note"),
                json!({
                    "edge_type": "mock.next-note",
                    "source_id": NOTE_A,
                    "target_id": NOTE_B,
                    "constraint": "duplicate",
                }),
                "a duplicate",
            ),
            (
                edge(NOTE_A, NOTE_C, "mock.next-note"),
                json!({
                    "edge_type": "mock.next-note",
                    "source_id": NOTE_A,
                    "constraint": "cardinality",
                }),
                "a second edge from a",
            ),
            (
                edge(NOTE_C, NOTE_B, "mock.next-note"),
                json!({
                    "edge_type": "mock.next-note",
                    "target_id": NOTE_B,
                    "constraint": "cardinality",
                }),
                "a second edge to b",
            ),
        ] {
            assert_eq!(details_of(core.check_edge(&draft), what), details, "{what}");
            assert_eq!(
                details_of(core.create_edge(&draft), what),
                details,
                "{what}"
            );
        }
        hold(&core, OTHER_EDGE, NOTE_C, NOTE_D, "mock.next-note");
        assert_eq!(
            details_of(
                core.check_edge_move(HELD_EDGE, End::Target, NOTE_D),
                "a move onto d"
            ),
            json!({
                "edge_type": "mock.next-note",
                "target_id": NOTE_D,
                "constraint": "cardinality",
            }),
        );

        let core = copy();
        hold(&core, "notes", NOTE_C, NOTE_D, "mock.notes");
        hold(&core, "member", TASK, ALBUM, "mock.member");
        let retype = |r#type: &str| Edit {
            base_version: Some(1),
            r#type: Some(r#type.into()),
            ..Edit::default()
        };
        for (id, r#type, details, what) in [
            (
                NOTE_C,
                "core.task",
                json!({
                    "edge_type": "mock.notes",
                    "source_type": "core.task",
                    "allowed": ["core.note"],
                }),
                "the source of a notes edge made a task",
            ),
            (
                NOTE_D,
                "core.task",
                json!({
                    "edge_type": "mock.notes",
                    "target_type": "core.task",
                    "allowed": ["core.note"],
                }),
                "the target of a notes edge made a task",
            ),
            (
                TASK,
                "core.collection",
                json!({
                    "edge_type": "mock.member",
                    "source_id": TASK,
                    "source_type": "core.collection",
                    "constraint": "nesting",
                }),
                "an album's member made a collection",
            ),
        ] {
            assert_eq!(
                details_of(core.update_item(id, &retype(r#type)), what),
                details,
                "{what}"
            );
        }
    }

    #[test]
    fn a_move_onto_a_full_end_is_refused_and_onto_its_own_end_changes_nothing() {
        let core = copy();
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.next-note");
        hold(&core, OTHER_EDGE, NOTE_C, NOTE_D, "mock.next-note");
        let target = |id: &str| EdgeEdit {
            base_version: Some(1),
            target_id: Some(id.into()),
            ..EdgeEdit::default()
        };
        let source = |id: &str| EdgeEdit {
            base_version: Some(1),
            source_id: Some(id.into()),
            ..EdgeEdit::default()
        };
        let before = queued(&core);
        for (edit, end, to, words, what) in [
            (
                target(NOTE_D),
                End::Target,
                NOTE_D,
                TARGET_FULL,
                "onto d, which holds c's edge",
            ),
            (
                source(NOTE_C),
                End::Source,
                NOTE_C,
                SOURCE_FULL,
                "onto c, which holds its own edge",
            ),
        ] {
            assert_refused_for(core.check_edge_move(HELD_EDGE, end, to), words, what);
            assert_refused_for(core.update_edge(HELD_EDGE, &edit), words, what);
        }
        core.check_edge_move(HELD_EDGE, End::Target, NOTE_B)
            .expect("a move onto the end the edge holds");
        assert!(
            core.update_edge(HELD_EDGE, &target(NOTE_B))
                .unwrap()
                .is_none(),
            "a move onto the end the edge holds was queued"
        );
        assert_eq!(queued(&core), before, "a refused move was queued");

        // The witness: a free end takes the move, and the check queued nothing.
        core.check_edge_move(HELD_EDGE, End::Target, NOTE_C)
            .unwrap();
        assert_eq!(queued(&core), before, "the check queued a write");
        core.update_edge(HELD_EDGE, &target(NOTE_C)).unwrap();
        assert_eq!(queued(&core), before + 1);
    }

    #[test]
    fn a_move_check_answers_what_the_update_would_before_the_move() {
        let core = copy();
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.next-note");
        hold(&core, OTHER_EDGE, NOTE_C, NOTE_D, "mock.notes");
        assert_refused(
            core.check_edge_move("0190f3a0-0000-7000-8000-0000000000ff", End::Target, NOTE_C),
            "edge_not_found",
            "a move of an edge the copy does not hold",
        );
        assert_refused(
            core.check_edge_move(HELD_EDGE, End::Target, TASK),
            "edge_constraint_violation",
            "a move onto a task",
        );
        assert_refused(
            core.check_edge_move(HELD_EDGE, End::Target, BINNED),
            "item_not_found",
            "a move onto an item in the bin",
        );
        assert_refused(
            core.check_edge_move(HELD_EDGE, End::Target, NOTE_A),
            "edge_cycle",
            "a move onto the edge's own source",
        );
        assert_refused(
            core.check_edge_move(OTHER_EDGE, End::Target, NOTE_A),
            "validation_error",
            "a move of a many-to-many edge, whose end that stays can hold more than it",
        );
        store::meta_set(
            &core.conn().unwrap(),
            store::META_HYDRATE_STATE,
            store::HYDRATE_IN_PROGRESS,
        )
        .unwrap();
        assert_eq!(
            core.check_edge_move(HELD_EDGE, End::Target, TASK),
            Err(CoreError::HydrationIncomplete),
            "a copy part way through a hydration judged a move"
        );
    }

    #[test]
    fn a_duplicate_comes_before_cardinality_and_cardinality_before_a_cycle() {
        let core = copy();
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.next-note");
        assert_create_refused_for(
            &core,
            &edge(NOTE_A, NOTE_B, "mock.next-note"),
            DUPLICATE,
            "a repeat of a one-to-one edge, which is also a second at each end",
        );
        hold(&core, "ab", NOTE_A, NOTE_B, "mock.under");
        hold(&core, "bc", NOTE_B, NOTE_C, "mock.under");
        assert_create_refused_for(
            &core,
            &edge(NOTE_B, NOTE_A, "mock.under"),
            SOURCE_FULL,
            "a second edge from b that also closes a, b, a",
        );
        // The witness: with b's edge gone, the same edge is refused for its cycle.
        {
            let conn = core.conn().unwrap();
            conn.execute("DELETE FROM edges WHERE id = 'bc'", [])
                .unwrap();
        }
        assert_create_refused(
            &core,
            &edge(NOTE_B, NOTE_A, "mock.under"),
            "edge_cycle",
            "the edge from b that closes a, b, a",
        );
        hold(&core, "task-b", TASK, NOTE_B, "mock.notes");
        let what = "a repeat of an edge from a task, which the edge type does not admit";
        assert_eq!(
            details_of(core.check_edge(&edge(TASK, NOTE_B, "mock.notes")), what)["source_type"],
            "core.task",
            "{what}"
        );
    }

    #[test]
    fn an_inline_edge_of_a_create_counts_held_edges_and_the_ones_beside_it() {
        let core = copy();
        hold(&core, HELD_EDGE, NOTE_A, NOTE_B, "mock.child");
        let draft = |edges: &[(&str, &[&str])]| Draft {
            r#type: "core.note".into(),
            properties: json!({ "title": "made" }).as_object().unwrap().clone(),
            edges: edges
                .iter()
                .map(|(edge_type, targets)| {
                    (
                        edge_type.to_string(),
                        targets.iter().map(|target| target.to_string()).collect(),
                    )
                })
                .collect(),
            ..Draft::default()
        };
        let before = queued(&core);
        assert_refused_for(
            core.create_item(&draft(&[("mock.child", &[NOTE_B])])),
            TARGET_FULL,
            "a note made as a second parent of b",
        );
        assert_refused_for(
            core.create_item(&draft(&[("mock.next-note", &[NOTE_C, NOTE_D])])),
            SOURCE_FULL,
            "a note made with two one-to-one edges",
        );
        assert_refused_for(
            core.create_item(&draft(&[("mock.notes", &[NOTE_C, NOTE_C])])),
            DUPLICATE,
            "a note made with one edge named twice",
        );
        assert_eq!(queued(&core), before, "a refused create was queued");
        core.create_item(&draft(&[
            ("mock.notes", &[NOTE_C, NOTE_D]),
            ("mock.child", &[NOTE_C]),
        ]))
        .unwrap();
    }
}
