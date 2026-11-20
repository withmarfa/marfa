use super::*;

fn server_row(id: &str, version: i64, title: &str) -> serde_json::Value {
    let mut item = serde_json::from_str::<serde_json::Value>(&crate::scripted::item_payload(
        "item.created",
        id,
        "core.note",
        version,
    ))
    .unwrap()["item"]
        .clone();
    item["properties"] = json!({ "title": title });
    item
}

fn read_answer(item: &serde_json::Value) -> crate::scripted::Answer {
    crate::scripted::certified(crate::scripted::json(
        200,
        &json!({ "item": item, "metadata": { "tags": [] }, "listed": true, "acknowledged": false })
            .to_string(),
    ))
}

/// A note made in the copy, read there at version 0, its create then
/// answered at `version` and the answers taken, as an app's sync takes them.
fn made_and_taken(
    server: &crate::scripted::Scripted,
    version: i64,
) -> (tempfile::TempDir, Core, String) {
    let (dir, core) = deleting(server, &[]);
    let made = core
        .create_item(&crate::model::Draft {
            r#type: "core.note".into(),
            properties: json!({ "title": "made here" }).as_object().unwrap().clone(),
            ..Default::default()
        })
        .unwrap();
    let id = made.item_id.clone().unwrap();
    assert_eq!(core.get(&id).unwrap().unwrap().version, 0);
    let item = server_row(&id, version, "made here");
    server.on(
        "/items",
        vec![crate::scripted::json(
            200,
            &json!({ "item": item, "acknowledged": false }).to_string(),
        )],
    );
    server.on(&format!("/items/{id}"), vec![read_answer(&item)]);
    core.drain().unwrap();
    assert_eq!(core.get(&id).unwrap().unwrap().version, version);
    core.take_answered().unwrap();
    assert!(
        core.queue().unwrap().is_empty(),
        "the create's answer is still in the queue, so nothing shows the record outlives it"
    );
    (dir, core, id)
}

fn typed(base: i64) -> crate::model::Edit {
    crate::model::Edit {
        properties: json!({ "body": "typed" }).as_object().unwrap().clone(),
        base_version: Some(base),
        ..Default::default()
    }
}

fn sent_version(core: &Core, write: &QueuedWrite) -> serde_json::Value {
    let payload: serde_json::Value =
        serde_json::from_str(&store::payload_of(&core.conn().unwrap(), &write.id).unwrap())
            .unwrap();
    payload["version"].clone()
}

#[test]
fn an_edit_read_before_its_create_was_taken_is_based_on_the_version_the_create_made() {
    for made in [1, 4] {
        let server = crate::scripted::Scripted::start();
        let (_dir, core, id) = made_and_taken(&server, made);
        // The witness: an edit that does not say it was read is refused.
        assert!(matches!(
            core.update_item(&id, &typed(0)),
            Err(CoreError::Invalid(_))
        ));
        let queued = core
            .update_item_as_read(&id, &typed(0))
            .expect("an edit read from the new item before its create was taken was refused");
        assert_eq!(queued.base_version, Some(made));
        assert_eq!(sent_version(&core, &queued), json!(made));
        assert!(
            store::read_of(&core.conn().unwrap(), &queued.id)
                .unwrap()
                .is_some(),
            "an edit on the version the copy holds records what it read, as any edit"
        );
        let held = core.get(&id).unwrap().unwrap();
        assert_eq!(held.version, made);
        assert_eq!(held.properties["body"], json!("typed"));
    }
}

#[test]
fn an_edit_read_before_its_create_was_taken_meets_a_later_edit_from_elsewhere_as_read() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core, id) = made_and_taken(&server, 1);
    let theirs = server_row(&id, 2, "retitled elsewhere");
    {
        let conn = core.conn().unwrap();
        let item: crate::wire::WireItem = serde_json::from_value(theirs.clone()).unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        assert!(store::take_server_item(&conn, &item, None, &catalog).unwrap());
    }
    let queued = core.update_item_as_read(&id, &typed(0)).unwrap();
    assert_eq!(queued.base_version, Some(1));
    assert_eq!(
        store::read_of(&core.conn().unwrap(), &queued.id).unwrap(),
        None,
        "an edit read at an earlier version than the copy's records no read"
    );
    let held = core.get(&id).unwrap().unwrap();
    assert_eq!(
        held.version, 2,
        "the copy moved its version before an answer"
    );
    assert_eq!(held.properties["title"], json!("retitled elsewhere"));

    let mut merged = theirs.clone();
    merged["version"] = json!(3);
    merged["properties"]["body"] = json!("typed");
    server.on(
        &format!("/items/{id}"),
        vec![
            crate::scripted::json(
                200,
                &json!({ "item": merged, "acknowledged": false }).to_string(),
            ),
            read_answer(&merged),
        ],
    );
    core.drain().unwrap();
    let sent: Vec<serde_json::Value> = server
        .seen(&format!("/items/{id}"))
        .iter()
        .filter(|seen| !seen.body.is_empty())
        .map(|seen| serde_json::from_slice(&seen.body).unwrap())
        .collect();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(
        sent[0]["version"],
        json!(1),
        "the edit went out on a version other than the one its create made"
    );
}

#[test]
fn an_edit_at_version_0_of_an_item_not_made_here_is_refused() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    {
        let conn = core.conn().unwrap();
        let item: crate::wire::WireItem =
            serde_json::from_value(server_row("theirs", 1, "made elsewhere")).unwrap();
        let catalog = crate::catalog::load(&conn).unwrap();
        assert!(store::take_server_item(&conn, &item, None, &catalog).unwrap());
    }
    assert!(matches!(
        core.update_item_as_read("theirs", &typed(0)),
        Err(CoreError::Invalid(message)) if message.contains("based on version 0")
    ));
    assert!(core.queue().unwrap().is_empty());
    // The witness: the same edit on the version the server gave is taken.
    assert!(core.update_item_as_read("theirs", &typed(1)).is_ok());
}

#[test]
fn an_edit_queued_while_its_create_waits_goes_on_the_create_s_answer() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core) = deleting(&server, &[]);
    let made = core
        .create_item(&crate::model::Draft {
            r#type: "core.note".into(),
            properties: json!({ "title": "made here" }).as_object().unwrap().clone(),
            ..Default::default()
        })
        .unwrap();
    let id = made.item_id.clone().unwrap();
    let queued = core.update_item_as_read(&id, &typed(0)).unwrap();
    assert_eq!(queued.base_version, Some(0));
    assert_eq!(queued.depends_on, vec![made.id.clone()]);

    let item = server_row(&id, 1, "made here");
    let mut edited = item.clone();
    edited["version"] = json!(2);
    edited["properties"]["body"] = json!("typed");
    server.on(
        "/items",
        vec![crate::scripted::json(
            200,
            &json!({ "item": item, "acknowledged": false }).to_string(),
        )],
    );
    server.on(
        &format!("/items/{id}"),
        vec![
            read_answer(&item),
            crate::scripted::json(
                200,
                &json!({ "item": edited, "acknowledged": false }).to_string(),
            ),
            read_answer(&edited),
        ],
    );
    core.drain().unwrap();
    let sent: Vec<serde_json::Value> = server
        .seen(&format!("/items/{id}"))
        .iter()
        .filter(|seen| !seen.body.is_empty())
        .map(|seen| serde_json::from_slice(&seen.body).unwrap())
        .collect();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["version"], json!(1));
}

#[test]
fn the_record_of_a_create_goes_with_its_row() {
    let server = crate::scripted::Scripted::start();
    let (_dir, core, id) = made_and_taken(&server, 1);
    let conn = core.conn().unwrap();
    assert_eq!(store::made_version(&conn, &id).unwrap(), Some(1));
    store::evict_item(&conn, &id, &[]).unwrap();
    assert_eq!(store::made_version(&conn, &id).unwrap(), None);
}
