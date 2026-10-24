use serde_json::{Map, Value};

use crate::http::{Answer, Method, Outgoing};
use crate::wire::WireItemWithMetadata;
use crate::{Core, CoreError, Result, ViewRow, catch_up, reach, store};

impl Core {
    /// Sends settings to the view door at once, never to the queue. Retrying
    /// with the same key returns the first write's answer.
    pub fn create_view(
        &self,
        settings: &Map<String, Value>,
        idempotency_key: Option<&str>,
    ) -> Result<ViewRow> {
        let answer = self.send_to_view_door(
            Method::Post,
            vec!["views".into()],
            Value::Object(settings.clone()).to_string(),
            idempotency_key,
        )?;
        self.answered_view(&answer)
    }

    /// Replaces named settings whole. The server merges settings unchanged
    /// since `version` and refuses conflicts without changing the copy.
    pub fn change_view(
        &self,
        id: &str,
        changes: &Map<String, Value>,
        version: i64,
        idempotency_key: Option<&str>,
    ) -> Result<ViewRow> {
        self.lock.refuse_unless_writer()?;
        if changes.contains_key("version") {
            return Err(CoreError::Invalid(
                "a view's version is the one the change is based on, not a setting".into(),
            ));
        }
        let mut body = changes.clone();
        body.insert("version".into(), Value::from(version));
        let answer = self.send_to_view_door(
            Method::Patch,
            vec!["views".into(), id.into()],
            Value::Object(body).to_string(),
            idempotency_key,
        )?;
        self.answered_view(&answer)
    }

    /// Purges a view at once. A fresh delete of an absent view is refused
    /// `NotFound`; replaying an accepted delete with its key succeeds.
    pub fn delete_view(&self, id: &str, idempotency_key: Option<&str>) -> Result<()> {
        self.lock.refuse_unless_writer()?;
        let generation = reach::generation(&*self.conn()?)?;
        self.send_to_view_door(
            Method::Delete,
            vec!["views".into(), id.into()],
            String::new(),
            idempotency_key,
        )?;
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        // A hydration while the request was in flight may have replaced the
        // copy; the accepted write says nothing about that replacement.
        if reach::generation(&tx)? == generation {
            store::purge_item(&tx, id)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn send_to_view_door(
        &self,
        method: Method,
        segments: Vec<String>,
        body: String,
        idempotency_key: Option<&str>,
    ) -> Result<Answer> {
        self.lock.refuse_unless_writer()?;
        let http = self.http()?;
        catch_up::refuse_another_instance(self, http)?;
        let key = idempotency_key
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let answer = catch_up::write_naming_instance(self, http, |http| {
            http.send(&Outgoing {
                method,
                segments,
                params: Vec::new(),
                body: &body,
                idempotency_key: &key,
            })
        })?;
        if !answer.is_success() {
            return Err(http.refused(
                answer.status,
                answer.contract_named,
                &answer.body,
                answer.retry_after_seconds,
            ));
        }
        Ok(answer)
    }

    fn answered_view(&self, answer: &Answer) -> Result<ViewRow> {
        let answered: WireItemWithMetadata = serde_json::from_str(&answer.body)
            .map_err(|error| crate::error::unreadable("the view door's answer", &error))?;
        self.hold_answered(&answered.item.id);
        Ok(ViewRow {
            id: answered.item.id,
            version: answered.item.version,
            state: answered.item.state.parse()?,
            settings: answered.item.properties,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::scripted::{self, Scripted, certified};
    use crate::store::testing::wire_type;
    use crate::{Core, CoreError, Server, VIEW_TYPE, reach, store};

    const VIEW: &str = "01a00000-0000-7000-8000-00000000a001";

    fn copy(server: Option<&Scripted>) -> Core {
        let core = Core::open_in_memory(server.map(|server| Server {
            url: server.url(),
            key: "k".into(),
        }))
        .unwrap();
        let conn = core.conn().unwrap();
        store::replace_types(&conn, &[wire_type(VIEW_TYPE, None, Some("title"))]).unwrap();
        for (key, value) in [
            (store::META_EVENT_CURSOR, "10"),
            (reach::FENCE, scripted::FENCE),
            (store::META_INSTANCE_ID, scripted::INSTANCE),
            (store::META_SLICE_TYPES, "[\"system.view\"]"),
            (store::META_SLICE_TIER, "all"),
            (store::META_SLICE_EDGE_TYPES, "[]"),
        ] {
            store::meta_set(&conn, key, value).unwrap();
        }
        drop(conn);
        core
    }

    fn settings() -> Value {
        json!({"title": "Notes", "query": {"types": ["core.note"]}, "sort": [{"by": "title", "direction": "asc"}]})
    }

    fn answer(version: i64, settings: Value) -> Value {
        json!({
            "item": {
                "id": VIEW, "type": VIEW_TYPE, "properties": settings, "state": "active",
                "tier": "library", "version": version, "schema_version": 0, "source": "test",
                "occurred_at": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z"
            },
            "metadata": {"item_id": VIEW, "tags": []}, "listed": true
        })
    }

    #[test]
    fn view_writes_send_settings_versions_and_keys_and_hold_only_accepted_answers() {
        let server = Scripted::start();
        server.on("/", vec![scripted::root(scripted::INSTANCE)]);
        let core = copy(Some(&server));
        let first = answer(1, settings());
        server.on("/views", vec![scripted::json(201, &first.to_string())]);
        server.on(
            &format!("/items/{VIEW}"),
            vec![certified(scripted::json(200, &first.to_string()))],
        );
        let created = core
            .create_view(settings().as_object().unwrap(), Some("create-key"))
            .unwrap();
        assert_eq!(created.id, VIEW);
        assert_eq!(core.view(VIEW).unwrap(), Some(created));
        let request = &server.seen("/views")[0];
        assert_eq!(
            serde_json::from_slice::<Value>(&request.body).unwrap(),
            settings()
        );
        assert_eq!(request.idempotency_key.as_deref(), Some("create-key"));

        let mut changed_settings = settings();
        changed_settings["title"] = json!("Changed");
        let second = answer(2, changed_settings);
        server.on(
            &format!("/views/{VIEW}"),
            vec![
                scripted::json(200, &second.to_string()),
                scripted::refusal(409, "version_conflict"),
            ],
        );
        server.on(
            &format!("/items/{VIEW}"),
            vec![certified(scripted::json(200, &second.to_string()))],
        );
        let changes = json!({"title": "Changed"});
        let changed = core
            .change_view(VIEW, changes.as_object().unwrap(), 1, Some("change-key"))
            .unwrap();
        assert_eq!(changed.version, 2);
        assert_eq!(core.view(VIEW).unwrap(), Some(changed.clone()));
        assert!(
            matches!(core.change_view(VIEW, changes.as_object().unwrap(), 1, None), Err(CoreError::Server {status: 409, code, ..}) if code == "version_conflict")
        );
        assert_eq!(core.view(VIEW).unwrap(), Some(changed));
        let request = &server.seen(&format!("/views/{VIEW}"))[0];
        assert_eq!(
            serde_json::from_slice::<Value>(&request.body).unwrap(),
            json!({"title": "Changed", "version": 1})
        );
        assert_eq!(request.idempotency_key.as_deref(), Some("change-key"));

        server.on(
            &format!("/views/{VIEW}"),
            vec![
                scripted::json(200, "{\"ok\":true}"),
                scripted::refusal(404, "item_not_found"),
            ],
        );
        core.delete_view(VIEW, Some("delete-key")).unwrap();
        assert!(core.view(VIEW).unwrap().is_none());
        assert!(
            matches!(core.delete_view(VIEW, None), Err(CoreError::NotFound {code, ..}) if code == "item_not_found")
        );
        let requests = server.seen(&format!("/views/{VIEW}"));
        assert_eq!(requests[2].idempotency_key.as_deref(), Some("delete-key"));
        assert!(core.queue().unwrap().is_empty());
    }

    #[test]
    fn view_writes_without_a_server_fail_and_queue_nothing() {
        let core = copy(None);
        assert!(matches!(
            core.create_view(settings().as_object().unwrap(), None),
            Err(CoreError::NoServer)
        ));
        assert!(matches!(
            core.change_view(
                VIEW,
                json!({"title": "Changed"}).as_object().unwrap(),
                1,
                None
            ),
            Err(CoreError::NoServer)
        ));
        assert!(matches!(
            core.delete_view(VIEW, None),
            Err(CoreError::NoServer)
        ));
        assert!(core.queue().unwrap().is_empty());
    }

    #[test]
    fn a_delayed_view_readback_cannot_restore_a_view_purged_while_it_waited() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        use std::time::{Duration, Instant};

        for purged in [false, true] {
            let server = Scripted::start();
            server.on("/", vec![scripted::root(scripted::INSTANCE)]);
            let core = Arc::new(copy(Some(&server)));
            let ready = Arc::new(AtomicBool::new(false));
            let first = answer(1, settings());
            server.on("/views", vec![scripted::json(201, &first.to_string())]);
            server.on(
                &format!("/items/{VIEW}"),
                vec![scripted::Answer::WaitFor {
                    ready: ready.clone(),
                    answer: Box::new(certified(scripted::json(200, &first.to_string()))),
                }],
            );
            let writing = core.clone();
            let worker = std::thread::spawn(move || {
                writing.create_view(settings().as_object().unwrap(), None)
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while server.seen(&format!("/items/{VIEW}")).is_empty() {
                assert!(Instant::now() < deadline, "the readback did not start");
                std::thread::sleep(Duration::from_millis(1));
            }
            if purged {
                server.on(
                    &format!("/views/{VIEW}"),
                    vec![scripted::json(200, "{\"ok\":true}")],
                );
                core.delete_view(VIEW, None).unwrap();
            }
            ready.store(true, Ordering::SeqCst);
            worker.join().unwrap().unwrap();
            assert_eq!(core.view(VIEW).unwrap().is_none(), purged);
        }
    }
}
