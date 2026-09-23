use std::collections::HashMap;

use rusqlite::Connection;

use crate::error::CoreError;

struct Entry {
    parent: Option<String>,
    title_field: Option<String>,
    thumbnail_field: Option<String>,
}

/// What the local index reads from an item's properties.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Indexing {
    pub title_field: Option<String>,
    /// Never indexed: its base64 matches nothing a person would search for,
    /// and the server leaves it out of its own index too.
    pub thumbnail_field: Option<String>,
}

#[cfg(test)]
impl Indexing {
    pub fn titled(field: &str) -> Indexing {
        Indexing {
            title_field: Some(field.to_string()),
            thumbnail_field: None,
        }
    }
}

/// The server's type catalog as last hydrated, answering the same subtree
/// question `?type=` answers on the server: exact name, dotted-name
/// descendant, or a type whose declared parent chain reaches the root.
pub struct Catalog {
    entries: HashMap<String, Entry>,
}

const MAX_PARENT_WALK: usize = 64;

impl Catalog {
    pub fn load(conn: &Connection) -> Result<Catalog, CoreError> {
        let mut statement =
            conn.prepare("SELECT id, parent, title_field, thumbnail_field FROM types")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut entries = HashMap::new();
        for row in rows {
            let (id, parent, title_field, thumbnail_field) = row?;
            entries.insert(
                id,
                Entry {
                    parent,
                    title_field,
                    thumbnail_field,
                },
            );
        }
        Ok(Catalog { entries })
    }

    /// `core.media.*` and `core.media` name the same subtree.
    pub fn root(declared: &str) -> &str {
        declared.strip_suffix(".*").unwrap_or(declared)
    }

    pub fn matches(&self, declared: &str, actual: &str) -> bool {
        let root = Self::root(declared);
        if actual == root || actual.starts_with(&format!("{root}.")) {
            return true;
        }
        self.descends_from(actual, root)
    }

    /// Types that reach `root` only through declared parentage, so a SQL
    /// filter can name them alongside the `root.%` pattern.
    pub fn declared_descendants(&self, root: &str) -> Vec<String> {
        let prefix = format!("{root}.");
        let mut ids: Vec<String> = self
            .entries
            .keys()
            .filter(|id| id.as_str() != root && !id.starts_with(&prefix))
            .filter(|id| self.descends_from(id, root))
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// Whether the copy holds this type.
    ///
    /// A local create names a type, and a device that queued one the catalog
    /// does not know would send a write the server refuses `400 unknown_type`
    /// — after the caller had been told it was queued, and after the row had
    /// been written into the working copy.
    pub fn known(&self, type_id: &str) -> bool {
        self.entries.contains_key(type_id)
    }

    pub fn title_field(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.title_field.as_deref())
    }

    /// The thumbnail a type carries, its own or the one it inherits: the
    /// server's `GET /types` answers each type as declared, not resolved.
    pub fn thumbnail_field(&self, type_id: &str) -> Option<&str> {
        self.nearest(type_id, |entry| entry.thumbnail_field.as_deref())
    }

    pub fn indexing(&self, type_id: &str) -> Indexing {
        Indexing {
            title_field: self.title_field(type_id).map(str::to_string),
            thumbnail_field: self.thumbnail_field(type_id).map(str::to_string),
        }
    }

    fn nearest<'a>(
        &'a self,
        type_id: &str,
        read: impl Fn(&'a Entry) -> Option<&'a str>,
    ) -> Option<&'a str> {
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let entry = self.entries.get(current)?;
            if let Some(found) = read(entry) {
                return Some(found);
            }
            current = entry.parent.as_deref()?;
        }
        None
    }

    fn descends_from(&self, type_id: &str, root: &str) -> bool {
        let mut current = type_id;
        for _ in 0..MAX_PARENT_WALK {
            let Some(entry) = self.entries.get(current) else {
                return false;
            };
            let Some(parent) = entry.parent.as_deref() else {
                return false;
            };
            if parent == root {
                return true;
            }
            current = parent;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(pairs: &[(&str, Option<&str>)]) -> Catalog {
        Catalog {
            entries: pairs
                .iter()
                .map(|(id, parent)| {
                    (
                        id.to_string(),
                        Entry {
                            parent: parent.map(str::to_string),
                            title_field: None,
                            thumbnail_field: None,
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn exact_prefix_and_declared_parentage_all_match() {
        let catalog = catalog(&[
            ("core.media", None),
            ("core.media.song", Some("core.media")),
            ("acme.podcast", Some("core.media")),
            ("acme.episode", Some("acme.podcast")),
            ("core.note", None),
        ]);
        assert!(catalog.matches("core.media", "core.media"));
        assert!(catalog.matches("core.media.*", "core.media.song"));
        assert!(catalog.matches("core.media", "core.media.song.remix"));
        assert!(catalog.matches("core.media", "acme.podcast"));
        assert!(catalog.matches("core.media", "acme.episode"));
        assert!(!catalog.matches("core.media", "core.note"));
        assert!(!catalog.matches("core.media", "core.mediafile"));
        assert_eq!(
            catalog.declared_descendants("core.media"),
            vec!["acme.episode".to_string(), "acme.podcast".to_string()]
        );
    }

    #[test]
    fn a_parent_cycle_ends() {
        let catalog = catalog(&[("a", Some("b")), ("b", Some("a"))]);
        assert!(!catalog.matches("z", "a"));
    }
}
