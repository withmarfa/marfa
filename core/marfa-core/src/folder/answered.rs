//! A folder takes out of its queue the answered writes it has recorded what
//! it needs from, so what each drain reads stays the size of what is still to
//! be answered or kept, not of every write the folder has sent
//! (`folders/clears-recorded-answers`). It takes out too the refused edge
//! creates it has proved it no longer needs, which nothing shows a person
//! (`folders/clears-satisfied-edge-refusal`,
//! `folders/clears-repeated-edge-refusal`).

use std::collections::HashSet;

use rusqlite::Connection;

use super::{Folder, PLACEMENT_EDGE, relink, state};
use crate::catalog::End;
use crate::model::EdgeDraft;
use crate::{Result, store};

impl Folder {
    /// Clears the answered writes, as a drain begins, where the queue holds
    /// one the clearing could take. An answered write leaving the queue
    /// changes nothing a pull reads, so a quiet folder stays quiet. Answers
    /// how many writes left the queue.
    pub(super) fn clear_answered_if_due(&self) -> Result<usize> {
        let due = {
            let conn = self.core.conn()?;
            store::holds_clearable_answers(&conn)?
                || (store::holds_refused_edge_create(&conn)?
                    && match self.unrecorded(&conn)? {
                        Some(kept) => !settled_edge_refusals(&conn, &kept)?.is_empty(),
                        None => false,
                    })
        };
        if due { self.clear_answered() } else { Ok(0) }
    }

    /// Clears the answered writes as `store::forget_answered` does, but for
    /// each whose answer the folder has yet to record, and the refused edge
    /// creates that are settled. Clears nothing until the server's origin is
    /// the copy's, as a drain changes nothing before it is
    /// (`device/origin-unconfirmed-keeps-copy`). Answers how many writes left
    /// the queue.
    pub(super) fn clear_answered(&self) -> Result<usize> {
        self.core.lock.refuse_unless_writer()?;
        if !self
            .core
            .http()
            .is_ok_and(crate::http::Http::origin_admitted)
        {
            return Ok(0);
        }
        let mut conn = self.core.conn()?;
        let tx = conn.transaction()?;
        crate::body::rule::after_answers_in(&tx, None)?;
        let Some(kept) = self.unrecorded(&tx)? else {
            return Ok(0);
        };
        let mut cleared = store::forget_answered_except(&tx, &kept)?;
        for id in settled_edge_refusals(&tx, &kept)? {
            if store::discard(&tx, &id)? {
                cleared += 1;
            }
        }
        tx.commit()?;
        Ok(cleared)
    }

    /// The writes whose answer the folder has yet to record, by id: each a
    /// file's record still waits on, and each a link rewrite has yet to
    /// settle. `None` where a file's record cannot be read, which may name
    /// any write. What else reads an answer is kept by `forget_answered`'s
    /// own rules: a give-way reads refused edge creates, which carry content,
    /// and blocked writes; the body rule has read every answer it follows
    /// before this, in the same transaction, and a waiting link edge depends
    /// on the body write it was read from.
    fn unrecorded(&self, conn: &Connection) -> Result<Option<HashSet<String>>> {
        let Ok(mut kept) = store::awaited_by_files(conn) else {
            return Ok(None);
        };
        kept.extend(relink::unsettled(conn)?);
        Ok(Some(kept))
    }
}

/// The refused edge creates the folder no longer needs, by id: each whose edge
/// the server has given the copy and whose refusal no file shows, and each a
/// later create of the same edge carries. Going, one changes nothing but the
/// queue, since a file's flag and its reason are in the file's record. A
/// placement is left to the folder's own settling, which reads its refusal,
/// and `kept` names what the folder has yet to record.
fn settled_edge_refusals(conn: &Connection, kept: &HashSet<String>) -> Result<Vec<String>> {
    let mut settled = Vec::new();
    for refused in store::refused_edge_creates(conn)? {
        if refused.asked.edge_type != PLACEMENT_EDGE
            && !kept.contains(&refused.id)
            && (refused.carried_by_later_create(conn)?
                || (refused.satisfied_by_server(conn)? && !shown_by_a_file(conn, &refused.asked)?))
            && refused.nothing_rests_on_it(conn)?
        {
            settled.push(refused.id);
        }
    }
    Ok(settled)
}

/// Whether a file at either end of the edge still shows a refusal of it.
fn shown_by_a_file(conn: &Connection, edge: &EdgeDraft) -> Result<bool> {
    let ends = [
        (&edge.source_id, End::Source, &edge.target_id),
        (&edge.target_id, End::Target, &edge.source_id),
    ];
    for (item, end, other) in ends {
        let line = state::Line {
            edge_type: edge.edge_type.clone(),
            end,
            other: other.clone(),
        };
        let bound = state::every_bound_to_item(conn, item)?;
        if bound.iter().any(|bound| shows(bound, &line)) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn shows(bound: &state::Bound, line: &state::Line) -> bool {
    bound.writes.refused.iter().any(|refused| {
        matches!(
            &refused.change,
            state::Change::Edge { line: shown, .. } | state::Change::DefaultEdge { line: shown, .. }
                if shown == line
        )
    }) || bound
        .writes
        .landing
        .as_ref()
        .and_then(|landing| landing.before.as_deref())
        .is_some_and(|before| shows(before, line))
}
