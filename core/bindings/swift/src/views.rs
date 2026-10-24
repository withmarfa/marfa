//! Views read from the working copy without contacting the server.

use crate::{Completeness, Core, Found, ItemState, JsonObject, JsonValue, Listing, MarfaError};

#[derive(Debug, Clone, uniffi::Record)]
pub struct ViewRow {
    pub id: String,
    pub version: i64,
    pub state: ItemState,
    pub settings: JsonObject,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct Views {
    pub views: Vec<ViewRow>,
    pub completeness: Completeness,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct ViewGroup {
    pub key: JsonValue,
    pub count: u64,
    pub sum: Option<f64>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct ViewGroups {
    pub groups: Vec<ViewGroup>,
    pub completeness: Completeness,
}

fn row(value: marfa_core::ViewRow) -> ViewRow {
    ViewRow {
        id: value.id,
        version: value.version,
        state: value.state.into(),
        settings: value.settings.into(),
    }
}

#[uniffi::export]
impl Core {
    pub fn list_views(&self) -> Result<Views, MarfaError> {
        let rows = self.inner.list_views()?;
        Ok(Views {
            views: rows.rows.into_iter().map(row).collect(),
            completeness: rows.completeness.into(),
        })
    }

    pub fn view(&self, id: String) -> Result<Option<ViewRow>, MarfaError> {
        Ok(self.inner.view(&id)?.map(row))
    }

    pub fn list_in_view(
        &self,
        id: String,
        layout: Option<String>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<Listing, MarfaError> {
        Ok(crate::listing(self.inner.list_in_view_kept(
            &id,
            layout.as_deref(),
            limit,
            offset,
        )?))
    }

    pub fn search_in_view(
        &self,
        query: String,
        id: String,
        limit: u32,
    ) -> Result<Found, MarfaError> {
        Ok(crate::found(self.inner.search_in_view_kept(
            &query,
            &id,
            limit as usize,
        )?))
    }

    pub fn view_groups(
        &self,
        id: String,
        layout: String,
        time_zone: Option<String>,
    ) -> Result<ViewGroups, MarfaError> {
        let rows = self.inner.view_groups(&id, &layout, time_zone.as_deref())?;
        Ok(ViewGroups {
            groups: rows
                .rows
                .into_iter()
                .map(|group| ViewGroup {
                    key: group.key.into(),
                    count: group.count,
                    sum: group.sum,
                })
                .collect(),
            completeness: rows.completeness.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn views_cross_the_swift_boundary_with_json_settings_and_scalar_group_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.sqlite").display().to_string();
        let core = Core::open(path.clone(), None, None, None).unwrap();
        let db = rusqlite::Connection::open(path).unwrap();
        for (key, value) in [
            ("event_cursor", "10"),
            ("instance_id", "test-instance"),
            ("reach", &"a".repeat(64)),
            ("slice_types", r#"["core.note","system.view"]"#),
            ("slice_tier", "all"),
        ] {
            db.execute("INSERT OR REPLACE INTO meta VALUES (?1,?2)", [key, value])
                .unwrap();
        }
        let settings = json!({"title":"Notes","query":{"types":["core.note"]},"layouts":[{
            "id":"chart","kind":"chart","sort":[{"by":"properties.amount","direction":"asc"}],
            "group":{"by":"tags"},"y":{"sum":"properties.amount"}
        }]});
        for (id, kind, properties) in [
            ("view", "system.view", settings.clone()),
            ("a", "core.note", json!({"title":"Note a","amount":4})),
            ("b", "core.note", json!({"title":"Note b","amount":2})),
        ] {
            db.execute("INSERT INTO items (id,type,state,tier,version,schema_version,source,occurred_at,created_at,updated_at,properties) VALUES (?1,?2,'active','library',1,1,'test',?3,?3,?3,?4)", rusqlite::params![id,kind,"2026-01-01T00:00:00Z",properties.to_string()]).unwrap();
        }
        db.execute_batch("INSERT INTO tags VALUES ('a','work'); INSERT INTO items_fts(rowid,title) SELECT seq,json_extract(properties,'$.title') FROM items WHERE type='core.note';").unwrap();
        let views = core.list_views().unwrap();
        assert_eq!(views.completeness, Completeness::Complete);
        assert_eq!(views.views.len(), 1);
        assert_eq!(
            serde_json::Value::Object(
                core.view("view".into())
                    .unwrap()
                    .unwrap()
                    .settings
                    .into_map()
                    .unwrap()
            ),
            settings
        );
        assert!(core.view("absent".into()).unwrap().is_none());
        let listed = core
            .list_in_view("view".into(), Some("chart".into()), Some(1), Some(1))
            .unwrap();
        assert_eq!(listed.items[0].id, "a");
        let groups = core
            .view_groups("view".into(), "chart".into(), Some("Europe/London".into()))
            .unwrap();
        assert_eq!(groups.groups[0].key, JsonValue::String("work".into()));
        assert_eq!(
            (groups.groups[0].count, groups.groups[0].sum),
            (1, Some(4.0))
        );
        assert_eq!(groups.groups[1].key, JsonValue::Null);
        assert_eq!(
            core.search_in_view("Note".into(), "view".into(), 5)
                .unwrap()
                .hits
                .len(),
            2
        );
        db.execute("UPDATE items SET properties=?1 WHERE id='view'",[json!({"title":"Refused","query":{"types":["core.file"]},"layouts":settings["layouts"]}).to_string()]).unwrap();
        assert!(matches!(
            core.list_in_view("view".into(), None, None, None),
            Err(MarfaError::Invalid { .. })
        ));
    }
}
