//! The item a typed name names: by its id, its title, or the path of its
//! file, ignoring case and Unicode form, across what the copy holds and what
//! the server answers.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::Connection;
use serde_json::{Map, Value};

use super::embed::FILE_TYPE;
use super::text::Typed;
use crate::catalog::Catalog;
use crate::folder::fields;
use crate::http::{TITLE_LOOKUP_NAMES, TITLE_LOOKUP_UNITS, TitledItem};
use crate::names::{folded, name_of, title_of};
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

    /// Every item answering to a name that `earlier` gave other items.
    pub fn differing(&self, earlier: &Names) -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        for (name, ids) in &self.ids {
            if earlier.ids.get(name) != Some(ids) {
                found.extend(ids.iter().cloned());
                found.extend(earlier.ids.get(name).into_iter().flatten().cloned());
            }
        }
        for (name, ids) in &earlier.ids {
            if !self.ids.contains_key(name) {
                found.extend(ids.iter().cloned());
            }
        }
        found
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

/// What the server answered for one name.
#[derive(Debug, Clone)]
enum Looked {
    /// The items it found, and whether it held more than it listed.
    Titled { items: Vec<TitledItem>, more: bool },
    /// The server could not be reached.
    Waiting,
    /// The server refused the lookup, for this reason.
    Unanswered(String),
}

pub(crate) struct Resolver<'a> {
    core: &'a Core,
    catalog: &'a Catalog,
    paths: &'a dyn Paths,
    online: bool,
    names: Option<Names>,
    cache: HashMap<String, Resolved>,
    /// What the server said about each name asked, by folded name.
    looked: HashMap<String, Looked>,
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
            looked: HashMap::new(),
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
        let local: Vec<String> = self
            .names()?
            .of(name)
            .map(|ids| ids.iter().cloned().collect())
            .unwrap_or_default();
        // The copy already holds two items under the name, and the server
        // cannot make that one.
        if local.len() > 1 {
            return Ok(Resolved::Ambiguous);
        }
        let mut found: BTreeMap<String, Option<String>> = BTreeMap::new();
        for id in local {
            let r#type = self.core.get(&id)?.map(|item| item.r#type);
            found.insert(id, r#type);
        }
        let (items, more) = match self.answer(name) {
            Looked::Titled { items, more } => (items, more),
            Looked::Waiting => return Ok(Resolved::Waiting),
            Looked::Unanswered(why) => return Ok(Resolved::Unanswered(why)),
        };
        let wanted = folded(name.trim());
        for item in items {
            if folded(item.title.trim()) == wanted {
                found.insert(item.id, Some(item.r#type));
            }
        }
        Ok(match found.len() {
            // The server lists 20 and holds more than that titled so.
            _ if more => Resolved::Ambiguous,
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
        match self.failure(error) {
            Looked::Unanswered(why) => Resolved::Unanswered(why),
            _ => Resolved::Waiting,
        }
    }

    fn failure(&mut self, error: crate::error::CoreError) -> Looked {
        if error.is_environmental() {
            self.online = false;
            Looked::Waiting
        } else {
            Looked::Unanswered(error.to_string())
        }
    }

    /// How many items the copy holds that `name` names.
    pub fn held_named(&mut self, name: &str) -> Result<usize> {
        Ok(self.names()?.of(name).map_or(0, BTreeSet::len))
    }

    /// Asks the server about every name at once, `TITLE_LOOKUP_NAMES` to a
    /// call, so the names a pass then resolves are answered from what it
    /// said. A name the copy holds under two items is left out, as it is
    /// ambiguous whatever the server holds; so is an id, and a name already
    /// asked. A name asked later that this left out is asked for alone.
    pub fn prefetch<'n>(&mut self, names: impl IntoIterator<Item = &'n str>) -> Result<()> {
        if !self.online {
            return Ok(());
        }
        let mut asked: Vec<(String, String)> = Vec::new();
        let mut queued: HashSet<String> = HashSet::new();
        for name in names {
            if is_id(name) {
                continue;
            }
            let sent = name.trim();
            let key = folded(sent);
            if key.is_empty()
                || self.looked.contains_key(&key)
                || !queued.insert(key.clone())
                || self.held_named(sent)? > 1
            {
                continue;
            }
            asked.push((key, sent.to_string()));
        }
        self.ask(asked);
        Ok(())
    }

    /// Sends the names, each with its folded key, in calls of
    /// `TITLE_LOOKUP_NAMES`. A call that fails leaves its names with the
    /// failure and the others as they were: after a failure of the network
    /// no more are sent, and any other refusal is that call's alone.
    fn ask(&mut self, asked: Vec<(String, String)>) {
        let (past, asked): (Vec<_>, Vec<_>) = asked
            .into_iter()
            .partition(|(_, sent)| sent.encode_utf16().count() > TITLE_LOOKUP_UNITS);
        // A title past the cap has no key, so nothing is titled so.
        for (key, _) in past {
            self.looked.insert(
                key,
                Looked::Titled {
                    items: Vec::new(),
                    more: false,
                },
            );
        }
        for page in asked.chunks(TITLE_LOOKUP_NAMES) {
            if !self.online {
                return;
            }
            let sent: Vec<String> = page.iter().map(|(_, sent)| sent.clone()).collect();
            let answers = self.core.http().and_then(|http| http.item_titles(&sent));
            match answers {
                Ok(answers) => {
                    for ((key, _), answer) in page.iter().zip(answers) {
                        self.looked.insert(
                            key.clone(),
                            Looked::Titled {
                                items: answer.items,
                                more: answer.more,
                            },
                        );
                    }
                }
                Err(error) => {
                    let failure = self.failure(error);
                    for (key, _) in page {
                        self.looked.insert(key.clone(), failure.clone());
                    }
                }
            }
        }
    }

    /// What the server says of `name`: what it said already, or else its
    /// answer to a call for the name alone.
    fn answer(&mut self, name: &str) -> Looked {
        let sent = name.trim();
        let key = folded(sent);
        if let Some(held) = self.looked.get(&key) {
            return held.clone();
        }
        if !self.online {
            return Looked::Waiting;
        }
        if key.is_empty() {
            return Looked::Titled {
                items: Vec::new(),
                more: false,
            };
        }
        self.ask(vec![(key.clone(), sent.to_string())]);
        self.looked.get(&key).cloned().unwrap_or(Looked::Waiting)
    }

    /// The file item named `name` among those the copy holds, `held`, and
    /// those the server holds under that title.
    pub fn file_named(&mut self, name: &str, held: &[String]) -> Result<Resolved> {
        if held.len() > 1 {
            return Ok(Resolved::Ambiguous);
        }
        let (items, more) = match self.answer(name) {
            Looked::Titled { items, more } => (items, more),
            Looked::Waiting => return Ok(Resolved::Waiting),
            Looked::Unanswered(why) => return Ok(Resolved::Unanswered(why)),
        };
        let wanted = folded(name.trim());
        let mut found: BTreeSet<String> = items
            .into_iter()
            .filter(|item| {
                item.has_blob
                    && self.catalog.matches(FILE_TYPE, &item.r#type)
                    && folded(item.title.trim()) == wanted
            })
            .map(|item| item.id)
            .collect();
        found.extend(held.iter().cloned());
        Ok(match found.len() {
            0 | 1 if more => Resolved::Unanswered(TOO_MANY.to_string()),
            0 => Resolved::Unmatched,
            1 => Resolved::Found {
                id: found.into_iter().next().expect("one"),
                r#type: None,
            },
            _ => Resolved::Ambiguous,
        })
    }
}

/// Why a name the server holds under more items than it lists is not read:
/// the one wanted may be among the rest.
const TOO_MANY: &str = "more items are titled it than the server lists";

/// An id as the server mints one, in its hyphenated form.
pub(crate) fn is_id(text: &str) -> bool {
    text.len() == 36 && uuid::Uuid::parse_str(text).is_ok()
}

/// Whether `text` names the item `id` in this copy: by its id, its title, or
/// the path of its file. An id names its item alone, whatever items are titled.
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
    if is_id(text) {
        return Ok(false);
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
/// takes the same name. An item in the bin answers to nothing, by id
/// included; one outside the copy's slice still answers to its id.
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
        if !others.is_empty() {
            store::refuse_unless_usable(conn)?;
        }
        Others::held(conn, catalog, paths, others)
    }

    /// `load`, from whatever the copy holds, usable or not.
    pub fn held(
        conn: &Connection,
        catalog: &Catalog,
        paths: &dyn Paths,
        others: &[String],
    ) -> Result<Others> {
        let mut named = Vec::new();
        for other in others {
            if named.iter().any(|(held, _): &(String, _)| held == other)
                || store::in_bin(conn, other)?
            {
                continue;
            }
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

    /// The one `text` names, or more than one. An id names its item alone,
    /// whatever items are titled.
    pub fn named(&self, conn: &Connection, text: &str) -> Result<Option<Resolved>> {
        let text = text.trim();
        let wanted = folded(text);
        let by_id = is_id(text);
        let found: Vec<&String> = self
            .named
            .iter()
            .filter(|(id, names)| text == id || !by_id && names.contains(&wanted))
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

    #[test]
    fn an_id_answers_to_its_item_alone_whatever_another_is_titled() {
        use crate::model::Draft;
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(dir.path().join("copy.db"), None).unwrap();
        let note = |title: &str| {
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": title, "body": "" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap()
            .item_id
            .unwrap()
        };
        let target = note("Target");
        let titled = note(&target);
        let conn = core.conn().unwrap();
        let catalog = Catalog::load(&conn).unwrap();
        let answers = |text: &str, id: &str| {
            answers_to(&conn, &catalog, &crate::body::rule::Placements, text, id).unwrap()
        };
        assert!(answers(&target, &target));
        assert!(
            !answers(&target, &titled),
            "an id answered to an item titled with it"
        );
        assert!(answers("Target", &target));
        assert!(answers(&format!(" {} ", titled), &titled));
    }

    /// A copy on a scripted server, with the notes titled `titles` held.
    fn copy_holding(
        server: &crate::scripted::Scripted,
        dir: &std::path::Path,
        titles: &[&str],
    ) -> std::sync::Arc<Core> {
        use crate::catalog::Indexing;
        use crate::store::testing::wire_item;
        let core = crate::stop_tests::copy_in_keyed(server, dir, "k");
        for (at, title) in titles.iter().enumerate() {
            let row = wire_item(
                &format!("held-{at}"),
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                serde_json::json!({ "title": title }),
            );
            store::upsert_item(&core.conn().unwrap(), &row, None, &Indexing::default()).unwrap();
        }
        core
    }

    /// What `/items/titles` answers when it finds nothing for `count` names.
    fn nothing_for(count: usize) -> crate::scripted::Answer {
        let result = r#"{"name":"","items":[],"more":false}"#;
        crate::scripted::json(
            200,
            &format!("{{\"results\":[{}]}}", vec![result; count].join(",")),
        )
    }

    fn titled(id: &str, title: &str) -> String {
        format!(r#"{{"id":"{id}","type":"core.note","title":"{title}","has_blob":false}}"#)
    }

    fn answer_of(entries: &[String]) -> crate::scripted::Answer {
        let results: Vec<String> = entries
            .iter()
            .map(|items| format!(r#"{{"name":"","items":[{items}],"more":false}}"#))
            .collect();
        crate::scripted::json(200, &format!(r#"{{"results":[{}]}}"#, results.join(",")))
    }

    fn sent_names(server: &crate::scripted::Scripted) -> Vec<Vec<String>> {
        server
            .seen("/items/titles")
            .iter()
            .map(|seen| {
                serde_json::from_slice::<serde_json::Value>(&seen.body).unwrap()["names"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|name| name.as_str().unwrap().to_string())
                    .collect()
            })
            .collect()
    }

    fn resolver<'a>(core: &'a Core, catalog: &'a Catalog) -> Resolver<'a> {
        Resolver::new(core, catalog, &crate::body::rule::Placements)
    }

    fn catalog_of(core: &Core) -> Catalog {
        Catalog::load(&core.conn().unwrap()).unwrap()
    }

    #[test]
    fn names_are_asked_in_calls_of_the_most_a_call_takes_each_once() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![nothing_for(200), nothing_for(200), nothing_for(50)],
        );
        let names: Vec<String> = (0..450).map(|at| format!("Name {at}")).collect();
        let mut again = names.clone();
        // The same name in another case and with white space is the same name.
        again.push(" NAME 7 ".into());
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(again.iter().map(String::as_str)).unwrap();
        let sent = sent_names(&server);
        assert_eq!(
            sent.iter().map(Vec::len).collect::<Vec<_>>(),
            [200, 200, 50]
        );
        assert_eq!(sent.concat(), names);
        // Resolving them asks the server nothing more.
        for name in &names {
            assert!(matches!(
                resolver.resolve(name).unwrap(),
                Resolved::Unmatched
            ));
        }
        assert_eq!(server.seen("/items/titles").len(), 3);
    }

    #[test]
    fn a_name_the_copy_holds_under_two_items_is_not_asked() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &["Twin", "TWIN", "Solo"]);
        let catalog = catalog_of(&core);
        server.on("/items/titles", vec![nothing_for(2)]);
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(["Twin", "Solo", "Other"]).unwrap();
        assert_eq!(sent_names(&server), [["Solo", "Other"]]);
        assert!(matches!(
            resolver.resolve("twin").unwrap(),
            Resolved::Ambiguous
        ));
        assert!(matches!(
            resolver.resolve("Solo").unwrap(),
            Resolved::Found { .. }
        ));
        assert_eq!(server.seen("/items/titles").len(), 1);
    }

    #[test]
    fn a_name_the_server_holds_under_more_items_than_it_lists_is_ambiguous() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![crate::scripted::json(
                200,
                &format!(
                    r#"{{"results":[{{"name":"Common","items":[{}],"more":true}}]}}"#,
                    titled("one", "Common")
                ),
            )],
        );
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(["Common"]).unwrap();
        assert!(matches!(
            resolver.resolve("Common").unwrap(),
            Resolved::Ambiguous
        ));
    }

    #[test]
    fn a_name_held_once_and_titled_once_on_the_server_is_ambiguous() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &["Ada"]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![answer_of(&[titled("elsewhere", "ADA")])],
        );
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(["Ada"]).unwrap();
        assert!(matches!(
            resolver.resolve("Ada").unwrap(),
            Resolved::Ambiguous
        ));
    }

    #[test]
    fn the_server_is_compared_by_the_core_whatever_it_answers() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![answer_of(&[titled("same", "ada")
                + ","
                + &titled("other", "Adam")])],
        );
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(["Ada"]).unwrap();
        assert!(matches!(
            resolver.resolve("Ada").unwrap(),
            Resolved::Found { id, .. } if id == "same"
        ));
    }

    #[test]
    fn a_call_the_network_fails_leaves_its_names_waiting_and_asks_no_more() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![
                nothing_for(200),
                crate::scripted::refusal(503, "unavailable"),
            ],
        );
        let names: Vec<String> = (0..450).map(|at| format!("Name {at}")).collect();
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(names.iter().map(String::as_str)).unwrap();
        assert_eq!(server.seen("/items/titles").len(), 2);
        assert!(matches!(
            resolver.resolve("Name 0").unwrap(),
            Resolved::Unmatched
        ));
        for name in ["Name 200", "Name 449"] {
            assert!(matches!(resolver.resolve(name).unwrap(), Resolved::Waiting));
        }
        assert_eq!(server.seen("/items/titles").len(), 2);
    }

    #[test]
    fn a_rate_limited_call_leaves_its_names_waiting() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![crate::scripted::Answer::Json {
                status: 429,
                body: r#"{"error":{"code":"rate_limited","message":"scripted"}}"#.into(),
                headers: vec![("Retry-After".into(), "1".into())],
            }],
        );
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(["Ada", "Grace"]).unwrap();
        assert!(matches!(
            resolver.resolve("Ada").unwrap(),
            Resolved::Waiting
        ));
        assert!(matches!(
            resolver.resolve("Grace").unwrap(),
            Resolved::Waiting
        ));
        assert_eq!(server.seen("/items/titles").len(), 1);
    }

    #[test]
    fn a_refused_call_leaves_only_its_names_unanswered() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on(
            "/items/titles",
            vec![
                crate::scripted::refusal(403, "type_not_permitted"),
                nothing_for(50),
            ],
        );
        let names: Vec<String> = (0..250).map(|at| format!("Name {at}")).collect();
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(names.iter().map(String::as_str)).unwrap();
        assert_eq!(server.seen("/items/titles").len(), 2);
        assert!(matches!(
            resolver.resolve("Name 199").unwrap(),
            Resolved::Unanswered(_)
        ));
        assert!(matches!(
            resolver.resolve("Name 200").unwrap(),
            Resolved::Unmatched
        ));
    }

    #[test]
    fn a_name_of_punctuation_is_asked_and_one_of_white_space_or_past_the_cap_is_not() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on("/items/titles", vec![answer_of(&[titled("dots", "...")])]);
        let long = "n".repeat(TITLE_LOOKUP_UNITS + 1);
        let mut resolver = resolver(&core, &catalog);
        resolver.prefetch(["...", " \u{3000} ", &long]).unwrap();
        assert_eq!(sent_names(&server), [["..."]]);
        assert!(matches!(
            resolver.resolve("...").unwrap(),
            Resolved::Found { id, .. } if id == "dots"
        ));
        assert!(matches!(
            resolver.resolve(&long).unwrap(),
            Resolved::Unmatched
        ));
        assert!(matches!(
            resolver.resolve(" \u{3000} ").unwrap(),
            Resolved::Unmatched
        ));
        assert_eq!(server.seen("/items/titles").len(), 1);
    }

    #[test]
    fn a_name_not_prefetched_is_asked_for_alone() {
        let server = crate::scripted::Scripted::start();
        let dir = tempfile::tempdir().unwrap();
        let core = copy_holding(&server, dir.path(), &[]);
        let catalog = catalog_of(&core);
        server.on("/items/titles", vec![nothing_for(1)]);
        let mut resolver = resolver(&core, &catalog);
        assert!(matches!(
            resolver.resolve("Late").unwrap(),
            Resolved::Unmatched
        ));
        assert_eq!(sent_names(&server), [["Late"]]);
    }

    #[test]
    fn the_name_fold_agrees_with_the_cases_the_server_is_held_to() {
        #[derive(serde::Deserialize)]
        struct Cases {
            cases: Vec<Case>,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            about: String,
            name: String,
            folded: String,
        }
        let cases: Cases = serde_json::from_str(include_str!(
            "../../../../conformance/fixtures/name-fold.json"
        ))
        .unwrap();
        assert!(!cases.cases.is_empty());
        for case in cases.cases {
            assert_eq!(folded(case.name.trim()), case.folded, "{}", case.about);
        }
    }
}
