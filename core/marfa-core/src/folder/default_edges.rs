//! The edges a folder's `defaults.edges` ask for. A new item is given them
//! once; one refused is kept against its file, shown in the folder's status,
//! and asked again when it could now be accepted.

use super::{
    Flagged, Folder, ItemState, Map, Result, Settings, Value, local_admission_refusal,
    local_refusal_reason, state,
};
use crate::catalog::End;

/// What `queue_default_edges` did: the writes it queued and the refusals the
/// copy made.
#[derive(Default)]
pub(super) struct Defaulted {
    queued: Vec<String>,
    refused: Vec<(state::Line, String)>,
    file: bool,
}

impl Defaulted {
    /// Records them against the file.
    pub(super) fn add_to(self, writes: &mut state::Writes) {
        let save = writes.save;
        writes
            .queued
            .extend(self.queued.into_iter().map(|id| state::Queued {
                id,
                save,
                line: None,
                default: true,
            }));
        for (line, reason) in self.refused {
            refuse(writes, &line, self.file, reason);
        }
    }
}

/// What a refusal of a default edge says to the person: which edge, and how
/// to have it anyway. A document's file can write the line; a file item has
/// no lines, so its edge is made in an app, or left out of the defaults.
pub(super) fn default_reason(line: &state::Line, file: bool, reason: &str) -> String {
    let how = if file {
        "make that edge in an app, or take it out of the folder's defaults"
    } else {
        "write that line in the file to apply it"
    };
    format!(
        "{reason} (the folder's default {} edge to {} was not applied; {how})",
        line.edge_type, line.other
    )
}

fn refuse(writes: &mut state::Writes, line: &state::Line, file: bool, reason: String) {
    let change = state::Change::DefaultEdge {
        line: line.clone(),
        file,
    };
    writes
        .refused
        .retain(|refused| !change.supersedes(&refused.change));
    writes.refused.push(state::Refused {
        change,
        save: writes.save,
        reason: default_reason(line, file, &reason),
    });
}

/// The end of the edge the file is: a `parent-of` default names the parent.
fn end_of(edge_type: &str) -> End {
    if edge_type == crate::filter::PARENT_OF {
        End::Target
    } else {
        End::Source
    }
}

impl Folder {
    /// The defaults' edges for a new item. A `parent-of` default names the
    /// parent, as the child's file writes it, so a new file lands beneath
    /// what the query follows. A type the file's own frontmatter writes a
    /// line for is no blank. One the copy refuses, as the server would, flags
    /// the file at `path` and leaves the rest queued.
    pub(super) fn queue_default_edges(
        &self,
        path: &str,
        item_id: &str,
        settings: &Settings,
        front: Option<(&Map<String, Value>, &super::EdgeTypes)>,
        flagged: &mut Vec<Flagged>,
    ) -> Result<Defaulted> {
        let mut defaulted = Defaulted {
            file: front.is_none(),
            ..Defaulted::default()
        };
        for (edge_type, targets) in &settings.defaults.edges {
            let end = end_of(edge_type);
            if let Some((front, types)) = front
                && let Some(name) = types.get(edge_type).and_then(|def| def.name_at(end))
                && front.contains_key(name)
            {
                continue;
            }
            for target in targets {
                let line = state::Line {
                    edge_type: edge_type.clone(),
                    end,
                    other: target.clone(),
                };
                match self.make_default_edge(item_id, &line)? {
                    Ok(id) => defaulted.queued.push(id),
                    Err(reason) => {
                        flagged.push(Flagged::of(
                            path,
                            &default_reason(&line, defaulted.file, &reason),
                        ));
                        defaulted.refused.push((line, reason));
                    }
                }
            }
        }
        Ok(defaulted)
    }

    /// The id of the write that makes the edge, or the copy's reason for
    /// refusing it.
    fn make_default_edge(
        &self,
        item_id: &str,
        line: &state::Line,
    ) -> Result<std::result::Result<String, String>> {
        let (source_id, target_id) = match line.end {
            End::Target => (line.other.clone(), item_id.to_string()),
            End::Source => (item_id.to_string(), line.other.clone()),
        };
        match self.core.create_edge(&crate::model::EdgeDraft {
            source_id,
            target_id,
            edge_type: line.edge_type.clone(),
            ..Default::default()
        }) {
            Err(error) if local_admission_refusal(&error) => Ok(Err(local_refusal_reason(&error))),
            Err(error) => Err(error),
            Ok(queued) => Ok(Ok(queued.id)),
        }
    }

    /// Whether the copy already holds the edge a default asks for, such as one
    /// made in an app after the default was refused. An edge shown only by a
    /// write waiting to be sent counts while that write waits; one a refused
    /// write once showed does not.
    fn holds_edge(&self, item_id: &str, line: &state::Line) -> Result<bool> {
        let (source, target) = match line.end {
            End::Target => (line.other.as_str(), item_id),
            End::Source => (item_id, line.other.as_str()),
        };
        let edges = match line.end {
            End::Target => self.core.edges_to(item_id)?,
            End::Source => self.core.edges_from(item_id)?,
        };
        let waiting = |edge: &crate::model::Edge| {
            self.core.queue().map(|queue| {
                queue.iter().any(|row| {
                    row.kind == crate::model::WriteKind::CreateEdge
                        && row.verdict.is_none()
                        && row.item_id.as_deref() == Some(edge.source_id.as_str())
                        && row.target_id.as_deref() == Some(edge.target_id.as_str())
                })
            })
        };
        for edge in edges {
            if edge.edge_type == line.edge_type
                && edge.source_id == source
                && edge.target_id == target
                && (edge.version > 0 || waiting(&edge)?)
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Settles each default edge a file holds refused. It is dropped once the
    /// edge is no longer wanted: the defaults stop naming it, the file writes
    /// a line of that type, the copy holds the edge, or its item is gone or trashed. Otherwise a
    /// refusal by the copy is judged again, since what refused it can change
    /// without the file, and one by the server only after a later save of the
    /// file, since the server would refuse the same write again.
    pub(super) fn settle_default_edges(&self, settings: &Settings) -> Result<()> {
        let bounds = state::every_bound(&*self.core.conn()?)?;
        for mut bound in bounds {
            if !bound.writes.refused.iter().any(is_default) {
                continue;
            }
            let was = bound.writes.clone();
            let live = self
                .core
                .get(&bound.item_id)?
                .is_some_and(|item| item.state != ItemState::Trashed);
            let owed: Vec<state::Refused> = std::mem::take(&mut bound.writes.refused);
            for refused in owed {
                let state::Change::DefaultEdge { line, file } = &refused.change else {
                    bound.writes.refused.push(refused);
                    continue;
                };
                let wanted = live
                    && settings
                        .defaults
                        .edges
                        .get(&line.edge_type)
                        .is_some_and(|targets| targets.contains(&line.other))
                    && !bound
                        .lines
                        .iter()
                        .any(|held| held.edge_type == line.edge_type && held.end == line.end);
                if !wanted || self.holds_edge(&bound.item_id, line)? {
                    continue;
                }
                if !super::copy_refused(&refused) && refused.save >= bound.writes.save {
                    bound.writes.refused.push(refused);
                    continue;
                }
                match self.make_default_edge(&bound.item_id, line)? {
                    Ok(id) => {
                        let save = bound.writes.save;
                        bound.writes.queued.push(state::Queued {
                            id,
                            save,
                            line: None,
                            default: true,
                        });
                    }
                    Err(reason) => {
                        refuse(&mut bound.writes, line, *file, reason);
                    }
                }
            }
            if bound.writes != was {
                state::bind(&*self.core.conn()?, &bound)?;
            }
        }
        Ok(())
    }
}

fn is_default(refused: &state::Refused) -> bool {
    matches!(refused.change, state::Change::DefaultEdge { .. })
}

/// An edge a default made, answered, is held as the default it is: no line
/// of the file names it, and the file as it is now is what was refused.
pub(super) fn as_default(
    change: state::Change,
    bound: &state::Bound,
    queued: usize,
) -> state::Change {
    match change {
        state::Change::Edge { line, .. } if bound.writes.queued[queued].default => {
            state::Change::DefaultEdge {
                line,
                file: bound.blob.is_some(),
            }
        }
        other => other,
    }
}

/// The reason a refusal of `change` is shown with.
pub(super) fn reason_of(change: &state::Change, reason: String) -> String {
    match change {
        state::Change::DefaultEdge { line, file } => default_reason(line, *file, &reason),
        _ => reason,
    }
}
