//! Edge writes: moves, creates, edits and deletes, checked and queued as one
//! step like an item's.

use rusqlite::Connection;

use crate::{
    CONFLICTED_COPY_EDGE, CONFLICTED_COPY_TAG, Core, CoreError, EdgeDraft, EdgeEdit, EdgeOp, End,
    Item, ItemState, QueuedWrite, Result, WriteKind, catalog, edge_rules, model, store,
};

pub(crate) fn refuse_self_loop(edge_type: &str, from_id: &str, to_id: &str) -> Result<()> {
    if from_id == to_id {
        return Err(CoreError::Validation {
            server: None,
            code: "edge_cycle".into(),
            message: format!("an edge from {from_id} to itself closes a cycle"),
            details: Some(Box::new(serde_json::json!({ "edge_type": edge_type }))),
        });
    }
    Ok(())
}

/// The edit with each end it names that the edge already holds left out.
/// The server judges a named end against the edge it holds, which an
/// earlier waiting move may not leave where the copy shows it, so an end
/// the copy holds already is not sent.
fn ends_moved(held: &model::Edge, edit: &EdgeEdit) -> EdgeEdit {
    let mut edit = edit.clone();
    if edit.from_id.as_deref() == Some(held.from_id.as_str()) {
        edit.from_id = None;
    }
    if edit.to_id.as_deref() == Some(held.to_id.as_str()) {
        edit.to_id = None;
    }
    edit
}

/// Refuses what the server refuses of every such move whatever the rows
/// hold, judged against the edge as the copy shows it. The type is judged
/// from the catalog the copy holds; one it does not hold is left to the
/// server.
fn refuse_edge_move(conn: &Connection, held: &model::Edge, edit: &EdgeEdit) -> Result<()> {
    let (moved, from_id, to_id) = match (edit.from_id.as_deref(), edit.to_id.as_deref()) {
        (None, None) => return Ok(()),
        (Some(_), Some(_)) => {
            return Err(CoreError::Validation {
                server: None,
                code: "validation_error".into(),
                message: format!(
                    "an update moves one end of edge {} at a time; delete it and create the edge wanted",
                    held.id
                ),
                details: None,
            });
        }
        (Some(source), None) => (marfa_rules::catalog::End::From, source, held.to_id.as_str()),
        (None, Some(target)) => (marfa_rules::catalog::End::To, held.from_id.as_str(), target),
    };
    match catalog::edge_type(conn, &held.edge_type) {
        Ok(edge_type) if !edge_type.one_at(moved.other()) => {
            return Err(CoreError::Validation {
                server: None,
                code: "validation_error".into(),
                message: format!(
                    "{} is {}, so the end that stays can hold more than this edge and there is none to replace; create the edge wanted and delete this one",
                    held.edge_type, edge_type.cardinality
                ),
                details: None,
            });
        }
        Ok(_) | Err(CoreError::NotFound { .. } | CoreError::NoCatalog) => {}
        Err(error) => return Err(error),
    }
    refuse_self_loop(&held.edge_type, from_id, to_id)?;
    edge_rules::refuse_unwritable_edges(
        conn,
        &[edge_rules::Proposed {
            edge_type: &held.edge_type,
            from: edge_rules::FromEnd::Held(from_id),
            to_id,
            replacing: Some(&held.id),
        }],
    )
}

/// An edge the copy could not take is refused: no event about it would
/// reach the copy, so it would sit there as written for good. So is one the
/// server would refuse for what the copy holds.
fn refuse_unqueueable_edge(conn: &Connection, draft: &EdgeDraft) -> Result<()> {
    if let Some(id) = &draft.id {
        marfa_rules::validation::id("id", id)?;
    }
    refuse_self_loop(&draft.edge_type, &draft.from_id, &draft.to_id)?;
    marfa_rules::integers::refuse_in_value(&draft.properties)?;
    if !store::takes_edge(
        conn,
        &draft.from_id,
        &draft.edge_type,
        &store::whole_edge_types(conn)?,
    )? {
        return Err(CoreError::Invalid(format!(
            "{source} is not a row this copy holds, and {edge_type} is not an edge type its slice holds whole, so the copy cannot hold an edge from it",
            source = draft.from_id,
            edge_type = draft.edge_type,
        )));
    }
    edge_rules::refuse_unwritable_edges(
        conn,
        &[edge_rules::Proposed {
            edge_type: &draft.edge_type,
            from: edge_rules::FromEnd::Held(&draft.from_id),
            to_id: &draft.to_id,
            replacing: draft.id.as_deref(),
        }],
    )
}

/// Queues an edge, which waits on its ends' creates and on `after`.
pub(crate) fn queue_edge(
    tx: &Connection,
    draft: &EdgeDraft,
    after: &[String],
) -> Result<QueuedWrite> {
    refuse_unqueueable_edge(tx, draft)?;
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let payload = draft.payload(&id)?;
    let mut depends_on: Vec<String> = after.to_vec();
    for endpoint in [&draft.from_id, &draft.to_id] {
        for id in store::untaken_creates_for_item(tx, endpoint)? {
            if !depends_on.contains(&id) {
                depends_on.push(id);
            }
        }
    }
    store::upsert_edge(tx, &draft.wire(&id))?;
    store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::CreateEdge,
            item_id: Some(&draft.from_id),
            to_id: Some(&draft.to_id),
            edge_id: Some(&id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload,
            depends_on: &depends_on,
        },
    )
}

/// Queues an edit to edge `id`, or nothing for one that changes nothing.
fn update_edge_in(tx: &Connection, id: &str, edit: &EdgeEdit) -> Result<Option<QueuedWrite>> {
    let held = held_edge(tx, id)?;
    let Some(base) = edit.base_version else {
        return Err(CoreError::Invalid(format!(
            "an update to edge {id} carries no version; name the version the edit was based on"
        )));
    };
    if base != held.version {
        return Err(CoreError::Invalid(format!(
            "the update to edge {id} is based on version {base} and this copy holds version {}; read it again",
            held.version
        )));
    }
    let edit = &ends_moved(&held, edit);
    refuse_edge_move(tx, &held, edit)?;
    marfa_rules::integers::refuse_in_value(&edit.properties)?;
    if edit.is_empty() {
        return Ok(None);
    }
    // Queued under the old source, the write also becomes one from the new.
    if let Some(source) = &edit.from_id {
        store::refuse_removing(tx, source)?;
    }
    let payload = edit.payload(base)?;
    let mut depends_on = store::untaken_create_for_edge(tx, id)?;
    let mut next = held.clone();
    for (key, value) in &edit.properties {
        next.properties.insert(key.clone(), value.clone());
    }
    if let Some(source) = &edit.from_id {
        next.from_id = source.clone();
    }
    if let Some(target) = &edit.to_id {
        next.to_id = target.clone();
    }
    // An end moved to is an item the server has to hold first.
    for moved in [&edit.from_id, &edit.to_id].into_iter().flatten() {
        for waited in store::untaken_creates_for_item(tx, moved)? {
            if !depends_on.contains(&waited) {
                depends_on.push(waited);
            }
        }
    }
    store::hold_beneath_edge(tx, id)?;
    store::upsert_edge(tx, &next.as_wire())?;
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::UpdateEdge,
            item_id: Some(&held.from_id),
            to_id: Some(&held.to_id),
            edge_id: Some(id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: Some(base),
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    Ok(Some(queued))
}

/// Queues the removal of edge `id`.
fn delete_edge_in(tx: &Connection, id: &str) -> Result<QueuedWrite> {
    let held = held_edge(tx, id)?;
    queue_edge_delete(tx, &held, &[])
}

pub(crate) fn conflicted_copies_in(
    conn: &Connection,
    id: &str,
    unreadable: &mut store::Unreadable,
) -> Result<Vec<Item>> {
    let sources: Vec<String> = store::edges_at(conn, "to_id", id, unreadable)?
        .into_iter()
        .filter(|edge| edge.edge_type == CONFLICTED_COPY_EDGE)
        .map(|edge| edge.from_id)
        .collect();
    Ok(store::items_by_ids_with(conn, &sources, unreadable)?
        .into_iter()
        .filter(|item| {
            item.state != ItemState::Trashed
                && item.tags.iter().any(|tag| tag == CONFLICTED_COPY_TAG)
        })
        .collect())
}

fn held_edge(conn: &Connection, id: &str) -> Result<model::Edge> {
    store::edge_by_id(conn, id)?.ok_or_else(|| CoreError::NotFound {
        server: None,
        code: "edge_not_found".into(),
        message: format!("{id} is not an edge this copy holds"),
    })
}

pub(crate) fn queue_edge_delete(
    tx: &Connection,
    held: &model::Edge,
    after: &[String],
) -> Result<QueuedWrite> {
    let mut depends_on = store::untaken_create_for_edge(tx, &held.id)?;
    for waited in after {
        if !depends_on.contains(waited) {
            depends_on.push(waited.clone());
        }
    }
    // A refused delete is reconciled by reading edges by type, and the row
    // is gone from the copy by then.
    let payload = serde_json::json!({ "edge_type": held.edge_type }).to_string();
    store::hold_beneath_edge(tx, &held.id)?;
    store::delete_edge(tx, &held.id)?;
    store::removal_sent(tx, model::Subject::Edge, &held.id)?;
    store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::DeleteEdge,
            item_id: Some(&held.from_id),
            to_id: Some(&held.to_id),
            edge_id: Some(&held.id),
            namespace: None,
            tag: None,
            blob: None,
            base_version: None,
            payload: &payload,
            depends_on: &depends_on,
        },
    )
}

impl Core {
    /// Answers the refusal `create_edge` would give `draft` now, without
    /// queueing anything: what the copy can judge of the edge from the
    /// catalog, rows and edges it holds. `Ok` is not the server's verdict,
    /// which the queued write still meets.
    pub fn check_edge(&self, draft: &EdgeDraft) -> Result<()> {
        let conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        refuse_unqueueable_edge(&conn, draft)
    }

    /// Queues the edge writes in order, in one transaction with its statement
    /// journals in memory, each judged on the copy as the ones before it left
    /// it. A result is the write queued, `None` for an edit that changes
    /// nothing, or an error `tolerated` says the copy may refuse a create or
    /// an edit with: that operation leaves no trace and the rest go on. Any
    /// other error, and any error of a delete, fails the batch, and none of it
    /// is queued.
    pub fn queue_edge_ops(
        &self,
        ops: &[EdgeOp],
        tolerated: impl Fn(&CoreError) -> bool,
    ) -> Result<Vec<std::result::Result<Option<QueuedWrite>, CoreError>>> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        store::with_journals_in_memory(&mut conn, |tx| {
            let mut results = Vec::with_capacity(ops.len());
            for op in ops {
                tx.execute_batch("SAVEPOINT edge_op")?;
                let done = match op {
                    EdgeOp::Create(draft) => queue_edge(tx, draft, &[]).map(Some),
                    EdgeOp::Update { id, edit } => update_edge_in(tx, id, edit),
                    EdgeOp::Delete(id) => delete_edge_in(tx, id).map(Some),
                };
                match done {
                    Ok(queued) => {
                        tx.execute_batch("RELEASE edge_op")?;
                        results.push(Ok(queued));
                    }
                    Err(error) if !matches!(op, EdgeOp::Delete(_)) && tolerated(&error) => {
                        tx.execute_batch("ROLLBACK TO edge_op; RELEASE edge_op")?;
                        results.push(Err(error));
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(results)
        })
    }

    pub fn create_edge(&self, draft: &EdgeDraft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        store::with_journals_in_memory(&mut conn, |tx| queue_edge(tx, draft, &[]))
    }

    /// A move of an end goes in the same write as the properties, so the
    /// edge is never absent between two writes. An edit that names no
    /// property and moves no end the copy does not already hold queues
    /// nothing and answers `None`: the server would take it, bump the edge's
    /// version and announce a change that never happened
    /// (`queue-and-verdicts/edge-edit-no-change`).
    pub fn update_edge(&self, id: &str, edit: &EdgeEdit) -> Result<Option<QueuedWrite>> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        store::with_journals_in_memory(&mut conn, |tx| update_edge_in(tx, id, edit))
    }

    /// Answers the refusal `update_edge` would give a move of edge `id`'s
    /// `end` to item `to` now, without queueing anything and whatever
    /// version the edit would carry. A move onto the end the edge holds
    /// already changes nothing and is refused nothing. `Ok` is not the
    /// server's verdict, which the queued write still meets.
    pub fn check_edge_move(&self, id: &str, end: End, to: &str) -> Result<()> {
        let conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        let held = held_edge(&conn, id)?;
        let to = Some(to.to_string());
        let edit = match end {
            End::From => EdgeEdit {
                from_id: to,
                ..EdgeEdit::default()
            },
            End::To => EdgeEdit {
                to_id: to,
                ..EdgeEdit::default()
            },
        };
        refuse_edge_move(&conn, &held, &ends_moved(&held, &edit))
    }

    pub fn delete_edge(&self, id: &str) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        store::refuse_unless_whole(&conn)?;
        store::with_journals_in_memory(&mut conn, |tx| delete_edge_in(tx, id))
    }
}
