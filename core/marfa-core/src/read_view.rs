use rusqlite::Connection;

use crate::{Core, Result, error::CoreError, http::Http, store};

pub(crate) const FENCE: &str = "read_view";
const GENERATION: &str = "copy_generation";
const PINS: &str = "pin_revision";

pub(crate) fn valid_fence(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn cursor(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse::<u64>().ok().filter(|n| *n <= i64::MAX as u64)
}

pub(crate) fn invalid() -> CoreError {
    CoreError::CopyExpired {
        reason: "read_view_invalid".into(),
    }
}

pub(crate) fn event_payload(
    name: Option<&str>,
    id: Option<&str>,
    data: &str,
) -> Result<crate::wire::EventPayload> {
    let payload: crate::wire::EventPayload = serde_json::from_str(data).map_err(|_| invalid())?;
    if matches!(name, Some("stream_cursor" | "stream_live"))
        || matches!(payload.event_type.as_str(), "stream_cursor" | "stream_live")
    {
        let fields: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(data).map_err(|_| invalid())?;
        if id.is_some()
            || name != Some(payload.event_type.as_str())
            || fields.len() != 4
            || !["event_type", "cursor", "instance_id", "read_view"]
                .iter()
                .all(|key| fields.contains_key(*key))
        {
            return Err(invalid());
        }
    }
    Ok(payload)
}

pub(crate) fn generation(conn: &Connection) -> Result<u64> {
    revision(conn, GENERATION)
}

fn revision(conn: &Connection, key: &str) -> Result<u64> {
    store::meta_get(conn, key)?.map_or(Ok(0), |v| {
        v.parse()
            .map_err(|_| CoreError::Store(format!("invalid {key}")))
    })
}

pub(crate) fn advance(conn: &Connection, key: &str) -> Result<()> {
    let next = revision(conn, key)?
        .checked_add(1)
        .ok_or_else(|| CoreError::Store(format!("exhausted {key}")))?;
    store::meta_set(conn, key, &next.to_string())
}

pub(crate) fn advance_generation(conn: &Connection) -> Result<()> {
    advance(conn, GENERATION)
}
pub(crate) fn pins_changed(conn: &Connection) -> Result<()> {
    advance(conn, PINS)
}

#[derive(Debug, Clone)]
pub(crate) struct Context {
    pub(crate) generation: u64,
    pins: u64,
    pub(crate) fence: String,
    pub(crate) instance: String,
    declaration: [Option<String>; 3],
    building: bool,
}

impl Context {
    pub(crate) fn capture(conn: &Connection) -> Result<Self> {
        store::refuse_unless_hydrated(conn)?;
        Self::capture_build(conn)
    }

    pub(crate) fn capture_build(conn: &Connection) -> Result<Self> {
        let fence = store::meta_get(conn, FENCE)?
            .filter(|s| valid_fence(s))
            .ok_or_else(invalid)?;
        let instance = store::meta_get(conn, store::META_INSTANCE_ID)?
            .filter(|s| !s.is_empty())
            .ok_or_else(invalid)?;
        Ok(Self {
            generation: revision(conn, GENERATION)?,
            pins: revision(conn, PINS)?,
            fence,
            instance,
            declaration: [
                store::meta_get(conn, store::META_SLICE_TYPES)?,
                store::meta_get(conn, store::META_SLICE_TIER)?,
                store::meta_get(conn, store::META_SLICE_EDGE_TYPES)?,
            ],
            building: !store::hydration_complete(conn)?,
        })
    }

    pub(crate) fn http(&self, http: &Http) -> Http {
        http.for_view(&self.fence)
    }

    pub(crate) fn same_copy(&self, conn: &Connection) -> Result<()> {
        let now = Self::capture_build(conn).map_err(|_| Self::changed())?;
        if self.generation != now.generation
            || self.fence != now.fence
            || self.instance != now.instance
            || self.declaration != now.declaration
            || self.building != now.building
        {
            return Err(Self::changed());
        }
        Ok(())
    }

    pub(crate) fn check(&self, conn: &Connection) -> Result<()> {
        self.same_copy(conn)?;
        if self.pins != revision(conn, PINS)? {
            return Err(Self::changed());
        }
        Ok(())
    }

    pub(crate) fn change_pins<T>(
        &mut self,
        conn: &Connection,
        change: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.check(conn)?;
        let value = change()?;
        self.same_copy(conn)?;
        self.pins = revision(conn, PINS)?;
        Ok(value)
    }

    pub(crate) fn changed() -> CoreError {
        CoreError::StreamIncomplete {
            reason: "local_copy_changed".into(),
        }
    }

    pub(crate) fn expire(&self, core: &Core, reason: &str) -> Result<CoreError> {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        if self.generation == revision(&tx, GENERATION)? {
            expire(&tx)?;
        }
        tx.commit()?;
        Ok(CoreError::CopyExpired {
            reason: reason.into(),
        })
    }

    pub(crate) fn failed(&self, core: &Core, error: CoreError) -> Result<CoreError> {
        if let CoreError::CopyExpired { reason } = &error {
            self.expire(core, reason)
        } else {
            Ok(error)
        }
    }

    pub(crate) fn marker(&self, payload: &crate::wire::EventPayload, kind: &str) -> Result<u64> {
        if payload.event_type != kind
            || payload.instance_id.as_deref() != Some(&self.instance)
            || payload.read_view.as_deref() != Some(&self.fence)
        {
            return Err(invalid());
        }
        payload
            .cursor
            .as_deref()
            .and_then(cursor)
            .ok_or_else(invalid)
    }
}

pub(crate) fn expire(conn: &Connection) -> Result<()> {
    advance_generation(conn)?;
    store::meta_delete(conn, store::META_EVENT_CURSOR)?;
    store::meta_delete(conn, store::META_HYDRATE_STATE)?;
    store::meta_delete(conn, FENCE)
}

pub(crate) fn listed(conn: &Connection, id: &str) -> Result<bool> {
    Ok(store::meta_get(conn, &format!("item_listed/{id}"))?.as_deref() == Some("true"))
}

pub(crate) fn set_listed(conn: &Connection, id: &str, listed: bool) -> Result<()> {
    store::meta_set(
        conn,
        &format!("item_listed/{id}"),
        if listed { "true" } else { "false" },
    )
}

pub(crate) fn forget_listed(conn: &Connection, id: &str) -> Result<()> {
    store::meta_delete(conn, &format!("item_listed/{id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_grammar_is_canonical_and_bounded() {
        assert!(valid_fence(&"a".repeat(64)));
        for bad in ["A".repeat(64), "g".repeat(64), "0".repeat(63)] {
            assert!(!valid_fence(&bad));
        }
        assert_eq!(cursor("0"), Some(0));
        assert_eq!(cursor("9223372036854775807"), Some(i64::MAX as u64));
        for bad in ["", "01", "+1", "-1", "9223372036854775808"] {
            assert_eq!(cursor(bad), None);
        }
    }
    fn core(server: &crate::scripted::Scripted) -> (tempfile::TempDir, Core) {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::open(
            dir.path().join("copy.sqlite"),
            Some(crate::Server {
                url: server.url(),
                key: "k".into(),
            }),
        )
        .unwrap();
        (dir, core)
    }

    fn ready(core: &Core) {
        let conn = core.conn().unwrap();
        store::meta_set(&conn, FENCE, crate::scripted::FENCE).unwrap();
        store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
        store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
        store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
        store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
    }

    fn catalog(server: &crate::scripted::Scripted) {
        use crate::scripted::*;
        server.on("/types", vec![certified(types(&[("core.note", None)]))]);
        server.on("/edge-types", vec![certified(edge_types(&[]))]);
    }

    #[test]
    fn read_view_malformed_copy_markers_must_expire() {
        use crate::scripted::*;
        let mut accepted = Vec::new();
        for (label, frames) in [
            (
                "missing SSE names",
                vec![
                    copy_marker("stream_cursor", "10").replace("event: stream_cursor\n", ""),
                    copy_marker("stream_live", "10").replace("event: stream_live\n", ""),
                ],
            ),
            (
                "live below greatest ID",
                vec![
                    copy_marker("stream_cursor", "10"),
                    event("20", "unknown", r#"{"event_type":"unknown"}"#),
                    event("15", "unknown", r#"{"event_type":"unknown"}"#),
                    copy_marker("stream_live", "15"),
                ],
            ),
            (
                "extra marker fields",
                vec![
                    copy_marker("stream_cursor", "10")
                        .replace("\"event_type\":", "\"extra\":true,\"event_type\":"),
                    copy_marker("stream_live", "10"),
                ],
            ),
        ] {
            let server = Scripted::start();
            let (_dir, core) = core(&server);
            ready(&core);
            catalog(&server);
            server.on("/events", vec![stream(frames, Then::End)]);
            let result = core.catch_up();
            println!("{label}: {result:?}");
            if !matches!(result, Err(CoreError::CopyExpired { .. })) {
                accepted.push(label);
            }
        }
        assert!(accepted.is_empty(), "accepted invalid proofs: {accepted:?}");
    }

    #[test]
    fn read_view_late_instance_reply_must_not_expire_rebuilt_copy() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        server.on(
            "/",
            vec![Answer::Slow {
                after: std::time::Duration::from_millis(300),
                answer: Box::new(root(INSTANCE)),
            }],
        );
        std::thread::scope(|scope| {
            let late = scope
                .spawn(|| crate::catch_up::refuse_another_instance(&core, core.http().unwrap()));
            server.wait_for("/", 1, std::time::Duration::from_secs(2));
            {
                let conn = core.conn().unwrap();
                advance_generation(&conn).unwrap();
                store::meta_set(&conn, store::META_INSTANCE_ID, "new-instance").unwrap();
            }
            println!("late root result: {:?}", late.join().unwrap());
        });
        assert!(
            store::hydrated(&core.conn().unwrap()).unwrap(),
            "late root reply expired the replacement generation"
        );
    }

    #[test]
    fn read_view_identity_adoption_must_change_pin_revision() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        let conn = core.conn().unwrap();
        store::pin(&conn, "local").unwrap();
        let before = Context::capture(&conn).unwrap();
        store::adopt_answered_id(&conn, "local", "answered").unwrap();
        assert!(!store::pinned(&conn, "local").unwrap());
        assert!(store::pinned(&conn, "answered").unwrap());
        assert!(
            before.check(&conn).is_err(),
            "pre-adoption context passed after pin identity changed"
        );
    }

    #[test]
    fn read_view_unpin_does_not_stop_held_stream() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        catalog(&server);
        {
            let conn = core.conn().unwrap();
            store::pin(&conn, "p").unwrap();
            let row = store::testing::note("x", "x", "", "2026-01-01T00:00:00Z");
            store::put_server_item(&conn, &row, Some(&[]), &Default::default()).unwrap();
            set_listed(&conn, "x", true).unwrap();
        }
        let data = |v| {
            let mut p: serde_json::Value =
                serde_json::from_str(&item_payload("item.updated", "x", "core.note", v)).unwrap();
            p["listed"] = true.into();
            p.to_string()
        };
        server.on(
            "/events",
            vec![stream(
                vec![
                    copy_marker("stream_cursor", "10"),
                    copy_marker("stream_live", "10"),
                    event("11", "item.updated", &data(2)),
                    event("12", "item.updated", &data(3)),
                ],
                Then::End,
            )],
        );
        let stop = std::sync::atomic::AtomicBool::new(false);
        let mut changed = 0;
        let result = core.follow(&stop, false, |change| {
            if change.event != "item.updated" {
                return;
            }
            changed += 1;
            if changed == 1 {
                assert!(core.unpin("p").unwrap());
            } else {
                stop.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
        println!("follow after normal unpin: {result:?}, delivered {changed}");
        assert!(result.is_ok(), "normal unpin ended follow: {result:?}");
        assert_eq!(changed, 2);
        assert_eq!(result.unwrap().applied, 2);
    }

    #[test]
    fn read_view_http_requires_proof_only_after_status_and_renewal_classification() {
        use crate::scripted::*;
        let server = Scripted::start();
        let http = Http::new(&server.url(), "k").unwrap().for_view(FENCE);
        let item = serde_json::from_str::<serde_json::Value>(&item_payload(
            "item.updated",
            "x",
            "core.note",
            1,
        ))
        .unwrap()["item"]
            .clone();
        let body = serde_json::json!({"item": item, "metadata": {"tags": []}, "listed": false})
            .to_string();
        server.on("/items/x", vec![certified(json(200, &body))]);
        assert_eq!(http.item("x").unwrap().unwrap().listed, Some(false));
        assert_eq!(server.seen("/items/x")[0].read_view.as_deref(), Some(FENCE));
        for answer in [
            json(200, &body),
            certified(json(200, &body.replace(",\"listed\":false", ""))),
            refusal(404, "item_not_found"),
        ] {
            server.on("/items/x", vec![answer]);
            assert!(matches!(http.item("x"), Err(CoreError::CopyExpired { .. })));
        }
        server.on("/items/x", vec![certified(refusal(404, "item_not_found"))]);
        assert!(http.item("x").unwrap().is_none());
        for answer in [
            refusal(429, "rate_limited"),
            refusal(503, "unavailable"),
            unnamed(401, "gateway"),
            unnamed(404, "gateway"),
        ] {
            server.on("/items/x", vec![answer]);
            assert!(http.item("x").unwrap_err().is_environmental());
        }
        server.on("/items/x", vec![refusal(409, "read_view_changed")]);
        assert_eq!(
            http.item("x").unwrap_err(),
            CoreError::CopyExpired {
                reason: "read_view_changed".into()
            }
        );
        server.on("/items/x", vec![refusal(401, "unauthorized")]);
        assert_eq!(
            http.item("x").unwrap_err(),
            CoreError::CopyExpired {
                reason: "credential_ended".into()
            }
        );
    }

    #[test]
    fn read_view_catch_up_requires_real_live_with_complete_matching_tuple() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        catalog(&server);
        server.on(
            "/events",
            vec![stream(
                vec![
                    copy_marker("stream_cursor", "10"),
                    copy_marker("stream_live", "10"),
                ],
                Then::End,
            )],
        );
        assert!(core.catch_up().unwrap().reached_head);
        let request = &server.seen("/events")[0];
        assert_eq!(request.query, "edges=all&copy=1");
        assert_eq!(request.last_event_id.as_deref(), Some("10"));
        assert_eq!(request.read_view.as_deref(), Some(FENCE));
        server.on(
            "/events",
            vec![stream(vec![copy_marker("stream_cursor", "10")], Then::End)],
        );
        assert!(matches!(
            core.catch_up(),
            Err(CoreError::StreamIncomplete { .. })
        ));
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
        server.on(
            "/events",
            vec![stream(
                vec![copy_marker("stream_cursor", "10"), stream_live(Some("10"))],
                Then::End,
            )],
        );
        assert!(matches!(
            core.catch_up(),
            Err(CoreError::CopyExpired { .. })
        ));
        assert!(!store::hydrated(&core.conn().unwrap()).unwrap());
        assert_eq!(
            store::meta_get(&core.conn().unwrap(), super::FENCE).unwrap(),
            None
        );
    }

    #[test]
    fn read_view_malformed_edge_type_expires_while_ordinary_decode_stays_typed() {
        use crate::scripted::*;
        let server = Scripted::start();
        server.on(
            "/edge-types",
            vec![certified(json(200, r#"{"data":[{}],"next_cursor":null}"#))],
        );
        let http = Http::new(&server.url(), "k").unwrap();
        assert!(matches!(http.edge_types(), Err(CoreError::Decoding(_))));
        assert!(matches!(
            http.for_view(FENCE).edge_types(),
            Err(CoreError::CopyExpired { .. })
        ));
    }

    #[test]
    fn read_view_local_pin_change_keeps_guard_but_external_change_refuses_it() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        let conn = core.conn().unwrap();
        let mut context = Context::capture(&conn).unwrap();
        context
            .change_pins(&conn, || store::pin(&conn, "bound"))
            .unwrap();
        context.check(&conn).unwrap();
        store::unpin(&conn, "bound").unwrap();
        let mut changed = false;
        assert!(matches!(
            context.change_pins(&conn, || {
                changed = true;
                store::pin(&conn, "bound")
            }),
            Err(CoreError::StreamIncomplete { .. })
        ));
        assert!(!changed);
        assert!(!store::pinned(&conn, "bound").unwrap());
    }

    #[test]
    fn read_view_pin_aba_and_old_generation_reply_cannot_change_rebuilt_copy() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        let old = Context::capture(&core.conn().unwrap()).unwrap();
        {
            let conn = core.conn().unwrap();
            store::pin(&conn, "x").unwrap();
            store::unpin(&conn, "x").unwrap();
            assert!(old.check(&conn).is_err());
            assert!(old.same_copy(&conn).is_ok());
            advance_generation(&conn).unwrap();
        }
        old.expire(&core, "read_view_changed").unwrap();
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
        assert!(old.same_copy(&core.conn().unwrap()).is_err());
    }

    #[test]
    fn read_view_hydration_keeps_build_unreadable_until_replay_live() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        catalog(&server);
        server.on(
            "/keys/current",
            vec![certified(json(
                200,
                r#"{"type_permissions":{"core.note":"read"}}"#,
            ))],
        );
        server.on(
            "/items",
            vec![certified(json(200, r#"{"data":[],"next_cursor":null}"#))],
        );
        server.on(
            "/events",
            vec![
                stream(vec![copy_marker("stream_cursor", "10")], Then::End),
                stream(vec![copy_marker("stream_cursor", "10")], Then::End),
            ],
        );
        assert!(matches!(
            core.hydrate(&["core.note".into()], crate::Tier::Library),
            Err(CoreError::StreamIncomplete { .. })
        ));
        assert!(!store::hydrated(&core.conn().unwrap()).unwrap());
        server.on(
            "/events",
            vec![
                stream(vec![copy_marker("stream_cursor", "10")], Then::End),
                stream(
                    vec![
                        copy_marker("stream_cursor", "10"),
                        copy_marker("stream_live", "11"),
                    ],
                    Then::End,
                ),
            ],
        );
        let report = core
            .hydrate(&["core.note".into()], crate::Tier::Library)
            .unwrap();
        assert_eq!(report.cursor, "11");
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
        let requests = server.seen("/events");
        assert_eq!(requests[0].read_view, None);
        assert_eq!(requests[0].last_event_id, None);
        assert_eq!(requests[1].read_view.as_deref(), Some(FENCE));
        assert_eq!(requests[1].last_event_id.as_deref(), Some("10"));
    }

    #[test]
    fn a_hydration_stopped_between_pages_leaves_an_unfinished_copy_that_refuses_reads() {
        use crate::scripted::*;
        use std::sync::atomic::{AtomicBool, Ordering};
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        catalog(&server);
        server.on(
            "/keys/current",
            vec![certified(json(
                200,
                r#"{"type_permissions":{"core.note":"read"}}"#,
            ))],
        );
        server.on(
            "/items",
            vec![
                Answer::Slow {
                    after: std::time::Duration::from_millis(400),
                    answer: Box::new(certified(json(200, r#"{"data":[],"next_cursor":"c1"}"#))),
                },
                certified(json(200, r#"{"data":[],"next_cursor":null}"#)),
            ],
        );
        server.on(
            "/events",
            vec![
                stream(vec![copy_marker("stream_cursor", "10")], Then::End),
                stream(
                    vec![
                        copy_marker("stream_cursor", "10"),
                        copy_marker("stream_live", "11"),
                    ],
                    Then::End,
                ),
            ],
        );
        let stop = AtomicBool::new(false);
        let types = ["core.note".to_string()];
        std::thread::scope(|scope| {
            let hydrating =
                scope.spawn(|| core.hydrate_until(&types, crate::Tier::Library, &[], &stop));
            server.wait_for("/items", 1, std::time::Duration::from_secs(5));
            stop.store(true, Ordering::Relaxed);
            assert!(matches!(
                hydrating.join().unwrap(),
                Err(CoreError::Canceled)
            ));
        });
        assert_eq!(
            server.seen("/items").len(),
            1,
            "a page was asked for after the stop"
        );
        assert!(!store::hydrated(&core.conn().unwrap()).unwrap());
        assert!(matches!(core.get("x"), Err(CoreError::HydrationIncomplete)));
        // The witness: the same copy hydrates whole when it is not stopped.
        let report = core
            .hydrate_until(&types, crate::Tier::Library, &[], &AtomicBool::new(false))
            .unwrap();
        assert_eq!(report.pages, 1);
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
    }

    #[test]
    fn a_hydration_stopped_before_it_starts_changes_nothing() {
        use crate::scripted::*;
        use std::sync::atomic::AtomicBool;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        core.declare_types(&[serde_json::json!({ "id": "app.note.entry", "fields": {} })])
            .unwrap();
        let saved = core
            .create_item(&crate::Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "t", "body": "b" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        let types = ["core.note".to_string()];
        assert_eq!(
            core.hydrate_until(&types, crate::Tier::Library, &[], &AtomicBool::new(true))
                .unwrap_err(),
            CoreError::Canceled
        );
        assert_eq!(server.asked(), 0, "a stopped hydration went to the server");
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Never);
        // The copy still saves and still reads what it saved.
        assert!(
            core.get(saved.item_id.as_deref().unwrap())
                .unwrap()
                .is_some()
        );
        assert!(
            core.create_item(&crate::Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "u", "body": "v" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn a_server_failing_a_registration_fails_the_hydration_rather_than_refusing_the_type() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        catalog(&server);
        server.on(
            "/keys/current",
            vec![certified(json(
                200,
                r#"{"type_permissions":{"core.note":"read"}}"#,
            ))],
        );
        server.on(
            "/events",
            vec![stream(vec![copy_marker("stream_cursor", "10")], Then::End)],
        );
        core.declare_types(&[serde_json::json!({ "id": "app.note.entry", "fields": {} })])
            .unwrap();
        server.on("/types", vec![refusal(503, "unavailable")]);
        let failed = core
            .hydrate(&["core.note".into()], crate::Tier::Library)
            .unwrap_err();
        assert!(failed.is_environmental(), "{failed:?}");
        assert!(!store::hydrated(&core.conn().unwrap()).unwrap());
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Never);
    }

    #[test]
    fn a_catch_up_waiting_on_a_stream_ends_soon_after_its_stop() {
        use crate::scripted::*;
        use std::sync::atomic::{AtomicBool, Ordering};
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        catalog(&server);
        server.on(
            "/events",
            vec![stream(
                vec![connected()],
                Then::Hold {
                    keepalive: None,
                    lasting: None,
                },
            )],
        );
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let catching = scope.spawn(|| core.catch_up_until(&stop));
            server.wait_for("/events", 1, std::time::Duration::from_secs(5));
            std::thread::sleep(std::time::Duration::from_millis(300));
            let raised = std::time::Instant::now();
            stop.store(true, Ordering::Relaxed);
            let ended = catching.join().unwrap();
            assert!(matches!(ended, Err(CoreError::Canceled)), "{ended:?}");
            assert!(raised.elapsed() < std::time::Duration::from_secs(3));
        });
        // The cursor is where it was, and the copy is still whole.
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
        assert_eq!(
            store::meta_get(&core.conn().unwrap(), store::META_EVENT_CURSOR)
                .unwrap()
                .as_deref(),
            Some("10")
        );
    }

    #[test]
    fn read_view_reader_refuses_missing_proof_without_mutating_writer_generation() {
        let server = crate::scripted::Scripted::start();
        let (dir, core) = core(&server);
        ready(&core);
        let reader = Core::open_reader(dir.path().join("copy.sqlite")).unwrap();
        assert_eq!(
            reader.status().unwrap().hydration,
            crate::Hydration::Complete
        );
        store::meta_delete(&core.conn().unwrap(), FENCE).unwrap();
        assert_eq!(
            reader.status().unwrap().hydration,
            crate::Hydration::Expired
        );
        assert!(matches!(
            reader.get("x"),
            Err(CoreError::HydrationIncomplete)
        ));
        assert_eq!(revision(&reader.conn().unwrap(), GENERATION).unwrap(), 0);
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
        assert_eq!(revision(&reader.conn().unwrap(), GENERATION).unwrap(), 1);
    }

    #[test]
    fn read_view_missing_instance_is_not_a_complete_offline_copy() {
        let server = crate::scripted::Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
        store::meta_delete(&core.conn().unwrap(), store::META_INSTANCE_ID).unwrap();
        assert_eq!(core.status().unwrap().hydration, crate::Hydration::Expired);
        assert!(matches!(core.get("x"), Err(CoreError::HydrationIncomplete)));
    }

    #[test]
    fn read_view_source_excluded_pin_leaves_on_unpin_and_late_reply_cannot_restore_it() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        let core = std::sync::Arc::new(core);
        ready(&core);
        let item = serde_json::from_str::<serde_json::Value>(&item_payload(
            "item.updated",
            "x",
            "core.note",
            1,
        ))
        .unwrap()["item"]
            .clone();
        let body =
            serde_json::json!({"item":item,"metadata":{"tags":[]},"listed":false}).to_string();
        server.on("/items/x", vec![certified(json(200, &body))]);
        assert!(!core.pin("x").unwrap());
        assert!(core.get("x").unwrap().is_some());
        assert!(core.unpin("x").unwrap());
        assert!(core.get("x").unwrap().is_none());
        server.on(
            "/items/x",
            vec![Answer::Slow {
                after: std::time::Duration::from_millis(150),
                answer: Box::new(certified(json(200, &body))),
            }],
        );
        let pinning = std::sync::Arc::clone(&core);
        let pending = std::thread::spawn(move || pinning.pin("x"));
        server.wait_for("/items/x", 2, std::time::Duration::from_secs(2));
        assert!(core.unpin("x").unwrap());
        assert!(matches!(
            pending.join().unwrap(),
            Err(CoreError::StreamIncomplete { .. })
        ));
        assert!(core.get("x").unwrap().is_none());
        assert!(!store::pinned(&core.conn().unwrap(), "x").unwrap());
    }

    #[test]
    fn read_view_environmental_preflight_preserves_existing_certified_copy() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        server.on(
            "/events",
            vec![stream(vec![copy_marker("stream_cursor", "10")], Then::End)],
        );
        server.on("/types", vec![refusal(503, "unavailable")]);
        assert!(
            core.hydrate(&["core.note".into()], crate::Tier::Library)
                .unwrap_err()
                .is_environmental()
        );
        assert!(store::hydrated(&core.conn().unwrap()).unwrap());
        assert_eq!(revision(&core.conn().unwrap(), GENERATION).unwrap(), 0);
    }
    #[test]
    fn read_view_refused_overlay_is_removed_after_a_certified_older_read() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        let mut baseline = store::testing::note("x", "newer", "", "2026-03-02T00:00:00Z");
        baseline.version = 1;
        {
            let conn = core.conn().unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
            store::put_server_item(&conn, &baseline, Some(&[]), &Default::default()).unwrap();
            set_listed(&conn, "x", true).unwrap();
        }
        core.update_item(
            "x",
            &crate::Edit {
                properties: serde_json::json!({"title":"refused"})
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            core.get("x").unwrap().unwrap().properties["title"],
            "refused"
        );
        let mut read: serde_json::Value =
            serde_json::from_str(&item_payload("item.updated", "x", "core.note", 1)).unwrap();
        read["item"]["updated_at"] = "2026-03-01T00:00:00Z".into();
        read["item"]["properties"]["title"] = "stale".into();
        read["listed"] = true.into();
        let read = read.to_string();
        server.on(
            "/items/x",
            vec![refusal(403, "type_forbidden"), certified(json(200, &read))],
        );
        let report = core.drain().unwrap();
        assert_eq!(report.verdicts[0].verdict, Some(crate::Verdict::Refused));
        assert_eq!(core.get("x").unwrap().unwrap().properties["title"], "newer");
    }

    #[test]
    fn read_view_accepted_retry_removes_overlay_over_a_newer_event_baseline() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        let mut baseline = store::testing::note("x", "before", "", "2026-01-01T00:00:00Z");
        baseline.version = 1;
        {
            let conn = core.conn().unwrap();
            store::replace_types(
                &conn,
                &[store::testing::wire_type("core.note", None, Some("title"))],
            )
            .unwrap();
            store::put_server_item(&conn, &baseline, Some(&[]), &Default::default()).unwrap();
            set_listed(&conn, "x", true).unwrap();
        }
        core.update_item(
            "x",
            &crate::Edit {
                properties: serde_json::json!({"title":"mine"})
                    .as_object()
                    .unwrap()
                    .clone(),
                base_version: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        server.on("/items/x", vec![refusal(503, "unavailable")]);
        assert!(core.drain().unwrap().unavailable.is_some());
        baseline.version = 2;
        baseline.updated_at = "2026-03-02T00:00:00Z".into();
        baseline.properties.insert("title".into(), "newer".into());
        {
            let conn = core.conn().unwrap();
            store::put_server_item(&conn, &baseline, Some(&[]), &Default::default()).unwrap();
            store::lay_waiting_writes_over(&conn, "x", &|_| Default::default()).unwrap();
        }
        assert_eq!(core.get("x").unwrap().unwrap().properties["title"], "mine");
        let mut receipt: serde_json::Value =
            serde_json::from_str(&item_payload("item.updated", "x", "core.note", 2)).unwrap();
        receipt["item"]["updated_at"] = "2026-03-01T00:00:00Z".into();
        receipt["item"]["properties"]["title"] = "mine".into();
        let mut fresh = receipt.clone();
        fresh["listed"] = true.into();
        server.on(
            "/items/x",
            vec![
                json(200, &receipt.to_string()),
                certified(json(200, &fresh.to_string())),
            ],
        );
        let report = core.drain().unwrap();
        assert_eq!(report.verdicts[0].verdict, Some(crate::Verdict::Accepted));
        assert_eq!(core.get("x").unwrap().unwrap().properties["title"], "newer");
    }

    #[test]
    fn read_view_own_create_outside_listing_is_held_only_while_local_work_waits() {
        use crate::scripted::*;
        let server = Scripted::start();
        let (_dir, core) = core(&server);
        ready(&core);
        store::replace_types(
            &core.conn().unwrap(),
            &[store::testing::wire_type("core.note", None, Some("title"))],
        )
        .unwrap();
        let created = core
            .create_item(&crate::Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({"title":"mine"})
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
        let id = created.item_id.as_deref().unwrap();
        let edit = core
            .update_item(
                id,
                &crate::Edit {
                    properties: serde_json::json!({"title":"newest"})
                        .as_object()
                        .unwrap()
                        .clone(),
                    base_version: Some(0),
                    ..Default::default()
                },
            )
            .unwrap();
        let item = serde_json::from_str::<serde_json::Value>(&item_payload(
            "item.created",
            id,
            "core.note",
            1,
        ))
        .unwrap()["item"]
            .clone();
        let receipt = serde_json::json!({"item":item}).to_string();
        let current =
            serde_json::json!({"item":item,"metadata":{"tags":[]},"listed":false}).to_string();
        server.on("/items", vec![json(201, &receipt)]);
        server.on(
            &format!("/items/{id}"),
            vec![certified(json(200, &current)), refusal(503, "unavailable")],
        );
        let first = core.drain().unwrap();
        assert!(first.unavailable.is_some());
        assert_eq!(core.get(id).unwrap().unwrap().properties["title"], "newest");
        assert_eq!(
            store::queued_write(&core.conn().unwrap(), &created.id)
                .unwrap()
                .unwrap()
                .verdict,
            Some(crate::Verdict::Accepted)
        );
        assert_eq!(
            store::queued_write(&core.conn().unwrap(), &edit.id)
                .unwrap()
                .unwrap()
                .verdict,
            None
        );
        let mut newest = item.clone();
        newest["version"] = 2.into();
        newest["properties"]["title"] = "newest".into();
        let receipt = serde_json::json!({"item":newest}).to_string();
        let current =
            serde_json::json!({"item":newest,"metadata":{"tags":[]},"listed":false}).to_string();
        server.on(
            &format!("/items/{id}"),
            vec![json(200, &receipt), certified(json(200, &current))],
        );
        let second = core.drain().unwrap();
        assert!(core.get(id).unwrap().is_none(), "{second:?}");
        assert_eq!(
            store::queued_write(&core.conn().unwrap(), &edit.id)
                .unwrap()
                .unwrap()
                .verdict,
            Some(crate::Verdict::Accepted)
        );
    }
}
