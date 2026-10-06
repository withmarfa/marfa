use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::edge_types::{self, EdgeTypes};
use super::embeds::{self, ATTACHMENT_EDGE, Target};
use super::state::{self, Line};
use super::{FILE_TYPE, Folder, LINK_EDGE, PLACEMENT_EDGE, bytes_of, fields};
use crate::Result;
use crate::body::resolve::{self, Names, Paths, Resolved, Resolver, is_id, resolve_reference};
use crate::body::text::{self, Typed};
use crate::catalog::Catalog;
use crate::catalog::{EdgeType, End};
use crate::model::{Edge, EdgeDraft, EdgeEdit, Item};

/// A file's links and lines, read once every file in the scan is bound.
pub(super) struct EdgeWork {
    pub path: String,
    pub item_id: String,
    pub links: Vec<String>,
    pub front: Map<String, Value>,
    pub had_links: Vec<String>,
    pub had_lines: Vec<Line>,
    pub embeds: Vec<(String, Target)>,
}

pub(super) struct Outcome {
    pub links: Vec<String>,
    pub lines: Vec<Line>,
    pub held: Option<String>,
    /// The edge writes the lines queued, so only their refusal holds the file.
    pub queued: Vec<String>,
    /// Embeds that name no file the folder sends, and why.
    pub embeds: Vec<String>,
}

/// The files on disk a folder has bound to items.
pub(super) struct BoundFiles;

impl Paths for BoundFiles {
    fn every(&self, conn: &Connection) -> Result<Vec<(String, String)>> {
        state::bound_paths(conn)
    }

    fn of(&self, conn: &Connection, id: &str) -> Result<Vec<String>> {
        Ok(state::bound_to_item(conn, id)?
            .map(|bound| bound.path)
            .into_iter()
            .collect())
    }
}

/// A file's lines by name, and the edges they name.
type Written = (Vec<(String, Value)>, Vec<Line>);

impl Resolved {
    /// The item found, or `None` with the reason a line names nothing.
    fn settled(
        self,
        raw: &str,
        name: &str,
        reasons: &mut Vec<String>,
        waiting: &mut bool,
    ) -> Option<(String, Option<String>)> {
        let why = match self {
            Resolved::Found { id, r#type } => return Some((id, r#type)),
            Resolved::Unmatched => "matches no item".to_string(),
            Resolved::Ambiguous => {
                "matches more than one item; name one by its id, [[<id>]]".to_string()
            }
            Resolved::Waiting => {
                *waiting = true;
                "is looked up once the server can be asked".to_string()
            }
            Resolved::Unanswered(why) => {
                format!("could not be looked up ({why}); name it by its id, [[<id>]]")
            }
        };
        reasons.push(format!("[[{raw}]] in its {name} {why}"));
        None
    }
}

struct Group<'t> {
    name: String,
    edge_type: &'t EdgeType,
    end: End,
    typed: Option<std::result::Result<Vec<Typed>, String>>,
}

impl Folder {
    /// Whether the item can carry frontmatter, where the copy holds it: a
    /// file item's file is its bytes.
    fn carries(&self, id: &str, catalog: &Catalog) -> Result<Option<bool>> {
        Ok(self
            .core
            .get(id)?
            .map(|item| !catalog.matches(FILE_TYPE, &item.r#type)))
    }

    /// The item whose file writes an edge, and its end; the other end writes
    /// it only where the named end's file is its bytes.
    pub(super) fn writer_of(
        &self,
        edge: &Edge,
        types: &EdgeTypes,
        catalog: &Catalog,
    ) -> Result<Option<(String, End)>> {
        if edge.edge_type == PLACEMENT_EDGE {
            return Ok(None);
        }
        let Some(def) = types.get(&edge.edge_type) else {
            return Ok(None);
        };
        let at = |end: End| match end {
            End::Source => edge.source_id.clone(),
            End::Target => edge.target_id.clone(),
        };
        let named = def.written_at;
        if self.carries(&at(named), catalog)? != Some(false) {
            return Ok(Some((at(named), named)));
        }
        let other = named.other();
        if def.name_at(other).is_none() || self.carries(&at(other), catalog)? == Some(false) {
            return Ok(None);
        }
        Ok(Some((at(other), other)))
    }

    fn edges_at(&self, id: &str) -> Result<Vec<Edge>> {
        let mut edges = self.core.edges_from(id)?;
        for edge in self.core.edges_to(id)? {
            if !edges.iter().any(|held| held.id == edge.id) {
                edges.push(edge);
            }
        }
        Ok(edges)
    }

    pub(super) fn written_ends(
        &self,
        item: &Item,
        types: &EdgeTypes,
        catalog: &Catalog,
        recorded: &[Line],
    ) -> Result<Vec<String>> {
        let mut ends = Vec::new();
        for edge in self.edges_at(&item.id)? {
            if let Some(end) = self.writes(&item.id, &edge, types, catalog, recorded)? {
                ends.push(match end {
                    End::Source => edge.target_id,
                    End::Target => edge.source_id,
                });
            }
        }
        Ok(ends)
    }

    /// The end an item's file writes `edge` at; a file keeps a line it typed
    /// where the copy cannot tell the writer's kind, so it is never erased.
    fn writes(
        &self,
        item_id: &str,
        edge: &Edge,
        types: &EdgeTypes,
        catalog: &Catalog,
        recorded: &[Line],
    ) -> Result<Option<End>> {
        let Some((writer, end)) = self.writer_of(edge, types, catalog)? else {
            return Ok(None);
        };
        if writer == item_id {
            return Ok(Some(end));
        }
        let mine = end.other();
        let other = match mine {
            End::Source => &edge.target_id,
            End::Target => &edge.source_id,
        };
        let typed_here = recorded.iter().any(|line| {
            line.edge_type == edge.edge_type && line.end == mine && &line.other == other
        });
        Ok((typed_here && self.carries(&writer, catalog)?.is_none()).then_some(mine))
    }

    /// The lines an item's file carries, a typed target kept as typed while
    /// it still names its item, since a rewrite must not move a person's text.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lines_for(
        &self,
        item: &Item,
        types: &EdgeTypes,
        catalog: &Catalog,
        names: &Names,
        typed: Option<&Map<String, Value>>,
        (body_links, body_embeds): (&[String], &[String]),
        recorded: &[Line],
    ) -> Result<Written> {
        let mut grouped: BTreeMap<String, (bool, Vec<String>)> = BTreeMap::new();
        let mut written = Vec::new();
        for edge in self.edges_at(&item.id)? {
            let Some(end) = self.writes(&item.id, &edge, types, catalog, recorded)? else {
                continue;
            };
            let Some(def) = types.get(&edge.edge_type) else {
                continue;
            };
            let other = match end {
                End::Source => edge.target_id.clone(),
                End::Target => edge.source_id.clone(),
            };
            if edge.edge_type == LINK_EDGE && end == End::Source && body_links.contains(&other) {
                continue;
            }
            // The body shows it, so no line repeats it; the record still does.
            if edge.edge_type == ATTACHMENT_EDGE
                && end == End::Target
                && body_embeds.contains(&other)
            {
                written.push(Line {
                    edge_type: edge.edge_type.clone(),
                    end,
                    other,
                });
                continue;
            }
            let Some(name) = def.name_at(end) else {
                continue;
            };
            let as_typed = match typed.and_then(|typed| typed.get(name)) {
                Some(value) => {
                    let mut kept = None;
                    for typed in edge_types::typed(value).unwrap_or_default() {
                        if resolve::answers_to(
                            &*self.core.conn()?,
                            catalog,
                            &BoundFiles,
                            &typed.name,
                            &other,
                        )? {
                            kept = Some(typed.raw);
                            break;
                        }
                    }
                    kept
                }
                None => None,
            };
            // Where the copy cannot tell who writes it, only the person's own
            // line shows it; an embed's record alone never becomes a line.
            if as_typed.is_none()
                && !self
                    .writer_of(&edge, types, catalog)?
                    .is_some_and(|(writer, _)| writer == item.id)
            {
                written.push(Line {
                    edge_type: def.id.clone(),
                    end,
                    other,
                });
                continue;
            }
            let shown = match as_typed {
                Some(text) => text,
                None => self.shown_as(&other, catalog, names)?,
            };
            let entry = grouped
                .entry(name.to_string())
                .or_insert((def.one_at(end), Vec::new()));
            entry.1.push(text::render_link(&shown));
            written.push(Line {
                edge_type: def.id.clone(),
                end,
                other,
            });
        }
        let lines = grouped
            .into_iter()
            .map(|(name, (one, mut shown))| {
                let value = if one && shown.len() == 1 {
                    Value::String(shown.remove(0))
                } else {
                    Value::Array(shown.into_iter().map(Value::String).collect())
                };
                (name, value)
            })
            .collect();
        written.sort();
        Ok((lines, written))
    }

    fn title_or_id(&self, id: &str, catalog: &Catalog) -> Result<String> {
        Ok(self
            .core
            .get(id)?
            .and_then(|item| {
                item.properties
                    .get(fields::title_field(catalog, &item.r#type))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| id.to_string()))
    }

    /// How a line names an item: its title where that names it alone in this
    /// copy and can be written inside a link, and its id otherwise.
    fn shown_as(&self, id: &str, catalog: &Catalog, names: &Names) -> Result<String> {
        let Some(item) = self.core.get(id)? else {
            return Ok(id.to_string());
        };
        let title = item
            .properties
            .get(fields::title_field(catalog, &item.r#type))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let alone = names
            .of(title)
            .is_some_and(|ids| ids.len() == 1 && ids.contains(id));
        let writable =
            !title.is_empty() && !is_id(title) && !title.contains(['[', ']', '|', '#', '\n']);
        Ok(if alone && writable {
            title.to_string()
        } else {
            id.to_string()
        })
    }

    /// Queues what a file's links, embeds and lines change; a line read no way
    /// it was written changes nothing of its type.
    pub(super) fn queue_edges(
        &self,
        work: &EdgeWork,
        types: &EdgeTypes,
        catalog: &Catalog,
        resolver: &mut Resolver<'_>,
    ) -> Result<Outcome> {
        let item_id = work.item_id.as_str();
        let mut reasons: Vec<String> = Vec::new();
        let mut queued: Vec<String> = Vec::new();
        let mut waiting = false;

        let edges = self.edges_at(item_id)?;
        let references: Vec<&Edge> = edges
            .iter()
            .filter(|edge| edge.edge_type == LINK_EDGE && edge.source_id == item_id)
            .collect();
        let mut named: Vec<String> = Vec::new();
        let mut links_resolved = true;
        for raw in &work.links {
            let typed = Typed::new(raw);
            let resolved = resolve_reference(&typed, |text| {
                self.resolve_typed(
                    text,
                    &references,
                    &|edge| edge.target_id.clone(),
                    catalog,
                    resolver,
                )
            })?;
            match resolved.settled(raw, "body", &mut reasons, &mut waiting) {
                Some((id, _)) if id == item_id => {}
                Some((id, _)) if !named.contains(&id) => named.push(id),
                Some(_) => {}
                // A link naming nothing looks like a link removed.
                None => links_resolved = false,
            }
        }

        // An embed of a file is its item's `attached-to` edge to this one; one
        // naming no file here stands removals down, as a link does, and says so.
        let mut attached: Vec<String> = Vec::new();
        let mut embeds_resolved = true;
        let mut embed_reasons: Vec<String> = Vec::new();
        for (raw, target) in &work.embeds {
            let item = match target {
                Target::At(path) => self.embedded_item(path, catalog)?,
                _ => None,
            };
            match (item, target) {
                (Some(Some(id)), _) if !attached.contains(&id) => attached.push(id),
                (Some(_), _) => {}
                (None, Target::Outside) => embed_reasons.push(embeds::reason(raw, target)),
                (None, _) => {
                    embeds_resolved = false;
                    embed_reasons.push(embeds::reason(raw, target));
                }
            }
        }

        let mut groups: BTreeMap<(String, End), Group<'_>> = BTreeMap::new();
        for (key, value) in &work.front {
            let Some((def, end)) = types.named(key) else {
                continue;
            };
            if def.id == PLACEMENT_EDGE {
                reasons.push(format!(
                    "its {key} line is not read: a file's place in the folder is where it sits"
                ));
                continue;
            }
            groups.insert(
                (def.id.clone(), end),
                Group {
                    name: key.clone(),
                    edge_type: def,
                    end,
                    typed: Some(edge_types::typed(value)),
                },
            );
        }
        let recorded_keys: BTreeSet<(String, End)> = work
            .had_lines
            .iter()
            .map(|line| (line.edge_type.clone(), line.end))
            .collect();
        let mut wanted_keys = recorded_keys;
        if !work.links.is_empty() || !work.had_links.is_empty() {
            wanted_keys.insert((LINK_EDGE.to_string(), End::Source));
        }
        if !work.embeds.is_empty() {
            wanted_keys.insert((ATTACHMENT_EDGE.to_string(), End::Target));
        }
        for (edge_type, end) in wanted_keys {
            let Some(def) = types.get(&edge_type) else {
                continue;
            };
            let Some(name) = def.name_at(end) else {
                continue;
            };
            groups.entry((edge_type, end)).or_insert_with(|| Group {
                name: name.to_string(),
                edge_type: def,
                end,
                typed: None,
            });
        }

        let mut lines: Vec<Line> = Vec::new();
        for ((edge_type, end), group) in &groups {
            let (edge_type, end) = (edge_type.as_str(), *end);
            let other_of = |edge: &Edge| match end {
                End::Source => edge.target_id.clone(),
                End::Target => edge.source_id.clone(),
            };
            let current: Vec<&Edge> = edges
                .iter()
                .filter(|edge| {
                    edge.edge_type == edge_type
                        && match end {
                            End::Source => edge.source_id == item_id,
                            End::Target => edge.target_id == item_id,
                        }
                })
                .collect();
            let recorded: Vec<String> = work
                .had_lines
                .iter()
                .filter(|line| line.edge_type == edge_type && line.end == end)
                .map(|line| line.other.clone())
                .collect();
            let desired = self.desired(
                group,
                item_id,
                &current,
                &other_of,
                catalog,
                resolver,
                &mut reasons,
                &mut waiting,
            )?;
            let links_group = edge_type == LINK_EDGE && end == End::Source;
            let embeds_group = edge_type == ATTACHMENT_EDGE && end == End::Target;
            let Some(desired) = desired else {
                lines.extend(recorded.into_iter().map(|other| Line {
                    edge_type: edge_type.to_string(),
                    end,
                    other,
                }));
                if links_group {
                    // Every change to this edge type stands down, the body's
                    // links among them.
                    links_resolved = false;
                    named.retain(|id| work.had_links.contains(id));
                }
                continue;
            };
            let mut wanted: Vec<String> = desired.clone();
            let mut had: Vec<String> = recorded.clone();
            if links_group {
                for id in &named {
                    if !wanted.contains(id) {
                        wanted.push(id.clone());
                    }
                }
                had.extend(work.had_links.iter().cloned());
            }
            // The body's embeds and the line say the same edge; the record
            // holds both, so taking either out removes it.
            let mut shown = desired;
            if embeds_group {
                for id in &attached {
                    if !wanted.contains(id) {
                        wanted.push(id.clone());
                        shown.push(id.clone());
                    }
                }
                if !embeds_resolved {
                    for id in &recorded {
                        if !shown.contains(id) {
                            shown.push(id.clone());
                        }
                    }
                }
            }
            let held: Vec<String> = current.iter().map(|edge| other_of(edge)).collect();
            let adds: Vec<&String> = wanted.iter().filter(|id| !held.contains(id)).collect();
            // An edge the file never carried arrived from elsewhere and is
            // not yet written; a link or an embed that names nothing looks
            // like one gone.
            let may_remove = (!links_group || links_resolved) && (!embeds_group || embeds_resolved);
            let mut removes: Vec<&Edge> = current
                .iter()
                .copied()
                .filter(|edge| {
                    let other = other_of(edge);
                    may_remove && had.contains(&other) && !wanted.contains(&other)
                })
                .collect();
            let draft = |other: &str| match end {
                End::Source => EdgeDraft {
                    source_id: item_id.to_string(),
                    target_id: other.to_string(),
                    edge_type: edge_type.to_string(),
                    ..Default::default()
                },
                End::Target => EdgeDraft {
                    source_id: other.to_string(),
                    target_id: item_id.to_string(),
                    edge_type: edge_type.to_string(),
                    ..Default::default()
                },
            };
            if group.edge_type.one_at(end) && adds.len() == 1 && !current.is_empty() {
                // Only an edge this file showed is its to replace; one it never
                // showed would be dropped unseen.
                let Some(old) = current
                    .iter()
                    .find(|edge| had.contains(&other_of(edge)) && !wanted.contains(&other_of(edge)))
                    .copied()
                else {
                    let held = self.title_or_id(&other_of(current[0]), catalog)?;
                    reasons.push(format!(
                        "its {} line names another item, and this one already has [[{held}]] from elsewhere, which the file has not shown yet; take the line out to see it",
                        group.name
                    ));
                    lines.extend(recorded.into_iter().map(|other| Line {
                        edge_type: edge_type.to_string(),
                        end,
                        other,
                    }));
                    continue;
                };
                // One write moves the other end, so the end is never without its edge.
                let moved = draft(adds[0]);
                let edit = EdgeEdit {
                    // Unchanged on the version named, and what remakes the edge if another machine deleted it.
                    properties: old.properties.clone(),
                    base_version: Some(old.version),
                    source_id: (end == End::Target).then_some(moved.source_id),
                    target_id: (end == End::Source).then_some(moved.target_id),
                };
                queued.push(self.core.update_edge(&old.id, &edit)?.id);
                removes.retain(|edge| edge.id != old.id);
            } else {
                for other in adds {
                    queued.push(self.core.create_edge(&draft(other))?.id);
                }
            }
            for edge in removes {
                queued.push(self.core.delete_edge(&edge.id)?.id);
            }
            lines.extend(shown.into_iter().map(|other| Line {
                edge_type: edge_type.to_string(),
                end,
                other,
            }));
        }

        let links = if links_resolved {
            named
        } else {
            let mut kept = named;
            for id in &work.had_links {
                if !kept.contains(id) {
                    kept.push(id.clone());
                }
            }
            kept
        };
        lines.sort();
        let held = (!reasons.is_empty()).then(|| {
            let prefix = if waiting {
                state::EDGES_WAITING
            } else {
                state::EDGES
            };
            format!("{prefix}{}", reasons.join("; "))
        });
        Ok(Outcome {
            links,
            lines,
            held,
            queued,
            embeds: embed_reasons,
        })
    }

    /// The item of the file an embed names: `Some(None)` for one that is not
    /// a file item, and `None` where no file here is bound at the path.
    fn embedded_item(&self, path: &str, catalog: &Catalog) -> Result<Option<Option<String>>> {
        let Some(bound) = state::bound_at(&*self.core.conn()?, path)? else {
            return Ok(None);
        };
        Ok(Some(
            self.core
                .get(&bound.item_id)?
                .filter(|item| bytes_of(item, catalog).is_some())
                .map(|item| item.id),
        ))
    }

    /// The items a group's line names, or `None` where it changes nothing,
    /// with the reason added.
    #[allow(clippy::too_many_arguments)]
    fn desired(
        &self,
        group: &Group<'_>,
        item_id: &str,
        current: &[&Edge],
        other_of: &dyn Fn(&Edge) -> String,
        catalog: &Catalog,
        resolver: &mut Resolver<'_>,
        reasons: &mut Vec<String>,
        waiting: &mut bool,
    ) -> Result<Option<Vec<String>>> {
        let name = &group.name;
        let texts = match &group.typed {
            None => return Ok(Some(Vec::new())),
            Some(Err(why)) => {
                reasons.push(format!("its {name} line changes nothing: {why}"));
                return Ok(None);
            }
            Some(Ok(texts)) => texts,
        };
        let mut found: Vec<(String, Option<String>)> = Vec::new();
        let mut stood_down = false;
        for typed in texts {
            let raw = &typed.raw;
            let resolved = resolve_reference(typed, |text| {
                self.resolve_typed(text, current, other_of, catalog, resolver)
            })?;
            let Some((id, r#type)) =
                resolved.settled(raw, &format!("{name} line"), reasons, waiting)
            else {
                stood_down = true;
                continue;
            };
            if id == item_id {
                reasons.push(format!("its {name} line names this file's own item"));
                stood_down = true;
                continue;
            }
            if !found.iter().any(|(held, _)| held == &id) {
                found.push((id, r#type));
            }
        }
        if stood_down {
            return Ok(None);
        }
        if group.edge_type.one_at(group.end) && found.len() > 1 {
            reasons.push(format!(
                "its {name} line names {} items, and an item is {name} one at most",
                found.len()
            ));
            return Ok(None);
        }
        // At the end its type does not name, a line is the fallback for an
        // item that cannot carry frontmatter, and nothing else.
        if group.end != group.edge_type.written_at {
            let belongs = group
                .edge_type
                .name_at(group.edge_type.written_at)
                .unwrap_or(&group.edge_type.id);
            for (id, r#type) in &found {
                if r#type
                    .as_deref()
                    .is_some_and(|r#type| !catalog.matches(FILE_TYPE, r#type))
                {
                    let title = self.title_or_id(id, catalog)?;
                    reasons.push(format!(
                        "its {name} line is at the wrong end: [[{title}]]'s own file writes it, as {belongs}"
                    ));
                    return Ok(None);
                }
            }
        }
        Ok(Some(found.into_iter().map(|(id, _)| id).collect()))
    }

    /// Rendering is also used to detect unsaved edits, so it must resolve
    /// names from the copy alone, without a network-dependent answer.
    pub(super) fn body_links(
        &self,
        item: &Item,
        body: &str,
        catalog: &Catalog,
        names: &Names,
    ) -> Result<Vec<String>> {
        let references: Vec<String> = self
            .core
            .edges_from(&item.id)?
            .into_iter()
            .filter(|edge| edge.edge_type == LINK_EDGE)
            .map(|edge| edge.target_id)
            .collect();
        let mut found = Vec::new();
        for raw in text::links(body) {
            let resolved = resolve_reference(&Typed::new(&raw), |text| {
                if let Some(resolved) =
                    resolve::existing(&*self.core.conn()?, catalog, &BoundFiles, text, &references)?
                {
                    return Ok(resolved);
                }
                if is_id(text) {
                    return Ok(match self.core.get(text)? {
                        Some(item) => Resolved::Found {
                            id: item.id,
                            r#type: Some(item.r#type),
                        },
                        None => Resolved::Unmatched,
                    });
                }
                Ok(match names.of(text) {
                    Some(ids) if ids.len() == 1 => Resolved::Found {
                        id: ids.iter().next().expect("one").clone(),
                        r#type: None,
                    },
                    Some(_) => Resolved::Ambiguous,
                    None => Resolved::Unmatched,
                })
            })?;
            if let Resolved::Found { id, .. } = resolved
                && id != item.id
                && !found.contains(&id)
            {
                found.push(id);
            }
        }
        Ok(found)
    }

    /// A typed name as the edge it already names, or else as the resolver
    /// reads it.
    fn resolve_typed(
        &self,
        text: &str,
        current: &[&Edge],
        other_of: &dyn Fn(&Edge) -> String,
        catalog: &Catalog,
        resolver: &mut Resolver<'_>,
    ) -> Result<Resolved> {
        let others: Vec<String> = current.iter().map(|edge| other_of(edge)).collect();
        if let Some(resolved) =
            resolve::existing(&*self.core.conn()?, catalog, &BoundFiles, text, &others)?
        {
            return Ok(resolved);
        }
        resolver.resolve(text)
    }
}
