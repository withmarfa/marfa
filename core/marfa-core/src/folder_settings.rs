//! A folder's settings read from the copy, its search answered from the
//! copy, and its settings written through the folder door. The door is the
//! only one that writes a `system.folder` (`items.md` 49), so a write here is
//! sent at once and never queued.

use serde_json::{Map, Value};

use crate::folder::{FOLDER_TYPE, Settings};
use crate::http::{Method, Outgoing};
use crate::model::{Item, ItemState, SearchHit, Shown, Sort, Tier};
use crate::wire::{WireItem, WireItemWithMetadata};
use crate::{Core, CoreError, Result, catalog, query, read_view, search, store};

/// A `system.folder` row and the settings it carries.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FolderRow {
    pub id: String,
    pub version: i64,
    pub state: ItemState,
    pub settings: Settings,
}

impl FolderRow {
    fn of(item: &Item) -> Result<FolderRow> {
        Ok(FolderRow {
            id: item.id.clone(),
            version: item.version,
            state: item.state,
            settings: Settings::parse(&item.id, &item.r#type, &item.properties)?,
        })
    }

    fn of_wire(item: &WireItem) -> Result<FolderRow> {
        Ok(FolderRow {
            id: item.id.clone(),
            version: item.version,
            state: item.state.parse()?,
            settings: Settings::parse(&item.id, &item.r#type, &item.properties)?,
        })
    }
}

impl Core {
    /// `None` where the copy does not hold the row. A row that is not a
    /// folder, or whose settings name something no folder follows, is
    /// refused `Invalid`.
    pub fn folder(&self, id: &str) -> Result<Option<FolderRow>> {
        self.get(id)?.as_ref().map(FolderRow::of).transpose()
    }

    /// The items the folder's search holds, as its own pass holds them. A
    /// search the copy cannot answer whole is refused `Invalid`, never
    /// answered in part: a type or tier outside the slice, `beneath` without
    /// `parent-of` held whole, and a `backref` condition, which no copy
    /// holds the edges to answer.
    pub fn list_in_folder(
        &self,
        id: &str,
        sort: Sort,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Vec<(Item, Shown)>> {
        let (conn, catalog, clauses, values) = self.folder_scope(id)?;
        Ok(
            query::list_where(&conn, &clauses, &values, sort, limit, offset)?
                .into_iter()
                .map(|item| {
                    let shown = catalog.shown(&item);
                    (item, shown)
                })
                .collect(),
        )
    }

    /// A local search narrowed to what the folder holds, refused as
    /// `list_in_folder` refuses.
    pub fn search_in_folder(
        &self,
        text: &str,
        id: &str,
        limit: usize,
    ) -> Result<Vec<(SearchHit, Shown)>> {
        let (conn, catalog, clauses, values) = self.folder_scope(id)?;
        Ok(search::search_where(&conn, text, &clauses, values, limit)?
            .into_iter()
            .map(|hit| {
                let shown = catalog.shown(&hit.item);
                (hit, shown)
            })
            .collect())
    }

    /// What a folder's own pass holds; its slice is made from the settings,
    /// so it is not asked whether the slice answers them.
    pub(crate) fn held_by(&self, settings: &Settings) -> Result<Vec<Item>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let catalog = catalog::Catalog::load(&conn)?;
        let (mut clauses, mut values) = (Vec::new(), Vec::new());
        settings.narrow(&catalog, &mut clauses, &mut values)?;
        query::list_where(&conn, &clauses, &values, Sort::default(), None, None)
    }

    #[allow(clippy::type_complexity)]
    fn folder_scope(
        &self,
        id: &str,
    ) -> Result<(
        std::sync::MutexGuard<'_, rusqlite::Connection>,
        catalog::Catalog,
        Vec<String>,
        Vec<Value>,
    )> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        let Some(row) = store::item_by_id(&conn, id)? else {
            return Err(CoreError::NotFound {
                code: "not_held".into(),
                message: format!(
                    "{id} is not held in this working copy: pin it, or hydrate with {FOLDER_TYPE} in the slice"
                ),
            });
        };
        let settings = Settings::of(&row)?;
        let catalog = catalog::Catalog::load(&conn)?;
        settings.refuse_unless_answerable(&conn, &catalog)?;
        let (mut clauses, mut values) = (Vec::new(), Vec::new());
        settings.narrow(&catalog, &mut clauses, &mut values)?;
        Ok((conn, catalog, clauses, values))
    }

    /// `settings` must carry a `title`. Settings no folder could follow are
    /// refused before anything is sent. The same `idempotency_key` sent
    /// again is answered with the first folder, never a second.
    pub fn create_folder(
        &self,
        settings: &Map<String, Value>,
        idempotency_key: Option<&str>,
    ) -> Result<FolderRow> {
        Settings::read("(new)", FOLDER_TYPE, "active", settings)?
            .check_types(&self.catalog_held()?)?;
        self.send_to_folder_door(
            Method::Post,
            vec!["folders".into()],
            Value::Object(settings.clone()).to_string(),
            idempotency_key,
        )
    }

    /// Replaces each setting `changes` names whole, based on `version`. A
    /// change to a setting changed since `version` is refused `409
    /// version_conflict`; one to a revoked folder `400 invalid_transition`.
    pub fn change_folder(
        &self,
        id: &str,
        changes: &Map<String, Value>,
        version: i64,
        idempotency_key: Option<&str>,
    ) -> Result<FolderRow> {
        if changes.is_empty() {
            return Err(CoreError::Invalid(
                "a change to a folder names at least one setting".into(),
            ));
        }
        if changes.contains_key("version") {
            return Err(CoreError::Invalid(
                "a folder's version is the one the change is based on, not a setting".into(),
            ));
        }
        // Checked as it will stand where the copy holds it, or else alone.
        let mut merged = match self.get(id)? {
            Some(held) if held.r#type == FOLDER_TYPE => held.properties,
            _ => Map::new(),
        };
        merged.remove("revoked_at");
        merged.extend(changes.clone());
        Settings::read(id, FOLDER_TYPE, "active", &merged)?.check_types(&self.catalog_held()?)?;
        let mut body = changes.clone();
        body.insert("version".into(), Value::from(version));
        self.send_to_folder_door(
            Method::Patch,
            vec!["folders".into(), id.into()],
            Value::Object(body).to_string(),
            idempotency_key,
        )
    }

    /// A revoked folder is final: it changes no more, and a second revoke
    /// is refused `400 invalid_transition`.
    pub fn revoke_folder(&self, id: &str, idempotency_key: Option<&str>) -> Result<FolderRow> {
        self.send_to_folder_door(
            Method::Post,
            vec!["folders".into(), id.into(), "revoke".into()],
            String::new(),
            idempotency_key,
        )
    }

    fn catalog_held(&self) -> Result<catalog::Catalog> {
        catalog::Catalog::load(&*self.conn()?)
    }

    fn send_to_folder_door(
        &self,
        method: Method,
        segments: Vec<String>,
        body: String,
        idempotency_key: Option<&str>,
    ) -> Result<FolderRow> {
        self.lock.refuse_unless_writer()?;
        let http = self.http()?;
        crate::catch_up::refuse_another_instance(self, http)?;
        let key = idempotency_key
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let answer = http.send(&Outgoing {
            method,
            segments,
            params: Vec::new(),
            body: &body,
            idempotency_key: &key,
        })?;
        if !answer.is_success() {
            return Err(http.refused(
                answer.status,
                answer.contract_named,
                &answer.body,
                answer.retry_after_seconds,
            ));
        }
        let answered: WireItemWithMetadata = serde_json::from_str(&answer.body)
            .map_err(|error| CoreError::Decoding(format!("the folder door's answer: {error}")))?;
        self.hold_answered(&answered.item.id);
        FolderRow::of_wire(&answered.item)
    }

    /// The write is done whatever this finds: a row it cannot read again now
    /// reaches the copy at its next catch-up, so a failure here is not the
    /// write's.
    fn hold_answered(&self, id: &str) {
        let Ok(http) = self.http() else { return };
        let context = match self.conn().and_then(|conn| {
            if !store::hydrated(&conn)? {
                return Ok(None);
            }
            read_view::Context::capture(&conn).map(Some)
        }) {
            Ok(Some(context)) => context,
            _ => return,
        };
        let held = context.http(http).item(id).and_then(|row| {
            let Some(row) = row else { return Ok(()) };
            let mut conn = self.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let catalog = catalog::Catalog::load(&tx)?;
            // `slice_holds` asks whether the row was listed when last held,
            // and this one may be new.
            let takes = store::pinned(&tx, id)?
                || (row.listed == Some(true)
                    && match store::slice(&tx)? {
                        Some((types, tier)) => store::slice_takes(
                            &catalog,
                            &types,
                            tier,
                            &row.item.r#type,
                            Tier::parse_wire(row.item.tier.as_deref())?,
                        ),
                        None => false,
                    });
            if takes {
                crate::hydrate::hold_row(&tx, &catalog, &row, &[])?;
            }
            tx.commit()?;
            Ok(())
        });
        if let Err(error) = held {
            let _ = context.failed(self, error);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Server;
    use crate::scripted::{self, Scripted, certified};
    use crate::store::testing::{wire_item, wire_type};

    const FOLDER: &str = "01a00000-0000-7000-8000-00000000f01d";

    fn copy(server: Option<&Scripted>, slice: &[&str], tier: &str, whole: &[&str]) -> Core {
        let core = Core::open_in_memory(server.map(|server| Server {
            url: server.url(),
            key: "k".into(),
        }))
        .unwrap();
        let conn = core.conn().unwrap();
        store::replace_types(
            &conn,
            &[
                wire_type("core.note", None, Some("title")),
                wire_type("core.task", None, Some("title")),
                wire_type("user.recipe", Some("core.note"), Some("title")),
                wire_type(FOLDER_TYPE, None, None),
            ],
        )
        .unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, read_view::FENCE, scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, scripted::INSTANCE).unwrap();
        store::meta_set(
            &conn,
            store::META_SLICE_TYPES,
            &serde_json::to_string(slice).unwrap(),
        )
        .unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, tier).unwrap();
        store::meta_set(
            &conn,
            store::META_SLICE_EDGE_TYPES,
            &serde_json::to_string(whole).unwrap(),
        )
        .unwrap();
        drop(conn);
        core
    }

    fn put(core: &Core, id: &str, r#type: &str, state: &str, tier: &str, tags: &[&str]) {
        let conn = core.conn().unwrap();
        let mut row = wire_item(
            id,
            r#type,
            state,
            "2026-01-01T00:00:00Z",
            json!({ "title": format!("{id} pasta"), "body": "" }),
        );
        row.tier = Some(tier.into());
        let tags: Vec<String> = tags.iter().map(|tag| tag.to_string()).collect();
        let indexing = catalog::Catalog::load(&conn).unwrap().indexing(r#type);
        store::put_server_item(&conn, &row, Some(&tags), &indexing).unwrap();
    }

    fn folder(core: &Core, state: &str, settings: Value) {
        let conn = core.conn().unwrap();
        let row = wire_item(FOLDER, FOLDER_TYPE, state, "2026-01-01T00:00:00Z", settings);
        store::put_server_item(&conn, &row, Some(&[]), &Default::default()).unwrap();
    }

    fn ids(items: Vec<Item>) -> Vec<String> {
        let mut ids: Vec<String> = items.into_iter().map(|item| item.id).collect();
        ids.sort();
        ids
    }

    fn listed(core: &Core) -> Result<Vec<String>> {
        core.list_in_folder(FOLDER, Sort::default(), None, None)
            .map(|found| ids(found.into_iter().map(|(item, _)| item).collect()))
    }

    #[test]
    fn a_list_in_a_folder_holds_what_the_folders_own_pass_holds() {
        let core = copy(
            None,
            &["core.note", "core.task", FOLDER_TYPE],
            "library",
            &[],
        );
        put(&core, "active", "core.note", "active", "library", &["x"]);
        put(
            &core,
            "archived",
            "core.note",
            "archived",
            "library",
            &["x"],
        );
        put(&core, "recipe", "user.recipe", "active", "library", &["x"]);
        put(&core, "trashed", "core.note", "trashed", "library", &["x"]);
        put(&core, "untagged", "core.note", "active", "library", &[]);
        put(&core, "task", "core.task", "active", "library", &["x"]);
        put(&core, "feed", "core.note", "active", "feed", &["x"]);
        let settings = json!({
            "title": "Tagged notes",
            "search": { "types": ["core.note"], "filter": "tags contains \"x\"" },
        });
        folder(&core, "active", settings.clone());
        let expected = vec!["active", "archived", "recipe"];
        assert_eq!(listed(&core).unwrap(), expected);
        let own =
            Settings::read(FOLDER, FOLDER_TYPE, "active", settings.as_object().unwrap()).unwrap();
        assert_eq!(ids(core.held_by(&own).unwrap()), expected);

        let held = core.folder(FOLDER).unwrap().unwrap();
        assert_eq!(held.state, ItemState::Active);
        assert_eq!(held.settings.title.as_deref(), Some("Tagged notes"));
        assert_eq!(held.settings.types(), ["core.note".to_string()]);
        assert_eq!(core.folder("absent").unwrap(), None);

        let hits = core.search_in_folder("pasta", FOLDER, 20).unwrap();
        let mut found: Vec<&str> = hits.iter().map(|(hit, _)| hit.item.id.as_str()).collect();
        found.sort_unstable();
        assert_eq!(found, expected);

        folder(
            &core,
            "active",
            json!({ "title": "Archived", "search": { "types": ["core.note"], "state": ["archived"] } }),
        );
        assert_eq!(listed(&core).unwrap(), ["archived"]);
        let page = core
            .list_in_folder(FOLDER, Sort::default(), Some(1), Some(0))
            .unwrap();
        assert_eq!(page.len(), 1);
    }

    #[test]
    fn a_copy_of_both_tiers_answers_a_folder_of_either_with_that_tier_alone() {
        let core = copy(None, &["core.note", FOLDER_TYPE], "all", &[]);
        put(&core, "shelved", "core.note", "active", "library", &[]);
        put(&core, "inbox", "core.note", "active", "feed", &[]);
        for (tier, held) in [("library", "shelved"), ("feed", "inbox")] {
            folder(
                &core,
                "active",
                json!({ "title": tier, "search": { "types": ["core.note"], "tier": tier } }),
            );
            assert_eq!(listed(&core).unwrap(), [held], "{tier}");
        }
    }

    #[test]
    fn a_search_the_copy_cannot_answer_whole_is_refused_never_answered_in_part() {
        let refused = |core: &Core, settings: Value| {
            folder(core, "active", settings);
            match listed(core) {
                Err(CoreError::Invalid(message)) => message,
                other => panic!("{other:?}"),
            }
        };
        let notes = copy(None, &["core.note", FOLDER_TYPE], "library", &[]);
        put(&notes, "note", "core.note", "active", "library", &[]);
        put(&notes, "parent", "core.note", "active", "library", &[]);
        // The witness: a search the slice answers is listed.
        folder(
            &notes,
            "active",
            json!({ "title": "Notes", "search": { "types": ["core.note"] } }),
        );
        assert_eq!(listed(&notes).unwrap(), ["note", "parent"]);
        let every = refused(&notes, json!({ "title": "All" }));
        assert!(every.contains("core.task"), "{every}");
        assert!(!every.contains("core.note"), "{every}");
        let feed = refused(
            &notes,
            json!({ "title": "Feed", "search": { "types": ["core.note"], "tier": "feed" } }),
        );
        assert!(feed.contains("feed"), "{feed}");
        let beneath = refused(
            &notes,
            json!({ "title": "Under", "search": { "types": ["core.note"], "beneath": "parent" } }),
        );
        assert!(beneath.contains("parent-of"), "{beneath}");
        let backref = refused(
            &notes,
            json!({ "title": "Back", "search": { "filter": "backref[parent-of] exists" } }),
        );
        assert!(backref.contains("backref"), "{backref}");
        let unknown = refused(
            &notes,
            json!({ "title": "Near", "search": { "near": "x" } }),
        );
        assert!(unknown.contains("near"), "{unknown}");
        let revoked = {
            folder(&notes, "revoked", json!({ "title": "Gone" }));
            listed(&notes).unwrap_err().to_string()
        };
        assert!(revoked.contains("revoked"), "{revoked}");
        assert!(matches!(
            notes.list_in_folder("absent", Sort::default(), None, None),
            Err(CoreError::NotFound { code, .. }) if code == "not_held"
        ));

        let whole = copy(None, &["*", FOLDER_TYPE], "library", &["parent-of"]);
        put(&whole, "task", "core.task", "active", "library", &[]);
        folder(&whole, "active", json!({ "title": "All" }));
        assert_eq!(listed(&whole).unwrap(), ["task"]);
        folder(
            &whole,
            "active",
            json!({ "title": "Under", "search": { "beneath": "task" } }),
        );
        assert_eq!(listed(&whole).unwrap(), ["task"]);
    }

    #[test]
    fn a_folder_named_by_type_is_held_at_either_tier_and_every_type_leaves_it_out() {
        let core = copy(None, &[], "feed", &[]);
        let catalog = catalog::Catalog::load(&core.conn().unwrap()).unwrap();
        let takes = |types: &[&str], tier: Tier, row_type: &str, row_tier: Tier| {
            let types: Vec<String> = types.iter().map(|named| named.to_string()).collect();
            store::slice_takes(&catalog, &types, tier.into(), row_type, Some(row_tier))
        };
        assert!(takes(
            &[FOLDER_TYPE],
            Tier::Feed,
            FOLDER_TYPE,
            Tier::Library
        ));
        assert!(takes(
            &[FOLDER_TYPE],
            Tier::Library,
            FOLDER_TYPE,
            Tier::Library
        ));
        assert!(takes(&["system.*"], Tier::Feed, FOLDER_TYPE, Tier::Library));
        assert!(!takes(&["*"], Tier::Library, FOLDER_TYPE, Tier::Library));
        // The witness that the tier still holds for every other type.
        assert!(!takes(
            &["core.note"],
            Tier::Feed,
            "core.note",
            Tier::Library
        ));
        assert!(takes(&["*"], Tier::Library, "core.note", Tier::Library));
    }

    fn answered(state: &str, version: i64, settings: Value) -> String {
        json!({
            "item": {
                "id": FOLDER, "type": FOLDER_TYPE, "properties": settings, "state": state,
                "tier": "library", "version": version, "schema_version": 0, "source": "test",
                "occurred_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            },
            "metadata": { "item_id": FOLDER, "tags": [] },
        })
        .to_string()
    }

    fn read_back(state: &str, version: i64, settings: Value) -> scripted::Answer {
        let mut body: Value = serde_json::from_str(&answered(state, version, settings)).unwrap();
        body["listed"] = Value::Bool(true);
        certified(scripted::json(200, &body.to_string()))
    }

    #[test]
    fn a_folder_is_created_changed_and_revoked_through_the_folder_door_and_held_at_once() {
        let server = Scripted::start();
        server.on("/", vec![scripted::root(scripted::INSTANCE)]);
        let core = copy(Some(&server), &["core.note", FOLDER_TYPE], "library", &[]);
        let settings = json!({ "title": "Notes", "search": { "types": ["core.note"] } });
        server.on(
            "/folders",
            vec![scripted::json(
                201,
                &answered("active", 1, settings.clone()),
            )],
        );
        server.on(
            &format!("/items/{FOLDER}"),
            vec![read_back("active", 1, settings.clone())],
        );
        let created = core
            .create_folder(settings.as_object().unwrap(), Some("same"))
            .unwrap();
        assert_eq!((created.id.as_str(), created.version), (FOLDER, 1));
        assert_eq!(
            serde_json::from_slice::<Value>(&server.seen("/folders")[0].body).unwrap(),
            settings
        );
        assert_eq!(core.folder(FOLDER).unwrap().unwrap().version, 1);
        assert!(listed(&core).unwrap().is_empty());

        let changed_settings =
            json!({ "title": "Recipes", "search": { "types": ["user.recipe"] } });
        server.on(
            &format!("/folders/{FOLDER}"),
            vec![scripted::json(
                200,
                &answered("active", 2, changed_settings.clone()),
            )],
        );
        server.on(
            &format!("/items/{FOLDER}"),
            vec![read_back("active", 2, changed_settings.clone())],
        );
        let changes = json!({ "title": "Recipes", "search": { "types": ["user.recipe"] } });
        let changed = core
            .change_folder(FOLDER, changes.as_object().unwrap(), 1, None)
            .unwrap();
        assert_eq!(changed.version, 2);
        let sent: Value =
            serde_json::from_slice(&server.seen(&format!("/folders/{FOLDER}"))[0].body).unwrap();
        assert_eq!(sent["version"], 1);
        assert_eq!(sent["title"], "Recipes");
        assert_eq!(
            core.folder(FOLDER)
                .unwrap()
                .unwrap()
                .settings
                .title
                .as_deref(),
            Some("Recipes")
        );

        let mut revoked_settings = changed_settings.clone();
        revoked_settings["revoked_at"] = json!("2026-01-02T00:00:00Z");
        server.on(
            &format!("/folders/{FOLDER}/revoke"),
            vec![
                scripted::json(200, &answered("revoked", 2, revoked_settings.clone())),
                scripted::refusal(400, "invalid_transition"),
            ],
        );
        server.on(
            &format!("/items/{FOLDER}"),
            vec![read_back("revoked", 2, revoked_settings)],
        );
        let revoked = core.revoke_folder(FOLDER, None).unwrap();
        assert_eq!(revoked.state, ItemState::Revoked);
        assert_eq!(revoked.settings.title.as_deref(), Some("Recipes"));
        assert_eq!(
            core.folder(FOLDER).unwrap().unwrap().state,
            ItemState::Revoked
        );
        assert!(matches!(
            core.revoke_folder(FOLDER, None),
            Err(CoreError::Validation { code, .. }) if code == "invalid_transition"
        ));
    }

    #[test]
    fn an_answered_write_is_the_callers_whatever_the_read_back_or_the_settings_say() {
        let server = Scripted::start();
        server.on("/", vec![scripted::root(scripted::INSTANCE)]);
        let backref =
            json!({ "title": "Back", "search": { "filter": "backref[parent-of] exists" } });
        let mut revoked = backref.clone();
        revoked["revoked_at"] = json!("2026-01-02T00:00:00Z");
        server.on(
            &format!("/folders/{FOLDER}/revoke"),
            vec![scripted::json(
                200,
                &answered("revoked", 2, revoked.clone()),
            )],
        );
        server.on(
            &format!("/items/{FOLDER}"),
            vec![certified(scripted::refusal(500, "internal_error"))],
        );
        let core = copy(Some(&server), &["core.note", FOLDER_TYPE], "library", &[]);
        folder(&core, "active", backref);
        // A folder whose search no copy answers is still read, and refused
        // only where its search would be answered.
        assert!(core.folder(FOLDER).unwrap().is_some());
        assert!(matches!(listed(&core), Err(CoreError::Invalid(_))));
        let answered_row = core.revoke_folder(FOLDER, None).unwrap();
        assert_eq!(answered_row.state, ItemState::Revoked);
        assert_eq!(
            core.folder(FOLDER).unwrap().unwrap().state,
            ItemState::Active,
            "a read-back that failed leaves the row to the next catch-up"
        );

        let settings = json!({ "title": "Notes" });
        let untaken = copy(Some(&server), &["core.note"], "library", &[]);
        server.on(
            "/folders",
            vec![scripted::json(
                201,
                &answered("active", 1, settings.clone()),
            )],
        );
        server.on(
            &format!("/items/{FOLDER}"),
            vec![read_back("active", 1, settings.clone())],
        );
        untaken
            .create_folder(settings.as_object().unwrap(), None)
            .unwrap();
        assert_eq!(
            untaken.folder(FOLDER).unwrap(),
            None,
            "the slice does not take it"
        );
        store::pin(&untaken.conn().unwrap(), FOLDER).unwrap();
        untaken
            .create_folder(settings.as_object().unwrap(), Some("again"))
            .unwrap();
        assert_eq!(
            untaken.folder(FOLDER).unwrap().unwrap().version,
            1,
            "a pin takes it"
        );
    }

    #[test]
    fn settings_no_folder_could_follow_are_refused_before_anything_is_sent() {
        let server = Scripted::start();
        server.on("/", vec![scripted::root(scripted::INSTANCE)]);
        let core = copy(Some(&server), &["core.note", FOLDER_TYPE], "library", &[]);
        for settings in [
            json!({ "title": "Back", "search": { "filter": "backref[parent-of] exists" } }),
            json!({ "title": "Near", "search": { "near": "x" } }),
            json!({ "title": "Off", "search": { "types": ["core.note"] }, "defaults": { "type": "core.task" } }),
        ] {
            assert!(
                core.create_folder(settings.as_object().unwrap(), None)
                    .is_err(),
                "{settings}"
            );
        }
        folder(
            &core,
            "active",
            json!({ "title": "Notes", "search": { "types": ["core.note"] } }),
        );
        let mismatched = json!({ "defaults": { "type": "core.task" } });
        assert!(
            core.change_folder(FOLDER, mismatched.as_object().unwrap(), 1, None)
                .is_err()
        );
        assert!(core.change_folder(FOLDER, &Map::new(), 1, None).is_err());
        assert!(server.seen("/folders").is_empty());
        assert!(server.seen(&format!("/folders/{FOLDER}")).is_empty());

        let offline = copy(None, &["core.note"], "library", &[]);
        let settings = json!({ "title": "Notes" });
        assert!(matches!(
            offline.create_folder(settings.as_object().unwrap(), None),
            Err(CoreError::NoServer)
        ));
    }
}
