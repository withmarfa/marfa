//! Files a document's body embeds (`folders.md` 12): each an `attached-to`
//! edge from the file's item to the document's, written where its link says.

use std::collections::BTreeMap;

use serde_json::Value;

use super::document::{self, Embed};
use super::placement::cleaned;
use super::{Flagged, Folder, bytes_of, carries_frontmatter, fields, is_document, name_of, state};
use crate::Result;
use crate::catalog::Catalog;
use crate::model::Item;

/// The edge an embed is.
pub const ATTACHMENT_EDGE: &str = "attached-to";

/// Where an embed points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Target {
    /// A path in the folder.
    At(String),
    /// `![[name]]` as a pull reads it: placed by name once the files are known.
    Named(String),
    /// A path leading out of the folder.
    Outside,
    /// Nothing in the folder answers to it.
    Nothing,
}

/// The directory a path inside the folder sits in, with its trailing `/`.
fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..=at])
}

/// `path` read from the file at `host`, or `None` where it leads out of the
/// folder, an absolute path included.
fn joined(host: &str, path: &str) -> Option<String> {
    if path.starts_with(['/', '\\']) {
        return None;
    }
    let mut parts: Vec<&str> = dir_of(host)
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
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

/// Whether a name is a file's rather than a note's: `![[name]]` with no
/// extension is a note, as Obsidian reads it, and a note is never an embed.
fn names_a_file(name: &str, named: bool) -> bool {
    let last = name.rsplit('/').next().unwrap_or(name);
    match last.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => !is_document(std::path::Path::new(last)),
        _ => !named,
    }
}

/// Whether `path` answers to `name`: the whole path, or its ending at a
/// directory's edge, ignoring case.
fn answers(path: &str, name: &str) -> bool {
    let (path, name) = (
        path.to_lowercase(),
        name.trim_start_matches('/').to_lowercase(),
    );
    path == name || path.ends_with(&format!("/{name}"))
}

/// The file `![[name]]` names among `files`, as Obsidian resolves it: the
/// path from the folder's root, else the nearest file of that name, in the
/// embedding file's own directory, then the shallowest, then path order.
fn named<'f>(host: &str, name: &str, files: impl IntoIterator<Item = &'f str>) -> Option<String> {
    files
        .into_iter()
        .filter(|file| answers(file, name))
        .min_by_key(|file| {
            let exact = file.to_lowercase() == name.trim_start_matches('/').to_lowercase();
            let beside = dir_of(file).to_lowercase() == dir_of(host).to_lowercase();
            (!exact, !beside, file.matches('/').count(), file.to_string())
        })
        .map(str::to_string)
}

/// Where an embed in the file at `host` points among the files the walk
/// found; `None` for an embed of a note, which is text in the body.
pub(super) fn on_disk(host: &str, embed: &Embed, files: &[String]) -> Option<Target> {
    match embed {
        Embed::Path { path, .. } => {
            if !names_a_file(path, false) {
                return None;
            }
            Some(match joined(host, path) {
                None => Target::Outside,
                Some(at) if files.contains(&at) => Target::At(at),
                Some(_) => Target::Nothing,
            })
        }
        Embed::Named { name, .. } if name.starts_with("./") || name.starts_with("../") => on_disk(
            host,
            &Embed::Path {
                raw: embed.raw().to_string(),
                path: name.clone(),
            },
            files,
        ),
        Embed::Named { name, .. } => {
            if !names_a_file(name, true) {
                return None;
            }
            Some(
                named(host, name, files.iter().map(String::as_str))
                    .map_or(Target::Nothing, Target::At),
            )
        }
    }
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
    /// The file items attached to `host` that the copy holds.
    fn attachments(&self, host: &str, catalog: &Catalog) -> Result<Vec<Attachment>> {
        let mut found = Vec::new();
        for edge in self.core.edges_to(host)? {
            if edge.edge_type != ATTACHMENT_EDGE
                || found
                    .iter()
                    .any(|held: &Attachment| held.id == edge.source_id)
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
            let mut names: Vec<String> = path
                .iter()
                .map(|path| name_of(path).to_lowercase())
                .collect();
            if let Some(title) = item
                .properties
                .get(fields::title_field(catalog, &item.r#type))
                .and_then(Value::as_str)
            {
                names.push(title.trim().to_lowercase());
            }
            found.push(Attachment {
                id: item.id,
                path,
                names,
            });
        }
        Ok(found)
    }

    /// The embeds of an item's body, each read as the attachment bound at its
    /// path, or else the one attachment whose file name or title is its name.
    pub(super) fn shown_in(
        &self,
        host: &Item,
        host_path: &str,
        body: &str,
        catalog: &Catalog,
    ) -> Result<Vec<Shown>> {
        if !carries_frontmatter(std::path::Path::new(host_path)) {
            return Ok(Vec::new());
        }
        let embeds = document::embeds(body);
        if embeds.is_empty() {
            return Ok(Vec::new());
        }
        let attachments = self.attachments(&host.id, catalog)?;
        let by_name = |name: &str| {
            let wanted = name_of(name).to_lowercase();
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
            let (path, named) = match embed {
                Embed::Named { name, .. }
                    if !(name.starts_with("./") || name.starts_with("../")) =>
                {
                    (name, true)
                }
                Embed::Named { name, .. } | Embed::Path { path: name, .. } => (name, false),
            };
            if !names_a_file(path, named) {
                continue;
            }
            let raw = embed.raw().to_string();
            if named {
                shown.push(Shown {
                    raw,
                    item: by_name(path),
                    target: Target::Named(path.clone()),
                });
                continue;
            }
            match joined(host_path, path) {
                None => shown.push(Shown {
                    raw,
                    item: None,
                    target: Target::Outside,
                }),
                Some(at) => shown.push(Shown {
                    raw,
                    item: attachments
                        .iter()
                        .find(|held| held.path.as_deref() == Some(at.as_str()))
                        .map(|held| held.id.clone())
                        .or_else(|| by_name(&at)),
                    target: Target::At(at),
                }),
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
                    (_, Target::Outside) => embedded.reports.push(reported(
                        host_path,
                        format!(
                            "{} leads out of the folder, so the folder neither sends nor writes the file it shows",
                            shown.raw
                        ),
                    )),
                    (Some(id), Target::At(path)) => links.entry(id).or_default().push(Link {
                        path,
                        host: host_path.clone(),
                        raw: shown.raw,
                    }),
                    (Some(id), Target::Named(name)) => {
                        by_name.push((id, name, host_path.clone(), shown.raw));
                    }
                    _ => {}
                }
            }
        }
        // Where a file already answers to the name, Obsidian shows that one.
        for (id, name, host, raw) in by_name {
            let bound = state::bound_to_item(&*self.core.conn()?, &id)?.map(|bound| bound.path);
            let linked: Vec<String> = links
                .get(&id)
                .map(|found| found.iter().map(|link| link.path.clone()).collect())
                .unwrap_or_default();
            let path = named(
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
            });
            links.entry(id).or_default().push(Link { path, host, raw });
        }
        for (id, mut found) in links {
            found.sort_by(|a, b| a.path.cmp(&b.path));
            let first = found[0].path.clone();
            for link in &found {
                if link.path != first {
                    embedded.reports.push(reported(
                        &link.host,
                        format!(
                            "{} names {}, and another link names the same file at {first}, first in path order, where it is written",
                            link.raw, link.path
                        ),
                    ));
                }
            }
            match cleaned(&first) {
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
            joined("notes/a.md", "/b.png"),
            None,
            "an absolute path was read inside the folder"
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
    fn an_embed_of_a_note_is_no_file() {
        assert!(names_a_file("pic.png", true));
        assert!(
            !names_a_file("A note", true),
            "an extensionless name, a note to Obsidian, was read as a file"
        );
        assert!(!names_a_file("note.md", false));
        assert!(names_a_file("scan", false));
    }
}
