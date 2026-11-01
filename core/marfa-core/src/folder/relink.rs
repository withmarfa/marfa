//! Wiki links to an item retitled since they were written, rewritten in the
//! bodies of this folder's documents to name it by its new title, as Obsidian
//! does (`folders/body-link-retitled`).

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::PullReport;
use super::lines::BoundFiles;
use super::{Folder, bytes_of, fields, state};
use crate::body::resolve::{self, Names, is_id};
use crate::body::rule::{self, BodyTarget};
use crate::body::text::{self, Typed};
use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{Edit, ItemState, Subject, Verdict};
use crate::{Based, Body, Result, store};

/// The meta key of a rewrite this folder queued, by its write's id, so the
/// next pull settles it.
const QUEUED: &str = "folder_relink/";
/// The meta key of a document whose rewrite the server refused, holding the
/// version it was refused at: the rewrite is not tried again until the
/// document changes.
const REFUSED: &str = "folder_relink_refused/";

/// What a stale link's name becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Renamed {
    /// The item's new title, which names it alone.
    Title(String),
    /// The item's id, where its title would name another item too or cannot
    /// be a link's name; the link shows the name it had.
    Id(String),
}

impl Folder {
    /// Settles the rewrites queued earlier, then queues one for each
    /// document here whose body links to an item by a name that no longer
    /// names it. Answers whether the copy changed, so the pull writes the
    /// files again.
    pub(super) fn relink(&self, report: &mut PullReport) -> Result<bool> {
        let mut changed = self.settle_relinks()?;
        let hosts = {
            let conn = self.core.conn()?;
            linking_hosts(&conn)?
        };
        if hosts.is_empty() {
            return Ok(changed);
        }
        let (catalog, names) = {
            let conn = self.core.conn()?;
            let catalog = Catalog::load(&conn)?;
            let names = Names::load(&conn, &catalog, &BoundFiles)?;
            (catalog, names)
        };
        for host in hosts {
            let Some(edit) = self.relinked_body(&host, &catalog, &names)? else {
                continue;
            };
            match self
                .core
                .write_update(&host, &edit, Based::Exact, Body::Folder)
            {
                Ok(write) => {
                    store::meta_set(&*self.core.conn()?, &format!("{QUEUED}{}", write.id), &host)?;
                    report.relinked += 1;
                    changed = true;
                }
                // The copy will not take the edit as it stands; the next
                // change to the document tries again.
                Err(
                    CoreError::Invalid(_)
                    | CoreError::Validation { .. }
                    | CoreError::NotFound { .. }
                    | CoreError::UnknownType { .. },
                ) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(changed)
    }

    /// The edit that rewrites `host`'s stale links, where the folder may
    /// write its body now: its file is as the folder last read or wrote it,
    /// nothing holds it, no write of it waits, and each item it links to took
    /// its new title on the server.
    fn relinked_body(&self, host: &str, catalog: &Catalog, names: &Names) -> Result<Option<Edit>> {
        let conn = self.core.conn()?;
        let Some(bound) = state::bound_to_item(&conn, host)? else {
            return Ok(None);
        };
        if bound.held.is_some()
            || !bound.writes.queued.is_empty()
            || !bound.writes.refused.is_empty()
            || bound.writes.landing.is_some()
        {
            return Ok(None);
        }
        let Some(item) = store::item_by_id(&conn, host)? else {
            return Ok(None);
        };
        if bytes_of(&item, catalog).is_some()
            || !matches!(item.state, ItemState::Active | ItemState::Archived)
            || row_waits(&conn, host)?
        {
            return Ok(None);
        }
        let refused_at = store::meta_get(&conn, &format!("{REFUSED}{host}"))?;
        if refused_at.is_some_and(|version| version == item.version.to_string()) {
            return Ok(None);
        }
        // Bytes the person changed since are theirs, and the scan sends them.
        match self.read(self.root.join(&bound.path)) {
            Ok(bytes) if state::hash(&bytes) == bound.content_hash => {}
            _ => return Ok(None),
        }
        let mut renamed: HashMap<String, Renamed> = HashMap::new();
        for link in rule::read(&conn, host)?.links {
            let BodyTarget::Item { id } = &link.target else {
                continue;
            };
            if id == host
                || resolve::answers_to(&conn, catalog, &BoundFiles, &link.name, id)?
                // A title this copy has not heard the server take names
                // nothing yet.
                || row_waits(&conn, id)?
            {
                continue;
            }
            let Some(target) = store::item_by_id(&conn, id)? else {
                continue;
            };
            let title = target
                .properties
                .get(fields::title_field(catalog, &target.r#type))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let raw = link
                .text
                .strip_prefix("[[")
                .and_then(|inner| inner.strip_suffix("]]"))
                .unwrap_or(&link.text);
            renamed.insert(raw.to_string(), renamed_to(title, id, names));
        }
        if renamed.is_empty() {
            return Ok(None);
        }
        let field = fields::body_field(catalog, &item.r#type);
        let body = rule::body_of(catalog, &item);
        let new = rewritten(body, &renamed);
        if new == body {
            return Ok(None);
        }
        let mut properties = Map::new();
        properties.insert(field.to_string(), Value::String(new));
        Ok(Some(Edit {
            properties,
            base_version: Some(item.version),
            ..Edit::default()
        }))
    }

    /// Forgets each rewrite the server took. One it refused is taken out of
    /// the queue and not tried again until the document changes; one that
    /// met another writer's change (`version_conflict`) is withdrawn, and
    /// worked out again against what the server holds.
    fn settle_relinks(&self) -> Result<bool> {
        let queued: Vec<(String, String)> = {
            let conn = self.core.conn()?;
            let mut statement = conn.prepare("SELECT key, value FROM meta WHERE key LIKE ?1")?;
            statement
                .query_map([format!("{QUEUED}%")], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut changed = false;
        for (key, host) in queued {
            let id = &key[QUEUED.len()..];
            let row = store::queued_write(&*self.core.conn()?, id)?;
            let settled = match row {
                None => true,
                Some(row) => match row.verdict {
                    Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted) => true,
                    Some(Verdict::Refused) => {
                        if let Some(version) = row.base_version {
                            store::meta_set(
                                &*self.core.conn()?,
                                &format!("{REFUSED}{host}"),
                                &version.to_string(),
                            )?;
                        }
                        let discarded = self.core.discard(id)?;
                        changed |= discarded;
                        discarded
                    }
                    // A write the person made behind it is theirs to settle,
                    // and withdrawing this one would refuse it.
                    Some(Verdict::Blocked)
                        if row.withdrawable()
                            && store::held_for(&*self.core.conn()?, id)?.is_empty() =>
                    {
                        match self.core.withdraw(id) {
                            Ok(withdrawn) => {
                                changed |= withdrawn;
                                withdrawn
                            }
                            Err(error) if error.is_environmental() => false,
                            Err(error) => return Err(error),
                        }
                    }
                    _ => false,
                },
            };
            if settled {
                store::meta_delete(&*self.core.conn()?, &key)?;
            }
        }
        Ok(changed)
    }
}

/// Whether a write to the row itself waits, not one to an edge from it.
fn row_waits(conn: &Connection, id: &str) -> Result<bool> {
    Ok(store::waiting_writes_for_item(conn, id)?
        .iter()
        .any(|write| write.kind.subject() == Some(Subject::Item)))
}

/// The documents a link record says link to another item.
fn linking_hosts(conn: &Connection) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT DISTINCT item_id FROM body_names
          WHERE kind = 'link' AND state = 'resolved' AND other_id IS NOT NULL
          ORDER BY item_id",
    )?;
    let hosts = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(hosts)
}

/// The name a link to `id` takes: its title where that names it alone and
/// can be a link's name, or else its id.
fn renamed_to(title: &str, id: &str, names: &Names) -> Renamed {
    let usable = !title.is_empty()
        && !title.contains(['[', ']', '|', '#', '^', '\n', '\r'])
        && !is_id(title);
    let alone = || {
        let typed = Typed::new(title);
        typed.raw == typed.name
            && names
                .of(&typed.name)
                .is_some_and(|ids| ids.len() == 1 && ids.contains(id))
    };
    if usable && alone() {
        Renamed::Title(title.to_string())
    } else {
        Renamed::Id(id.to_string())
    }
}

/// `body` with the name of each link whose text is a key of `renamed`
/// replaced, its heading and alias kept. A link by id keeps the name it
/// showed as its alias. Links in code, comments and embeds are not links,
/// and are left as they are.
fn rewritten(body: &str, renamed: &HashMap<String, Renamed>) -> String {
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for link in text::link_parts(body) {
        let Some(name) = renamed.get(&link.target) else {
            continue;
        };
        let start = byte_at(body, link.name.start);
        let end = byte_at(body, link.name.end);
        match name {
            Renamed::Title(title) => edits.push((start, end, title.clone())),
            Renamed::Id(id) => {
                edits.push((start, end, id.clone()));
                if link.alias.is_none() {
                    // The end of the text inside the brackets.
                    let inner = byte_at(body, link.end) - "]]".len();
                    edits.push((inner, inner, format!("|{}", link.name.text.trim())));
                }
            }
        }
    }
    let mut new = body.to_string();
    for (start, end, text) in edits.into_iter().rev() {
        new.replace_range(start..end, &text);
    }
    new
}

/// The byte offset of the UTF-16 offset `unit` in `text`.
fn byte_at(text: &str, unit: u64) -> usize {
    let mut units = 0u64;
    for (at, character) in text.char_indices() {
        if units >= unit {
            return at;
        }
        units += character.len_utf16() as u64;
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn renames(pairs: &[(&str, Renamed)]) -> HashMap<String, Renamed> {
        pairs
            .iter()
            .map(|(raw, name)| (raw.to_string(), name.clone()))
            .collect()
    }

    #[test]
    fn rewrites_only_the_name_of_each_link() {
        let body = "See [[Old]], [[Old|the plan]] and [[Old#Steps]].\n\n`[[Old]]` ![[Old]]\n";
        let renamed = renames(&[
            ("Old", Renamed::Title("New".into())),
            ("Old|the plan", Renamed::Title("New".into())),
            ("Old#Steps", Renamed::Title("New".into())),
        ]);
        assert_eq!(
            rewritten(body, &renamed),
            "See [[New]], [[New|the plan]] and [[New#Steps]].\n\n`[[Old]]` ![[Old]]\n"
        );
    }

    #[test]
    fn names_by_id_and_keeps_what_the_link_showed() {
        let id = "0190d3b4-5c6a-7b8c-9d0e-1f2a3b4c5d6e";
        let body = "[[Old]] [[Old#^block]] [[Old|kept]]";
        let renamed = renames(&[
            ("Old", Renamed::Id(id.into())),
            ("Old#^block", Renamed::Id(id.into())),
            ("Old|kept", Renamed::Id(id.into())),
        ]);
        assert_eq!(
            rewritten(body, &renamed),
            format!("[[{id}|Old]] [[{id}#^block|Old]] [[{id}|kept]]")
        );
    }

    #[test]
    fn counts_offsets_past_wide_characters() {
        let body = "Café 🎉 [[Ölé]] then [[Ölé|x]]";
        let renamed = renames(&[
            ("Ölé", Renamed::Title("Neu 🎈".into())),
            ("Ölé|x", Renamed::Title("Neu 🎈".into())),
        ]);
        assert_eq!(
            rewritten(body, &renamed),
            "Café 🎉 [[Neu 🎈]] then [[Neu 🎈|x]]"
        );
    }
}
