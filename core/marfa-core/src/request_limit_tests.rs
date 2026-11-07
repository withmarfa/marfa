//! What a device does with the request size a server publishes at its root.

use crate::contract::CONTRACT_VERSION;
use crate::model::{OVER_REQUEST_LIMIT, OVER_REQUEST_LIMIT_REASON, Verdict};
use crate::scripted::{self, Answer, INSTANCE, Scripted};
use crate::stop_tests::{copy, holding_a_catalog, note};
use crate::{Core, CoreError, Draft, store};

fn root_naming(limit: &str) -> Answer {
    scripted::json(
        200,
        &format!(
            r#"{{"name":"marfa","version":"dev","instance_id":"{INSTANCE}","contract":{CONTRACT_VERSION},"features":[],"max_request_bytes":{limit}}}"#
        ),
    )
}

fn answered_create(id: &str) -> Answer {
    scripted::json(
        201,
        &format!(
            r#"{{"id":"{id}","type":"core.note","properties":{{}},"version":1,"state":"active"}}"#
        ),
    )
}

fn long_note(length: usize) -> Draft {
    let mut draft = note(None);
    draft
        .properties
        .insert("body".into(), "é".repeat(length).into());
    draft
}

/// The item a create was queued for, and the bytes its write sends.
fn queued_size(core: &Core, draft: &Draft) -> (String, usize) {
    let row = core.create_item(draft).unwrap();
    let size = store::payload_of(&core.conn().unwrap(), &row.id)
        .unwrap()
        .len();
    (row.item_id.unwrap(), size)
}

/// The creates sent. The read a refusal owes lists the bin at the same path.
fn sends(server: &Scripted) -> usize {
    server
        .seen("/items")
        .iter()
        .filter(|seen| seen.query.is_empty())
        .count()
}

/// Answers the read a refused create owes: no such row, in the bin or out.
fn holding_no_row(server: &Scripted, id: &str) {
    server.on(
        &format!("/items/{id}"),
        vec![scripted::certified(scripted::refusal(
            404,
            "item_not_found",
        ))],
    );
    server.on(
        "/items",
        vec![scripted::certified(scripted::json(
            200,
            r#"{"data":[],"next_cursor":null}"#,
        ))],
    );
}

#[test]
fn a_write_over_the_limit_the_root_names_is_refused_unsent_and_one_at_it_goes() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    let (id, size) = queued_size(&core, &long_note(2_000));
    server.on("/", vec![root_naming(&(size - 1).to_string())]);
    holding_no_row(&server, &id);
    let report = core.drain().unwrap();
    assert_eq!(sends(&server), 0, "{report:?}");
    assert_eq!(report.unsent, 1);
    let verdict = &report.verdicts[0];
    assert_eq!(verdict.verdict, Some(Verdict::Refused));
    let reason = verdict.reason.as_deref().unwrap();
    assert!(reason.starts_with(OVER_REQUEST_LIMIT_REASON), "{reason}");
    assert!(!reason.contains("request_too_large"), "{reason}");

    // The witness: a body of exactly the limit is sent.
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    let (id, size) = queued_size(&core, &long_note(2_000));
    server.on("/", vec![root_naming(&size.to_string())]);
    server.on("/items", vec![answered_create(&id)]);
    let _ = core.drain();
    assert_eq!(sends(&server), 1);
}

#[test]
fn the_limit_counts_the_bytes_sent_not_the_characters() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    // Two bytes a character, so 2,000 characters do not fit in 3,000 bytes.
    let (id, _) = queued_size(&core, &long_note(2_000));
    server.on("/", vec![root_naming("3000")]);
    holding_no_row(&server, &id);
    let report = core.drain().unwrap();
    assert_eq!((sends(&server), report.unsent), (0, 1));
}

#[test]
fn a_root_naming_no_limit_leaves_the_write_to_be_sent() {
    for root in [
        scripted::root(INSTANCE),
        root_naming("0"),
        root_naming("\"large\""),
    ] {
        let server = Scripted::start();
        let core = copy(&server);
        holding_a_catalog(&core);
        let (id, _) = queued_size(&core, &long_note(2_000));
        server.on("/", vec![root]);
        server.on("/items", vec![answered_create(&id)]);
        let _ = core.drain();
        assert_eq!(sends(&server), 1);
        assert_eq!(store::request_limit(&core.conn().unwrap()).unwrap(), None);
    }
}

#[test]
fn a_write_sent_before_goes_again_under_its_key_whatever_the_limit() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    let (id, _) = queued_size(&core, &long_note(2_000));
    let row = core.queue().unwrap().remove(0).id;
    store::mark_sent(&core.conn().unwrap(), &row).unwrap();
    server.on("/", vec![root_naming("100")]);
    server.on("/items", vec![answered_create(&id)]);
    let _ = core.drain();
    assert_eq!(sends(&server), 1);
}

#[test]
fn a_write_over_the_limit_the_copy_knows_is_refused_as_a_field_is_and_a_raised_one_takes_it() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    store::note_request_limit(&core.conn().unwrap(), Some(100)).unwrap();
    let draft = long_note(2_000);
    let refused = core.create_item(&draft).unwrap_err();
    assert!(
        matches!(&refused, CoreError::Validation { code, message, .. }
            if code == OVER_REQUEST_LIMIT && message.contains("this server takes 100")),
        "{refused:?}"
    );
    assert!(core.queue().unwrap().is_empty());

    store::note_request_limit(&core.conn().unwrap(), Some(1_000_000)).unwrap();
    core.create_item(&draft).unwrap();
    assert_eq!(core.queue().unwrap().len(), 1);
}

#[test]
fn an_edit_over_the_limit_leaves_the_copy_as_it_was() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    let item = store::testing::note("a", "a", "short", "2026-01-01T00:00:00Z");
    store::upsert_item(&core.conn().unwrap(), &item, None, &Default::default()).unwrap();
    store::note_request_limit(&core.conn().unwrap(), Some(100)).unwrap();
    let mut edit = crate::Edit {
        base_version: Some(item.version),
        ..Default::default()
    };
    edit.properties
        .insert("body".into(), "é".repeat(2_000).into());
    assert!(matches!(
        core.update_item("a", &edit),
        Err(CoreError::Validation { code, .. }) if code == OVER_REQUEST_LIMIT
    ));
    assert!(core.queue().unwrap().is_empty());
    assert_eq!(
        core.get("a").unwrap().unwrap().properties["body"],
        serde_json::json!("short")
    );
}

#[test]
fn the_limit_stays_what_the_root_last_said_and_follows_it_either_way() {
    let server = Scripted::start();
    let core = copy(&server);
    holding_a_catalog(&core);
    let limit = || store::request_limit(&core.conn().unwrap()).unwrap();
    let read = |root: Answer| {
        server.on("/", vec![root]);
        crate::catch_up::refuse_another_instance(&core, core.http().unwrap()).unwrap();
    };
    assert_eq!(limit(), None);
    read(root_naming("2000"));
    assert_eq!(limit(), Some(2_000));
    read(root_naming("500"));
    assert_eq!(limit(), Some(500));
    read(scripted::root(INSTANCE));
    assert_eq!(limit(), None);
}
