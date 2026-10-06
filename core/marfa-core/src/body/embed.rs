//! How an embed's path or name is read, as Obsidian reads one.

use std::path::Path;

use serde_json::Value;

use super::text::Embed;
use crate::catalog::Catalog;
use crate::model::Item;
use crate::names::{folded, name_of, same};

pub(crate) const FILE_TYPE: &str = "core.file";

/// The hash of a file item's bytes; `None` for an item that is not one.
pub(crate) fn bytes_of<'a>(item: &'a Item, catalog: &Catalog) -> Option<&'a str> {
    if !catalog.matches(FILE_TYPE, &item.r#type) {
        return None;
    }
    item.properties.get("blob_ref").and_then(Value::as_str)
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
}

pub(crate) fn carries_frontmatter(path: &Path) -> bool {
    matches!(extension_of(path).as_deref(), Some("md" | "markdown"))
}

pub(crate) fn is_document(path: &Path) -> bool {
    carries_frontmatter(path) || extension_of(path).as_deref() == Some("txt")
}

/// The directory a path sits in, with its trailing `/`.
pub(crate) fn dir_of(path: &str) -> &str {
    path.rfind('/').map_or("", |at| &path[..=at])
}

/// `path` read from the file at `host`, a leading `/` from the folder's root
/// as Obsidian reads the vault's; `None` where it leads out of the folder.
pub(crate) fn joined(host: &str, path: &str) -> Option<String> {
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
pub(crate) fn is_note(name: &str) -> bool {
    is_document(Path::new(name_of(name)))
}

/// Whether a name, with no file answering to it, is still plainly a file's:
/// its extension names a MIME type. `![[Dr. Smith]]` is a note to Obsidian.
pub(crate) fn file_like(name: &str) -> bool {
    !is_note(name)
        && crate::blob::mime_type_for(Path::new(name), None) != "application/octet-stream"
}

/// Whether `path` answers to `name`: the whole path, or its ending at a
/// directory's edge, as a folder compares names.
pub(crate) fn answers(path: &str, name: &str) -> bool {
    let (path, name) = (folded(path), folded(name.trim_start_matches('/')));
    path == name || path.ends_with(&format!("/{name}"))
}

/// The file `![[name]]` names among `files`: the root path, else the nearest,
/// then the shallowest, then path order, so every machine resolves it alike.
pub(crate) fn named<'f>(
    host: &str,
    name: &str,
    files: impl IntoIterator<Item = &'f str>,
) -> Option<String> {
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
pub(crate) fn read_as(embed: &Embed) -> Option<(&str, bool)> {
    match embed {
        Embed::Named { name, .. } if !(name.starts_with("./") || name.starts_with("../")) => {
            Some((name, true))
        }
        Embed::Named { name: path, .. } | Embed::Path { path, .. } => Some((path, false)),
        Embed::Spaced { .. } => None,
    }
}
