//! Wiki links to an item retitled since they were written, rewritten in the
//! bodies of this folder's documents to name it by its new title, as Obsidian
//! does (`folders/body-link-retitled`).

use std::collections::{BTreeMap, HashMap};

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::PullReport;
use super::lines::BoundFiles;
use super::{Folder, bytes_of, fields, state};
use crate::body::resolve::{self, Names, is_id};
use crate::body::rule;
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

/// What a stale link names its item by.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Rename {
    id: String,
    /// The item's new title, where it names the item alone and can be a
    /// link's name. Without one, the link names the item by id and shows the
    /// name it had.
    title: Option<String>,
}

/// A link as the folder reads it: its name, heading and alias.
type Read = (String, Option<String>, Option<String>);

impl Folder {
    /// Settles the rewrites queued earlier, then queues one for each
    /// document here whose body links to an item by a name that no longer
    /// names it. Answers whether the copy changed, so the pull writes the
    /// files again. An error that leaves the store writable is counted in
    /// `unrelinked` and ends only the document or the settling it came from.
    pub(super) fn relink(&self, report: &mut PullReport) -> Result<bool> {
        let mut changed = self.settle_relinks(report)?;
        let (links, catalog) = {
            let conn = self.core.conn()?;
            forget_refusals_of_gone(&conn)?;
            let links = linking_hosts(&conn)?;
            if links.is_empty() {
                return Ok(changed);
            }
            (links, Catalog::load(&conn)?)
        };
        let mut names = None;
        for (host, links) in links {
            let queued = contain(
                self.relink_document(&host, &links, &catalog, &mut names),
                report,
            )?;
            if queued == Some(true) {
                report.relinked += 1;
                changed = true;
            }
        }
        Ok(changed)
    }

    /// Queues the rewrite of `host`'s links that no longer name their item.
    /// The file is read, and every title in the copy loaded into `names`,
    /// only once a link is found stale.
    fn relink_document(
        &self,
        host: &str,
        links: &[(String, String)],
        catalog: &Catalog,
        names: &mut Option<Names>,
    ) -> Result<bool> {
        let Some(edit) = self.relinked_body(host, links, catalog, names)? else {
            return Ok(false);
        };
        match self
            .core
            .write_update(host, &edit, Based::Exact, Body::Folder)
        {
            Ok(write) => {
                store::meta_set(&*self.core.conn()?, &format!("{QUEUED}{}", write.id), host)?;
                Ok(true)
            }
            // The copy will not take the edit as it stands; the next change
            // to the document tries again.
            Err(
                CoreError::Invalid(_)
                | CoreError::Validation { .. }
                | CoreError::NotFound { .. }
                | CoreError::UnknownType { .. },
            ) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// The edit that rewrites `host`'s stale links, where the folder may
    /// write its body now: its file is as the folder last read or wrote it,
    /// nothing holds it, no write of it waits, each item it links to took
    /// its new title on the server, and the body reads as the same links
    /// after the rewrite (`folders/body-link-retitled-reparsed`).
    fn relinked_body(
        &self,
        host: &str,
        links: &[(String, String)],
        catalog: &Catalog,
        names: &mut Option<Names>,
    ) -> Result<Option<Edit>> {
        let conn = self.core.conn()?;
        let mut stale = Vec::new();
        for (text, id) in links {
            if resolve::answers_to(&conn, catalog, &BoundFiles, &Typed::new(text).name, id)?
                // A title this copy has not heard the server take names
                // nothing yet.
                || row_waits(&conn, id)?
            {
                continue;
            }
            stale.push((text, id));
        }
        if stale.is_empty() {
            return Ok(None);
        }
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| format!("folder-relink/{host}")) {
            return Err(CoreError::Decoding(format!(
                "the fault folder-relink/{host} was set"
            )));
        }
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
        let names = match names {
            Some(names) => names,
            None => names.insert(Names::load(&conn, catalog, &BoundFiles)?),
        };
        let mut renamed: HashMap<String, Rename> = HashMap::new();
        for (text, id) in stale {
            let Some(target) = store::item_by_id(&conn, id)? else {
                continue;
            };
            let title = target
                .properties
                .get(fields::title_field(catalog, &target.r#type))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            renamed.insert(text.trim().to_string(), renamed_to(title, id, names));
        }
        if renamed.is_empty() {
            return Ok(None);
        }
        let field = fields::body_field(catalog, &item.r#type);
        let body = rule::body_of(catalog, &item);
        let Some(new) = relinked(body, &renamed) else {
            return Ok(None);
        };
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
    /// met another writer's change (`version_conflict`) is withdrawn alone,
    /// so every write behind it goes on (`folders/body-link-retitled-behind`),
    /// and worked out again against what the server holds.
    fn settle_relinks(&self, report: &mut PullReport) -> Result<bool> {
        let queued: Vec<(String, String)> = {
            let conn = self.core.conn()?;
            let mut statement = conn.prepare(
                "SELECT key, value FROM meta WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key",
            )?;
            statement
                .query_map([QUEUED], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut changed = false;
        for (key, host) in queued {
            changed |= contain(self.settle_relink(&key, &host), report)?.unwrap_or(false);
        }
        Ok(changed)
    }

    /// Settles the rewrite `key` names, answering whether the copy changed.
    fn settle_relink(&self, key: &str, host: &str) -> Result<bool> {
        let id = &key[QUEUED.len()..];
        let refused = format!("{REFUSED}{host}");
        let row = store::queued_write(&*self.core.conn()?, id)?;
        let (settled, changed) = match row {
            None => (true, false),
            Some(row) => match row.verdict {
                Some(Verdict::Accepted | Verdict::Merged | Verdict::Conflicted) => {
                    store::meta_delete(&*self.core.conn()?, &refused)?;
                    (true, false)
                }
                Some(Verdict::Refused) => {
                    if let Some(version) = row.base_version {
                        store::meta_set(&*self.core.conn()?, &refused, &version.to_string())?;
                    }
                    let discarded = self.core.discard(id)?;
                    (discarded, discarded)
                }
                Some(Verdict::Blocked) if row.withdrawable() => {
                    match self.core.withdraw_alone(id) {
                        Ok(withdrawn) => (withdrawn, withdrawn),
                        Err(error) if error.is_environmental() => (false, false),
                        Err(error) => return Err(error),
                    }
                }
                _ => (false, false),
            },
        };
        if settled {
            store::meta_delete(&*self.core.conn()?, key)?;
        }
        Ok(changed)
    }
}

/// `result`, or none where it failed with an error that leaves the store
/// writable, which is counted. Only a store that can no longer be written
/// ends the pull.
fn contain<T>(result: Result<T>, report: &mut PullReport) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error @ (CoreError::StorageFull(_) | CoreError::Store(_))) => Err(error),
        Err(error) => {
            crate::telemetry::unrelinked!(&error);
            report.unrelinked += 1;
            Ok(None)
        }
    }
}

/// Whether a write to the row itself waits, not one to an edge from it.
fn row_waits(conn: &Connection, id: &str) -> Result<bool> {
    Ok(store::waiting_writes_for_item(conn, id)?
        .iter()
        .any(|write| write.kind.subject() == Some(Subject::Item)))
}

/// Each document a link record says links to another item, with the text of
/// each such link and the item it names.
fn linking_hosts(conn: &Connection) -> Result<BTreeMap<String, Vec<(String, String)>>> {
    let mut statement = conn.prepare(
        "SELECT item_id, text, other_id FROM body_names
          WHERE kind = 'link' AND state = 'resolved'
            AND other_id IS NOT NULL AND other_id <> item_id",
    )?;
    let mut hosts: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (host, text, id) = row?;
        hosts.entry(host).or_default().push((text, id));
    }
    Ok(hosts)
}

/// The refusals recorded for documents the copy no longer holds.
fn forget_refusals_of_gone(conn: &Connection) -> Result<()> {
    conn.execute(
        "DELETE FROM meta
          WHERE substr(key, 1, length(?1)) = ?1
            AND substr(key, length(?1) + 1) NOT IN (SELECT id FROM items)",
        [REFUSED],
    )?;
    Ok(())
}

/// The name a link to `id` takes: its title where that names it alone and
/// can be a link's name, or else its id.
fn renamed_to(title: &str, id: &str, names: &Names) -> Rename {
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
    Rename {
        id: id.to_string(),
        title: (usable && alone()).then(|| title.to_string()),
    }
}

/// `body` with its stale links renamed, where it then reads as the same
/// links naming the items meant: by title where each can be, or else all by
/// id. None where neither does, such as a title that opens a code span or a
/// comment over the text after it, or a link in a table row the reader does
/// not take apart.
fn relinked(body: &str, renamed: &HashMap<String, Rename>) -> Option<String> {
    let new = rewritten(body, renamed);
    if reads_as_meant(body, &new, renamed) {
        return Some(new);
    }
    let by_id: HashMap<String, Rename> = renamed
        .iter()
        .map(|(text, rename)| {
            let id = rename.id.clone();
            (text.clone(), Rename { id, title: None })
        })
        .collect();
    let new = rewritten(body, &by_id);
    reads_as_meant(body, &new, &by_id).then_some(new)
}

/// `body` with the name of each link whose text is a key of `renamed`
/// replaced, its heading and alias kept. A link by id keeps the name it
/// showed as its alias, behind a `\|` in a table row, as Obsidian writes it,
/// so the bar does not end the cell. Links in code, comments and embeds are
/// not links, and are left as they are.
fn rewritten(body: &str, renamed: &HashMap<String, Rename>) -> String {
    let rows = table_rows(body);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for link in text::link_parts(body) {
        let Some(rename) = renamed.get(&link.target) else {
            continue;
        };
        let start = byte_at(body, link.name.start);
        let end = byte_at(body, link.name.end);
        match &rename.title {
            Some(title) => edits.push((start, end, title.clone())),
            None => {
                edits.push((start, end, rename.id.clone()));
                if link.alias.is_none() {
                    // The end of the text inside the brackets.
                    let inner = byte_at(body, link.end) - "]]".len();
                    let line = body[..inner].matches('\n').count();
                    let bar = if rows.get(line).copied().unwrap_or(false) {
                        "\\|"
                    } else {
                        "|"
                    };
                    edits.push((inner, inner, format!("{bar}{}", link.name.text.trim())));
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

/// Whether `new` reads as `old` with its links renamed as `renamed` says
/// and nothing else changed: the same links in the same order, each naming
/// what was meant with the heading and alias meant, the same embeds, and
/// the same cells in each table row.
fn reads_as_meant(old: &str, new: &str, renamed: &HashMap<String, Rename>) -> bool {
    let meant: Vec<Read> = text::link_parts(old)
        .into_iter()
        .map(|link| {
            let heading = link.heading.map(|part| part.text);
            let alias = link.alias.map(|part| part.text);
            match renamed.get(&link.target) {
                None => (link.name.text, heading, alias),
                Some(Rename {
                    title: Some(title), ..
                }) => (title.clone(), heading, alias),
                Some(Rename { id, title: None }) => (
                    id.clone(),
                    heading,
                    alias.or_else(|| Some(link.name.text.trim().to_string())),
                ),
            }
        })
        .collect();
    let read: Vec<Read> = text::link_parts(new)
        .into_iter()
        .map(|link| {
            (
                link.name.text,
                link.heading.map(|part| part.text),
                link.alias.map(|part| part.text),
            )
        })
        .collect();
    meant == read && text::embeds(old) == text::embeds(new) && cells(old) == cells(new)
}

/// Whether each line of `text` is a row of a table: a line with a `|`
/// followed by a delimiter row, and each line after it up to a blank one.
fn table_rows(text: &str) -> Vec<bool> {
    let lines: Vec<&str> = text.split('\n').collect();
    let delimiter = |line: &str| {
        let line = line.trim();
        line.contains('|')
            && line.contains('-')
            && line
                .chars()
                .all(|character| matches!(character, '|' | ':' | '-' | ' ' | '\t'))
    };
    let mut rows = vec![false; lines.len()];
    let mut at = 0;
    while at + 1 < lines.len() {
        if lines[at].contains('|') && delimiter(lines[at + 1]) {
            while at < lines.len() && !lines[at].trim().is_empty() {
                rows[at] = true;
                at += 1;
            }
        } else {
            at += 1;
        }
    }
    rows
}

/// The number of bars not escaped by a backslash in each table row of
/// `text`, which is what divides the row into cells.
fn cells(text: &str) -> Vec<(usize, usize)> {
    let rows = table_rows(text);
    text.split('\n')
        .enumerate()
        .filter(|(line, _)| rows[*line])
        .map(|(line, row)| {
            let mut bars = 0;
            let mut escaped = false;
            for character in row.chars() {
                match character {
                    '\\' => escaped = !escaped,
                    '|' if !escaped => bars += 1,
                    _ => escaped = false,
                }
                if character == '|' {
                    escaped = false;
                }
            }
            (line, bars)
        })
        .collect()
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

    const ID: &str = "0190d3b4-5c6a-7b8c-9d0e-1f2a3b4c5d6e";

    fn titled(pairs: &[(&str, &str)]) -> HashMap<String, Rename> {
        pairs
            .iter()
            .map(|(raw, title)| {
                let rename = Rename {
                    id: ID.into(),
                    title: Some(title.to_string()),
                };
                (raw.to_string(), rename)
            })
            .collect()
    }

    fn by_id(raws: &[&str]) -> HashMap<String, Rename> {
        raws.iter()
            .map(|raw| {
                let rename = Rename {
                    id: ID.into(),
                    title: None,
                };
                (raw.to_string(), rename)
            })
            .collect()
    }

    #[test]
    fn rewrites_only_the_name_of_each_link() {
        let body = "See [[Old]], [[Old|the plan]] and [[Old#Steps]].\n\n`[[Old]]` ![[Old]]\n";
        let renamed = titled(&[
            ("Old", "New"),
            ("Old|the plan", "New"),
            ("Old#Steps", "New"),
        ]);
        let new = "See [[New]], [[New|the plan]] and [[New#Steps]].\n\n`[[Old]]` ![[Old]]\n";
        assert_eq!(rewritten(body, &renamed), new);
        assert_eq!(relinked(body, &renamed).as_deref(), Some(new));
    }

    #[test]
    fn names_by_id_and_keeps_what_the_link_showed() {
        let body = "[[Old]] [[Old#^block]] [[Old|kept]]";
        let renamed = by_id(&["Old", "Old#^block", "Old|kept"]);
        let new = format!("[[{ID}|Old]] [[{ID}#^block|Old]] [[{ID}|kept]]");
        assert_eq!(rewritten(body, &renamed), new);
        assert_eq!(relinked(body, &renamed), Some(new));
    }

    #[test]
    fn counts_offsets_past_wide_characters() {
        let body = "Café 🎉 [[Ölé]] then [[Ölé|x]]";
        let renamed = titled(&[("Ölé", "Neu 🎈"), ("Ölé|x", "Neu 🎈")]);
        assert_eq!(
            rewritten(body, &renamed),
            "Café 🎉 [[Neu 🎈]] then [[Neu 🎈|x]]"
        );
    }

    #[test]
    fn a_title_that_would_hide_text_after_it_names_the_item_by_id() {
        for title in ["It`s", "Before <!-- after"] {
            let body = "See [[Old]] and `x` here, then [[Other]] <!-- c --> -->.\n";
            let renamed = titled(&[("Old", title)]);
            // The witness: renamed by title, the body reads as other links.
            let by_title = rewritten(body, &renamed);
            assert_ne!(
                text::link_parts(&by_title).len(),
                text::link_parts(body).len(),
                "{title}: {by_title}"
            );
            assert_eq!(
                relinked(body, &renamed),
                Some(body.replace("[[Old]]", &format!("[[{ID}|Old]]"))),
                "{title}"
            );
        }
    }

    #[test]
    fn a_title_that_would_join_a_link_after_it_into_code_is_never_written() {
        let body = "See [[Old]] then `[[Other]]` stays code.\n";
        let renamed = titled(&[("Old", "A`b")]);
        let new = relinked(body, &renamed).unwrap();
        assert_eq!(text::link_parts(&new).len(), 1, "{new}");
        assert_eq!(
            new,
            format!("See [[{ID}|Old]] then `[[Other]]` stays code.\n")
        );
    }

    #[test]
    fn a_link_by_id_in_a_table_row_escapes_its_bar() {
        let body = "| Note | Link |\n| --- | --- |\n| One | [[Old]] |\n\n[[Old]] outside\n";
        let renamed = by_id(&["Old"]);
        assert_eq!(
            rewritten(body, &renamed),
            format!(
                "| Note | Link |\n| --- | --- |\n| One | [[{ID}\\|Old]] |\n\n[[{ID}|Old]] outside\n"
            )
        );
        // The folder's reader takes `\|` for part of the name, so the link
        // would name nothing it meant, and the document is left alone.
        assert_eq!(relinked(body, &renamed), None);
        // The witness: the same link outside a table is rewritten.
        let outside = "[[Old]] outside\n";
        assert_eq!(
            relinked(outside, &renamed),
            Some(format!("[[{ID}|Old]] outside\n"))
        );
    }

    #[test]
    fn a_link_by_title_in_a_table_row_keeps_its_cells() {
        let body = "| Note | Link |\n| --- | --- |\n| One | [[Old]] |\n";
        let renamed = titled(&[("Old", "New")]);
        assert_eq!(
            relinked(body, &renamed).as_deref(),
            Some("| Note | Link |\n| --- | --- |\n| One | [[New]] |\n")
        );
    }

    #[test]
    fn reads_each_line_of_a_table_and_no_other() {
        let text = "intro | not\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n\nafter | x\n";
        assert_eq!(
            table_rows(text),
            [false, false, true, true, true, false, false, false]
        );
        assert_eq!(cells("| a \\| b | c |\n| --- | --- |\n"), [(0, 3), (1, 3)]);
    }
}
