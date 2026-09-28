//! Files a document's body embeds (`folders.md` 12): each an `attached-to`
//! edge from the file's item to the document's, written where its link says.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::Value;

use super::document::{self, Embed};
use super::lists::Lists;
use super::names::{folded, same};
use super::placement::{cleaned, path_of};
use super::{Flagged, Folder, bytes_of, carries_frontmatter, fields, is_document, name_of, state};
use crate::Result;
use crate::catalog::Catalog;
use crate::model::Item;

/// The edge an embed is.
pub const ATTACHMENT_EDGE: &str = "attached-to";

/// Where an embed of a file points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Target {
    /// A path in the folder.
    At(String),
    /// `![[name]]` as a pull reads it: placed by name once the files are known.
    Named(String),
    /// A path leading out of the folder.
    Outside,
    /// A file's name that no file the folder sends answers to.
    Nothing,
    /// A path a raw space runs through, which names no file.
    Spaced,
}

/// The directory a path inside the folder sits in, with its trailing `/`.
fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..=at])
}

/// `path` read from the file at `host`, a leading `/` from the folder's root
/// as Obsidian reads the vault's; `None` where it leads out of the folder.
fn joined(host: &str, path: &str) -> Option<String> {
    let (from, path) = match path.strip_prefix('/') {
        Some(rooted) => ("", rooted),
        None => (dir_of(host), path),
    };
    let mut parts: Vec<&str> = from.split('/').filter(|part| !part.is_empty()).collect();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            name => parts.push(name),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Whether a name is a document's, which an embed shows as a note.
fn is_note(name: &str) -> bool {
    is_document(Path::new(name.rsplit('/').next().unwrap_or(name)))
}

/// Whether a name, with no file answering to it, is still plainly a file's:
/// its extension names a MIME type. `![[Dr. Smith]]` is a note to Obsidian.
fn file_like(name: &str) -> bool {
    !is_note(name)
        && crate::blob::mime_type_for(Path::new(name), None) != "application/octet-stream"
}

/// Whether `path` answers to `name`: the whole path, or its ending at a
/// directory's edge, as a folder compares names (`folders.md` 27).
fn answers(path: &str, name: &str) -> bool {
    let (path, name) = (folded(path), folded(name.trim_start_matches('/')));
    path == name || path.ends_with(&format!("/{name}"))
}

/// The file `![[name]]` names among `files`: the root path, else the nearest,
/// then the shallowest, then path order, so every machine resolves it alike.
fn named<'f>(host: &str, name: &str, files: impl IntoIterator<Item = &'f str>) -> Option<String> {
    files
        .into_iter()
        .filter(|file| answers(file, name))
        .min_by_key(|file| {
            let exact = same(file, name.trim_start_matches('/'));
            let beside = same(dir_of(file), dir_of(host));
            (!exact, !beside, file.matches('/').count(), file.to_string())
        })
        .map(str::to_string)
}

/// An embed's name and whether it is read as Obsidian reads a name; `![[./x]]`
/// and `![[../x]]` are paths. `None` for a raw-space path.
fn read_as(embed: &Embed) -> Option<(&str, bool)> {
    match embed {
        Embed::Named { name, .. } if !(name.starts_with("./") || name.starts_with("../")) => {
            Some((name, true))
        }
        Embed::Named { name: path, .. } | Embed::Path { path, .. } => Some((path, false)),
        Embed::Spaced { .. } => None,
    }
}

/// The files a scan walked, indexed once so resolving an embed costs a lookup;
/// both keys folded, as macOS and Obsidian compare names (`folders.md` 27).
pub(super) struct Files {
    by_path: HashMap<String, String>,
    by_name: HashMap<String, Vec<String>>,
}

impl Files {
    pub fn of(paths: &[String]) -> Files {
        let mut files = Files {
            by_path: HashMap::new(),
            by_name: HashMap::new(),
        };
        for path in paths {
            files.by_path.insert(folded(path), path.clone());
            files
                .by_name
                .entry(folded(name_of(path)))
                .or_default()
                .push(path.clone());
        }
        files
    }

    fn at(&self, path: &str) -> Option<String> {
        self.by_path.get(&folded(path)).cloned()
    }

    fn named(&self, host: &str, name: &str) -> Option<String> {
        let found = self.by_name.get(&folded(name_of(name)))?;
        named(host, name, found.iter().map(String::as_str))
    }
}

/// Where an embed in the file at `host` points among the files the walk
/// found; `None` for an embed of a note, which is text in the body.
pub(super) fn on_disk(host: &str, embed: &Embed, files: &Files) -> Option<Target> {
    let Some((name, by_name)) = read_as(embed) else {
        let Embed::Spaced { path, .. } = embed else {
            return None;
        };
        return file_like(path).then_some(Target::Spaced);
    };
    if is_note(name) {
        return None;
    }
    let found = if by_name {
        files.named(host, name)
    } else {
        match joined(host, name) {
            None => return Some(Target::Outside),
            Some(at) => files.at(&at),
        }
    };
    match found {
        Some(at) if is_note(&at) => None,
        Some(at) => Some(Target::At(at)),
        None => file_like(name).then_some(Target::Nothing),
    }
}

/// Why the folder reads nothing from an embed, said in the file's report.
pub(super) fn reason(raw: &str, target: &Target) -> String {
    match target {
        Target::Outside => format!(
            "{raw} leads out of the folder, so the folder neither sends nor writes the file it shows"
        ),
        Target::Spaced => format!(
            "{raw} has a raw space in its path, which ends a Markdown path, so it names no file and no attachment of this file is removed until it does; write the space as %20, or the path inside < >"
        ),
        Target::At(_) | Target::Named(_) | Target::Nothing => format!(
            "{raw} names no file the folder sends, so no attachment of this file is removed until it does"
        ),
    }
}

/// Why a pull writes no file for an embed that names no attachment.
fn unattached(raw: &str) -> String {
    format!(
        "{raw} names no attachment of this file the folder can read, so no file is written for it"
    )
}

/// An embed in an item's body, and the attachment the copy reads it as.
pub(super) struct Shown {
    pub raw: String,
    pub item: Option<String>,
    pub target: Target,
}

/// A host's attachment that is a file, and the names it goes by here.
struct Attachment {
    id: String,
    path: Option<String>,
    names: Vec<String>,
}

/// Where an item a file here embeds is written, and the embeds reported.
#[derive(Default)]
pub(super) struct Embedded {
    pub at: BTreeMap<String, String>,
    pub reports: Vec<Flagged>,
}

/// An embed the folder reads nothing from, in the file at `path`.
pub(super) fn reported(path: &str, reason: String) -> Flagged {
    Flagged {
        path: path.to_string(),
        flag: "embed",
        reason,
    }
}

impl Folder {
    /// Where an item's placement puts it.
    fn placed_at(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .placement(id)?
            .and_then(|edge| path_of(&edge).and_then(cleaned)))
    }

    /// The paths an item already goes by here: its placement and its file.
    fn own_paths(&self, id: &str) -> Result<Vec<String>> {
        let mut paths: Vec<String> = self.placed_at(id)?.into_iter().collect();
        paths.extend(state::bound_to_item(&*self.core.conn()?, id)?.map(|bound| bound.path));
        Ok(paths)
    }

    /// The file items attached to `host` that the copy holds.
    fn attachments(&self, host: &str, catalog: &Catalog) -> Result<Vec<Attachment>> {
        let mut found: Vec<Attachment> = Vec::new();
        for edge in self.core.edges_to(host)? {
            if edge.edge_type != ATTACHMENT_EDGE
                || found.iter().any(|held| held.id == edge.source_id)
            {
                continue;
            }
            let Some(item) = self.core.get(&edge.source_id)? else {
                continue;
            };
            if bytes_of(&item, catalog).is_none() {
                continue;
            }
            let path = state::bound_to_item(&*self.core.conn()?, &item.id)?.map(|bound| bound.path);
            let mut names: Vec<String> = path.iter().map(|path| folded(name_of(path))).collect();
            if let Some(title) = item
                .properties
                .get(fields::title_field(catalog, &item.r#type))
                .and_then(Value::as_str)
            {
                names.push(folded(title.trim()));
            }
            found.push(Attachment {
                id: item.id,
                path,
                names,
            });
        }
        Ok(found)
    }

    /// The embeds of files in an item's body, each read as the attachment
    /// bound at its path, or else the one whose file name or title is its name.
    pub(super) fn shown_in(
        &self,
        host: &Item,
        host_path: &str,
        body: &str,
        catalog: &Catalog,
    ) -> Result<Vec<Shown>> {
        if !carries_frontmatter(Path::new(host_path)) {
            return Ok(Vec::new());
        }
        let embeds = document::embeds(body);
        if embeds.is_empty() {
            return Ok(Vec::new());
        }
        let attachments = self.attachments(&host.id, catalog)?;
        let by_name = |name: &str| {
            let wanted = folded(name_of(name));
            let mut matching = attachments
                .iter()
                .filter(|held| held.names.contains(&wanted));
            match (matching.next(), matching.next()) {
                (Some(one), None) => Some(one.id.clone()),
                _ => None,
            }
        };
        let mut shown = Vec::new();
        for embed in &embeds {
            let raw = embed.raw().to_string();
            let Some((name, named)) = read_as(embed) else {
                if let Embed::Spaced { path, .. } = embed
                    && file_like(path)
                {
                    shown.push(Shown {
                        raw,
                        item: None,
                        target: Target::Spaced,
                    });
                }
                continue;
            };
            if is_note(name) {
                continue;
            }
            let (item, target) = if named {
                (by_name(name), Target::Named(name.to_string()))
            } else {
                match joined(host_path, name) {
                    None => (None, Target::Outside),
                    Some(at) => (
                        attachments
                            .iter()
                            .find(|held| held.path.as_deref().is_some_and(|path| same(path, &at)))
                            .map(|held| held.id.clone())
                            .or_else(|| by_name(&at)),
                        Target::At(at),
                    ),
                }
            };
            if item.is_some() || target == Target::Outside || file_like(name) {
                shown.push(Shown { raw, item, target });
            }
        }
        Ok(shown)
    }

    /// Where each item a document here embeds is written: where its link
    /// says, the first in path order where its links name more than one path.
    pub(super) fn embedded(
        &self,
        hosts: &[(&Item, String)],
        catalog: &Catalog,
        lists: &Lists,
    ) -> Result<Embedded> {
        struct Link {
            path: String,
            host: String,
            raw: String,
        }
        let mut embedded = Embedded::default();
        let mut links: BTreeMap<String, Vec<Link>> = BTreeMap::new();
        let mut by_name: Vec<(String, String, String, String)> = Vec::new();
        for (host, host_path) in hosts {
            let body = host
                .properties
                .get(fields::body_field(catalog, &host.r#type))
                .and_then(Value::as_str)
                .unwrap_or_default();
            for shown in self.shown_in(host, host_path, body, catalog)? {
                match (shown.item, shown.target) {
                    (Some(id), Target::At(path)) => {
                        // A link differing from the file only in case or form
                        // names it, and the file keeps its own name.
                        let path = self
                            .own_paths(&id)?
                            .into_iter()
                            .find(|own| same(own, &path))
                            .unwrap_or(path);
                        links.entry(id).or_default().push(Link {
                            path,
                            host: host_path.clone(),
                            raw: shown.raw,
                        });
                    }
                    (Some(id), Target::Named(name)) => {
                        by_name.push((host_path.clone(), shown.raw, id, name));
                    }
                    (None, Target::At(_) | Target::Named(_)) => {
                        embedded
                            .reports
                            .push(reported(host_path, unattached(&shown.raw)));
                    }
                    (_, target) => {
                        embedded
                            .reports
                            .push(reported(host_path, reason(&shown.raw, &target)));
                    }
                }
            }
        }
        // In one order on every machine; a placement the name answers to is
        // where the file already sits, and otherwise a file of that name here.
        by_name.sort();
        for (host, raw, id, name) in by_name {
            let placed = self.placed_at(&id)?.filter(|path| answers(path, &name));
            let path = match placed {
                Some(path) => path,
                None => {
                    let bound =
                        state::bound_to_item(&*self.core.conn()?, &id)?.map(|bound| bound.path);
                    let linked: Vec<String> = links
                        .get(&id)
                        .map(|found| found.iter().map(|link| link.path.clone()).collect())
                        .unwrap_or_default();
                    named(
                        &host,
                        &name,
                        bound.iter().chain(&linked).map(String::as_str),
                    )
                    .unwrap_or_else(|| {
                        if name.contains('/') {
                            name.trim_start_matches('/').to_string()
                        } else {
                            format!("{}{name}", dir_of(&host))
                        }
                    })
                }
            };
            links.entry(id).or_default().push(Link { path, host, raw });
        }
        for (id, mut found) in links {
            found.sort_by(|a, b| a.path.cmp(&b.path));
            let first = found[0].path.clone();
            for link in &found {
                if !same(&link.path, &first) {
                    embedded.reports.push(reported(
                        &link.host,
                        format!(
                            "{} names {}, and another link names the same file at {first}, first in path order, where it is written",
                            link.raw, link.path
                        ),
                    ));
                }
            }
            match cleaned(&first).filter(|path| self.writes_at(lists, path)) {
                Some(path) => {
                    embedded.at.insert(id, path);
                }
                None => embedded.reports.push(reported(
                    &found[0].host,
                    format!("{} names a path the folder does not write", found[0].raw),
                )),
            }
        }
        Ok(embedded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_read_from_the_embedding_file_and_never_leads_out() {
        assert_eq!(
            joined("notes/a.md", "img/b.png").as_deref(),
            Some("notes/img/b.png")
        );
        assert_eq!(
            joined("notes/a.md", "../img/./b.png").as_deref(),
            Some("img/b.png")
        );
        assert_eq!(
            joined("a.md", "../b.png"),
            None,
            "a path climbing out of the folder was read inside it"
        );
        assert_eq!(
            joined("notes/a.md", "/img/b.png").as_deref(),
            Some("img/b.png"),
            "a path from the vault's root was not read from the folder's"
        );
    }

    #[test]
    fn a_name_resolves_to_the_nearest_file_that_answers_to_it() {
        let files = ["b/pic.png", "a/deep/pic.png", "notes/pic.png", "pic.png.md"];
        assert_eq!(
            named("notes/n.md", "pic.png", files).as_deref(),
            Some("notes/pic.png")
        );
        assert_eq!(
            named("x/n.md", "pic.png", files).as_deref(),
            Some("b/pic.png"),
            "the shallowest of the others was not taken"
        );
        assert_eq!(
            named("x/n.md", "deep/PIC.png", files).as_deref(),
            Some("a/deep/pic.png")
        );
        assert_eq!(
            named("x/n.md", "b/pic.png", files).as_deref(),
            Some("b/pic.png")
        );
        assert_eq!(named("x/n.md", "other.png", files), None);
    }

    #[test]
    fn a_name_no_file_answers_to_is_a_file_only_where_a_mime_type_claims_it() {
        assert!(file_like("pic.png"));
        assert!(file_like("doc.PDF"));
        for note in [
            "A note",
            "Dr. Smith",
            "v1.2 plan",
            "2024.05.01",
            "note.md",
            "list.txt",
        ] {
            assert!(
                !file_like(note),
                "{note} was read as a file, so it would hold back removals"
            );
        }
    }
}
