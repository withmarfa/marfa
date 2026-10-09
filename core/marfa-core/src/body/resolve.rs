//! The item a typed name names: by its id, its title, or the path of its
//! file, ignoring case and Unicode form, across what the copy holds and what
//! the server answers.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::embed::FILE_TYPE;
use super::text::Typed;
use crate::catalog::Catalog;
use crate::folder::fields;
use crate::names::{folded, forms, name_of, title_of};
use crate::{Core, Result, store};

/// Where the files of items sit, which a name may name by path or file name:
/// a folder's files on disk, or the placements a working copy holds.
pub(crate) trait Paths {
    /// Each path with the item whose file it is.
    fn every(&self, conn: &Connection) -> Result<Vec<(String, String)>>;
    fn of(&self, conn: &Connection, id: &str) -> Result<Vec<String>>;
}

/// Every name an item answers to in this copy, folded: its title, and its
/// file's path and name with and without the extension.
pub(crate) struct Names {
    ids: HashMap<String, BTreeSet<String>>,
}

impl Names {
    pub fn load(conn: &Connection, catalog: &Catalog, paths: &dyn Paths) -> Result<Names> {
        let mut ids: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut statement = conn.prepare(
            "SELECT id, type, properties FROM items WHERE state IN ('active', 'archived') AND type NOT LIKE 'system.%'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (id, r#type, properties) = row?;
            let properties: Map<String, Value> =
                serde_json::from_str(&properties).unwrap_or_default();
            if let Some(title) = properties
                .get(fields::title_field(catalog, &r#type))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|title| !title.is_empty())
            {
                ids.entry(folded(title)).or_default().insert(id);
            }
        }
        for (path, id) in paths.every(conn)? {
            for name in file_names(&path) {
                ids.entry(name).or_default().insert(id.clone());
            }
        }
        Ok(Names { ids })
    }

    pub fn of(&self, name: &str) -> Option<&BTreeSet<String>> {
        self.ids.get(&folded(name.trim()))
    }
}

/// A path as the names it answers to, folded.
fn file_names(path: &str) -> Vec<String> {
    let stem = |text: &str| match text.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() && !stem.ends_with('/') => stem.to_string(),
        _ => text.to_string(),
    };
    let mut names = vec![
        path.to_string(),
        stem(path),
        name_of(path).to_string(),
        title_of(path),
    ];
    names.iter_mut().for_each(|name| *name = folded(name));
    names.sort();
    names.dedup();
    names
}

#[derive(Debug, Clone)]
pub(crate) enum Resolved {
    Found {
        id: String,
        r#type: Option<String>,
    },
    Unmatched,
    Ambiguous,
    /// The server could not be reached, so the name is asked again later.
    Waiting,
    /// The server answered the lookup with something other than items.
    Unanswered(String),
}

/// Lookup pages read for one name and title field: a name more common than
/// this is named by id instead.
const LOOKUP_PAGES: usize = 5;

pub(crate) struct Resolver<'a> {
    core: &'a Core,
    catalog: &'a Catalog,
    paths: &'a dyn Paths,
    online: bool,
    names: Option<Names>,
    cache: HashMap<String, Resolved>,
}

impl<'a> Resolver<'a> {
    pub fn new(core: &'a Core, catalog: &'a Catalog, paths: &'a dyn Paths) -> Resolver<'a> {
        Resolver {
            core,
            catalog,
            paths,
            online: core.http().is_ok(),
            names: None,
            cache: HashMap::new(),
        }
    }

    fn names(&mut self) -> Result<&Names> {
        if self.names.is_none() {
            self.names = Some(Names::load(&*self.core.conn()?, self.catalog, self.paths)?);
        }
        Ok(self.names.as_ref().expect("loaded above"))
    }

    pub fn resolve(&mut self, text: &str) -> Result<Resolved> {
        let key = folded(text.trim());
        if let Some(held) = self.cache.get(&key) {
            return Ok(held.clone());
        }
        let resolved = if is_id(text) {
            self.resolve_id(text)?
        } else {
            self.resolve_name(text)?
        };
        self.cache.insert(key, resolved.clone());
        Ok(resolved)
    }

    fn resolve_id(&mut self, id: &str) -> Result<Resolved> {
        if let Some(item) = self.core.get(id)? {
            return Ok(Resolved::Found {
                id: item.id,
                r#type: Some(item.r#type),
            });
        }
        if !self.online {
            return Ok(Resolved::Waiting);
        }
        Ok(match self.core.http()?.item(id) {
            Ok(Some(row)) => Resolved::Found {
                id: row.item.id,
                r#type: Some(row.item.r#type),
            },
            Ok(None) => Resolved::Unmatched,
            Err(error) => self.failed(error),
        })
    }

    fn resolve_name(&mut self, name: &str) -> Result<Resolved> {
        let mut found: BTreeMap<String, Option<String>> = BTreeMap::new();
        let local: Vec<String> = self
            .names()?
            .of(name)
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default();
        for id in local {
            let r#type = self.core.get(&id)?.map(|item| item.r#type);
            found.insert(id, r#type);
        }
        if !self.online {
            return Ok(if found.len() > 1 {
                Resolved::Ambiguous
            } else {
                Resolved::Waiting
            });
        }
        let (rows, more) = match self.on_server(name, false) {
            Ok(answered) => answered,
            Err(error) => return Ok(self.failed(error)),
        };
        found.extend(rows);
        Ok(match found.len() {
            0 | 1 if more => Resolved::Unanswered(format!(
                "more than {LOOKUP_PAGES} pages of items contain it"
            )),
            0 => Resolved::Unmatched,
            1 => {
                let (id, r#type) = found.into_iter().next().expect("one");
                Resolved::Found { id, r#type }
            }
            _ => Resolved::Ambiguous,
        })
    }

    /// A failed lookup never ends the pass; after one the network failed, no
    /// later name is asked of the server.
    fn failed(&mut self, error: crate::error::CoreError) -> Resolved {
        if error.is_environmental() {
            self.online = false;
            Resolved::Waiting
        } else {
            Resolved::Unanswered(error.to_string())
        }
    }

    /// How many items the copy holds that `name` names.
    pub fn held_named(&mut self, name: &str) -> Result<usize> {
        Ok(self.names()?.of(name).map_or(0, BTreeSet::len))
    }

    /// The file item named `name` among those the copy holds, `held`, and
    /// those the server holds under that title.
    pub fn file_named(&mut self, name: &str, held: &[String]) -> Result<Resolved> {
        if !self.online {
            return Ok(if held.len() > 1 {
                Resolved::Ambiguous
            } else {
                Resolved::Waiting
            });
        }
        let (rows, more) = match self.on_server(name, true) {
            Ok(answered) => answered,
            Err(error) => return Ok(self.failed(error)),
        };
        let mut found: BTreeSet<String> = rows.into_keys().collect();
        found.extend(held.iter().cloned());
        Ok(match found.len() {
            0 | 1 if more => Resolved::Unanswered(format!(
                "more than {LOOKUP_PAGES} pages of items contain it"
            )),
            0 => Resolved::Unmatched,
            1 => Resolved::Found {
                id: found.into_iter().next().expect("one"),
                r#type: None,
            },
            _ => Resolved::Ambiguous,
        })
    }

    /// The items the server holds under this title, file items alone where
    /// `files` says, and whether a lookup stopped at its page cap.
    fn on_server(
        &self,
        name: &str,
        files: bool,
    ) -> Result<(BTreeMap<String, Option<String>>, bool)> {
        let http = self.core.http()?;
        let wanted_type = |r#type: &str| !files || self.catalog.matches(FILE_TYPE, r#type);
        let mut title_fields: Vec<&str> = self
            .catalog
            .declared()
            .filter(|(r#type, _)| !r#type.starts_with("system.") && wanted_type(r#type))
            .map(|(r#type, _)| fields::title_field(self.catalog, r#type))
            .collect();
        title_fields.sort();
        title_fields.dedup();
        let wanted = folded(name.trim());
        let mut found = BTreeMap::new();
        let mut more = false;
        // The server compares the text it is sent as it is, so each form a
        // title can be held in is asked.
        let asked: Vec<(&str, String)> = title_fields
            .iter()
            .flat_map(|field| {
                forms(name.trim())
                    .into_iter()
                    .map(move |form| (*field, form))
            })
            .collect();
        for (field, form) in asked {
            let (rows, capped) = http.items_containing(field, &form, LOOKUP_PAGES)?;
            more |= capped;
            for row in rows {
                let item = row.item;
                if !matches!(item.state.as_str(), "active" | "archived")
                    || fields::title_field(self.catalog, &item.r#type) != field
                    || !wanted_type(&item.r#type)
                    || files
                        && !item
                            .properties
                            .get("blob_ref")
                            .is_some_and(Value::is_string)
                {
                    continue;
                }
                let title = item.properties.get(field).and_then(Value::as_str);
                if title.is_some_and(|title| folded(title.trim()) == wanted) {
                    found.insert(item.id, Some(item.r#type));
                }
            }
        }
        Ok((found, more))
    }
}

/// An id as the server mints one, in its hyphenated form.
pub(crate) fn is_id(text: &str) -> bool {
    text.len() == 36 && uuid::Uuid::parse_str(text).is_ok()
}

/// Whether `text` names the item `id` in this copy: by its id, its title, or
/// the path of its file.
pub(crate) fn answers_to(
    conn: &Connection,
    catalog: &Catalog,
    paths: &dyn Paths,
    text: &str,
    id: &str,
) -> Result<bool> {
    let text = text.trim();
    if text == id {
        return Ok(true);
    }
    store::refuse_unless_usable(conn)?;
    let wanted = folded(text);
    if let Some(item) = store::item_by_id(conn, id)?
        && item
            .properties
            .get(fields::title_field(catalog, &item.r#type))
            .and_then(Value::as_str)
            .is_some_and(|title| folded(title.trim()) == wanted)
    {
        return Ok(true);
    }
    Ok(paths
        .of(conn, id)?
        .iter()
        .any(|path| file_names(path).contains(&wanted)))
}

/// The items at the other end of edges already held, each with the names it
/// answers to, so a name keeps naming what it already names whatever else
/// takes the same name.
pub(crate) struct Others {
    named: Vec<(String, BTreeSet<String>)>,
}

impl Others {
    pub fn load(
        conn: &Connection,
        catalog: &Catalog,
        paths: &dyn Paths,
        others: &[String],
    ) -> Result<Others> {
        let mut named = Vec::new();
        for other in others {
            if named.iter().any(|(held, _): &(String, _)| held == other) {
                continue;
            }
            store::refuse_unless_usable(conn)?;
            let mut names = BTreeSet::new();
            if let Some(item) = store::item_by_id(conn, other)?
                && let Some(title) = item
                    .properties
                    .get(fields::title_field(catalog, &item.r#type))
                    .and_then(Value::as_str)
            {
                names.insert(folded(title.trim()));
            }
            for path in paths.of(conn, other)? {
                names.extend(file_names(&path));
            }
            named.push((other.clone(), names));
        }
        Ok(Others { named })
    }

    /// The one `text` names, or more than one.
    pub fn named(&self, conn: &Connection, text: &str) -> Result<Option<Resolved>> {
        let text = text.trim();
        let wanted = folded(text);
        let found: Vec<&String> = self
            .named
            .iter()
            .filter(|(id, names)| text == id || names.contains(&wanted))
            .map(|(id, _)| id)
            .collect();
        Ok(match found.as_slice() {
            [] => None,
            [id] => {
                let r#type = store::item_by_id(conn, id)?.map(|item| item.r#type);
                Some(Resolved::Found {
                    id: (*id).clone(),
                    r#type,
                })
            }
            _ => Some(Resolved::Ambiguous),
        })
    }
}

/// The one of `others` that `text` names.
pub(crate) fn existing(
    conn: &Connection,
    catalog: &Catalog,
    paths: &dyn Paths,
    text: &str,
    others: &[String],
) -> Result<Option<Resolved>> {
    Others::load(conn, catalog, paths, others)?.named(conn, text)
}

/// Keep both spellings until resolution: C# notes may be a whole title,
/// and reading it as a heading on C must not quietly choose another item.
pub(crate) fn resolve_reference(
    typed: &Typed,
    mut resolve: impl FnMut(&str) -> Result<Resolved>,
) -> Result<Resolved> {
    if typed.name.is_empty() {
        return Ok(Resolved::Unmatched);
    }
    let found = resolve(&typed.name)?;
    // An id is read as an id alone (`folders/edge-id-read`), so what follows it
    // cannot make it name another item.
    if let Resolved::Found { id, .. } = &found
        && typed.raw != typed.name
        && !is_id(&typed.name)
    {
        match resolve(&typed.raw)? {
            Resolved::Found { id: whole, .. } if whole != *id => return Ok(Resolved::Ambiguous),
            Resolved::Ambiguous => return Ok(Resolved::Ambiguous),
            Resolved::Waiting => return Ok(Resolved::Waiting),
            Resolved::Unanswered(why) => return Ok(Resolved::Unanswered(why)),
            _ => {}
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_body_reference_never_guesses_when_the_whole_name_is_unsettled() {
        let typed = Typed::new("Note#part|shown");
        for whole in [
            Resolved::Ambiguous,
            Resolved::Waiting,
            Resolved::Unanswered("permission_denied".into()),
            Resolved::Found {
                id: "other".into(),
                r#type: None,
            },
        ] {
            let actual = resolve_reference(&typed, |text| {
                Ok(if text == "Note" {
                    Resolved::Found {
                        id: "note".into(),
                        r#type: None,
                    }
                } else {
                    whole.clone()
                })
            })
            .unwrap();
            assert!(!matches!(actual, Resolved::Found { .. }));
            if matches!(whole, Resolved::Waiting) {
                assert!(matches!(actual, Resolved::Waiting));
            }
        }
    }

    #[test]
    fn an_id_names_its_item_whatever_alias_follows_it() {
        let id = "01a10ed5-92a0-73e0-96d2-32cc12d86082";
        let actual = resolve_reference(&Typed::new(&format!("{id}|Shown")), |text| {
            Ok(if text == id {
                Resolved::Found {
                    id: id.into(),
                    r#type: None,
                }
            } else {
                Resolved::Waiting
            })
        })
        .unwrap();
        assert!(matches!(actual, Resolved::Found { id: found, .. } if found == id));
    }

    #[test]
    fn a_body_reference_keeps_the_target_when_its_suffix_is_unambiguous() {
        for whole in [
            Resolved::Unmatched,
            Resolved::Found {
                id: "note".into(),
                r#type: None,
            },
        ] {
            let actual = resolve_reference(&Typed::new("Note#part"), |text| {
                Ok(if text == "Note" {
                    Resolved::Found {
                        id: "note".into(),
                        r#type: None,
                    }
                } else {
                    whole.clone()
                })
            })
            .unwrap();
            assert!(matches!(actual, Resolved::Found { id, .. } if id == "note"));
        }
    }
}
