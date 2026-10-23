use crate::model::Verdict;
use crate::scripted::{self, Scripted};
use crate::stop_tests::{copy_in_keyed, created, holding_a_catalog};

fn authorizations(server: &Scripted, path: &str) -> Vec<String> {
    server
        .seen(path)
        .into_iter()
        .filter_map(|seen| seen.authorization)
        .collect()
}

/// A file added under one key whose upload the server took and whose item it
/// held back with a rate limit, so the item still waits when the copy next
/// drains.
fn taken_upload_then_held_item(server: &Scripted, dir: &std::path::Path) -> (String, String) {
    let core = copy_in_keyed(server, dir, "first");
    holding_a_catalog(&core);
    let file = dir.join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    let blob = format!(r#"{{"hash":"{hash}","size_bytes":20}}"#);
    server.on("/blobs", vec![scripted::json(201, &blob)]);
    server.on("/items", vec![scripted::refusal(429, "rate_limited")]);
    let report = core.drain().unwrap();
    assert_eq!(report.undelivered, 1, "the item was not held back");
    // The witness for what follows: the same key draining again does not
    // send the bytes again.
    let again = core.drain().unwrap();
    assert_eq!(again.undelivered, 1);
    assert_eq!(authorizations(server, "/blobs"), ["Bearer first"]);
    let file_id = added.item.item_id.clone().unwrap();
    let r#type = core.get(&file_id).unwrap().unwrap().r#type;
    (file_id, r#type)
}

#[test]
fn sends_a_taken_upload_again_under_a_new_key_before_the_file_waiting_on_it() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (file_id, r#type) = taken_upload_then_held_item(&server, dir.path());

    let (receipt, read) = created(&file_id, &r#type);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    let core = copy_in_keyed(&server, dir.path(), "second");
    let report = core.drain().unwrap();

    assert_eq!(report.undelivered, 0, "{report:?}");
    assert_eq!(
        authorizations(&server, "/blobs"),
        ["Bearer first", "Bearer second"],
        "the file went out under a key that never sent its bytes"
    );
    assert_eq!(
        authorizations(&server, "/items").last().map(String::as_str),
        Some("Bearer second")
    );
    assert_eq!(
        core.queue()
            .unwrap()
            .iter()
            .map(|queued| queued.verdict)
            .collect::<Vec<_>>(),
        [Some(Verdict::Accepted); 2]
    );
}

#[test]
fn keeps_the_bytes_a_waiting_file_names_after_their_upload_is_taken() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "first");
    holding_a_catalog(&core);
    let file = dir.path().join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    server.on(
        "/blobs",
        vec![scripted::json(
            201,
            &format!(r#"{{"hash":"{hash}","size_bytes":20}}"#),
        )],
    );
    server.on("/items", vec![scripted::refusal(429, "rate_limited")]);
    core.drain().unwrap();

    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(
        core.blob_held(&hash).unwrap(),
        "a trim let go of bytes a waiting file still names"
    );

    // The witness: once the file is taken, nothing waits on the bytes and
    // the same trim lets them go.
    let file_id = added.item.item_id.clone().unwrap();
    let r#type = core.get(&file_id).unwrap().unwrap().r#type;
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    assert_eq!(core.drain().unwrap().undelivered, 0);
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(!core.blob_held(&hash).unwrap());
}

#[test]
fn a_renewed_token_does_not_send_a_taken_upload_again() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "first");
    core.renew_credential_with(Box::new(|_| Ok("fresh".into())));
    holding_a_catalog(&core);
    let file = dir.path().join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    server.on(
        "/blobs",
        vec![scripted::json(
            201,
            &format!(r#"{{"hash":"{hash}","size_bytes":20}}"#),
        )],
    );
    server.on("/items", vec![scripted::refusal(429, "rate_limited")]);
    assert_eq!(core.drain().unwrap().undelivered, 1);
    // The token is renewed while the file is held back again.
    server.on(
        "/items",
        vec![
            scripted::refusal(401, "unauthorized"),
            scripted::refusal(429, "rate_limited"),
        ],
    );
    assert_eq!(core.drain().unwrap().undelivered, 1);

    let file_id = added.item.item_id.clone().unwrap();
    let r#type = core.get(&file_id).unwrap().unwrap().r#type;
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    assert_eq!(core.drain().unwrap().undelivered, 0);
    // The witness: the renewal happened, and the file went out under it.
    assert_eq!(
        authorizations(&server, "/items").last().map(String::as_str),
        Some("Bearer fresh")
    );
    assert_eq!(
        authorizations(&server, "/blobs"),
        ["Bearer first"],
        "a renewed token sent the bytes again, though it is the same credential"
    );
}

#[test]
fn sends_a_taken_upload_again_only_once_the_write_waiting_on_it_is_released() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let (file_id, r#type) = taken_upload_then_held_item(&server, dir.path());
    let core = copy_in_keyed(&server, dir.path(), "second");
    let create = core
        .queue()
        .unwrap()
        .into_iter()
        .find(|queued| queued.kind == crate::model::WriteKind::CreateItem)
        .unwrap()
        .id;
    crate::store::record_verdict(
        &core.conn().unwrap(),
        &create,
        &crate::store::Answered {
            verdict: Verdict::Blocked,
            reason: Some(crate::model::BlockedReason::KeySpent.as_str()),
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();

    core.drain().unwrap();
    assert_eq!(
        authorizations(&server, "/blobs"),
        ["Bearer first"],
        "the bytes went again for a write that is not sent until it is released"
    );
    let hash = core
        .queue()
        .unwrap()
        .into_iter()
        .find_map(|queued| queued.blob)
        .unwrap();
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(
        core.blob_held(&hash).unwrap(),
        "a trim let go of bytes a write that can be released still names"
    );

    assert!(core.release(&create).unwrap());
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    assert_eq!(core.drain().unwrap().undelivered, 0);
    assert_eq!(
        authorizations(&server, "/blobs"),
        ["Bearer first", "Bearer second"],
        "the released file went out under a key that never sent its bytes"
    );
    assert_eq!(
        authorizations(&server, "/items").last().map(String::as_str),
        Some("Bearer second")
    );
    // Answered, the file holds the bytes no longer.
    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(!core.blob_held(&hash).unwrap());
}

/// A file added and its content updated under the key `first`, with both
/// uploads taken and the create counted once and left waiting, so the
/// update waits on the create and on the second upload.
struct UpdatedFile {
    core: std::sync::Arc<crate::Core>,
    create: String,
    update: String,
    first: String,
    second: String,
}

fn taken(hash: &str, size: usize) -> crate::scripted::Answer {
    scripted::json(201, &format!(r#"{{"hash":"{hash}","size_bytes":{size}}}"#))
}

fn file_updated_while_its_create_waits(server: &Scripted, dir: &std::path::Path) -> UpdatedFile {
    let core = copy_in_keyed(server, dir, "first");
    holding_a_catalog(&core);
    let file = dir.join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let file_id = added.item.item_id.clone().unwrap();
    let first = added.upload.blob.clone().unwrap();
    let edited = dir.join("edited.txt");
    std::fs::write(&edited, b"the bytes of an edited photo").unwrap();
    let edit = crate::model::Edit {
        base_version: Some(0),
        ..crate::model::Edit::default()
    };
    let update = core
        .update_file_item(&file_id, &edited, &edit, crate::Based::OnHeld)
        .unwrap()
        .id;
    let second = core
        .queue()
        .unwrap()
        .into_iter()
        .filter(|queued| queued.kind == crate::model::WriteKind::UploadBlob)
        .find_map(|queued| queued.blob.filter(|hash| *hash != first))
        .unwrap();
    server.on("/blobs", vec![taken(&first, 20), taken(&second, 28)]);
    // Counted, not environmental, so the pass goes on to the second upload.
    server.on(
        "/items",
        vec![scripted::refusal(409, "idempotency_key_in_flight")],
    );
    core.drain().unwrap();
    let queue = core.queue().unwrap();
    assert_eq!(
        queue
            .iter()
            .filter(|queued| queued.kind == crate::model::WriteKind::UploadBlob)
            .map(|queued| queued.verdict)
            .collect::<Vec<_>>(),
        [Some(Verdict::Accepted); 2]
    );
    let waiting = queue.iter().find(|queued| queued.id == update).unwrap();
    assert!(waiting.depends_on.contains(&added.item.id), "{waiting:?}");
    UpdatedFile {
        core,
        create: added.item.id,
        update,
        first,
        second,
    }
}

fn queued(core: &crate::Core, id: &str) -> crate::model::QueuedWrite {
    core.queue()
        .unwrap()
        .into_iter()
        .find(|queued| queued.id == id)
        .unwrap()
}

#[test]
fn keeps_the_bytes_of_a_file_update_refused_with_a_dead_create_until_it_is_released() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let UpdatedFile {
        core,
        create,
        update,
        first,
        second,
    } = file_updated_while_its_create_waits(&server, dir.path());
    // The create reaches the refusal ceiling, and the next pass refuses the
    // update waiting on it before sending it, as `readiness` does.
    crate::store::record_verdict(
        &core.conn().unwrap(),
        &create,
        &crate::store::Answered {
            verdict: Verdict::Dead,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    let held = queued(&core, &update);
    crate::store::record_refusal(
        &core.conn().unwrap(),
        &held,
        "the create_item it waits for was dead",
        None,
        false,
    )
    .unwrap();
    assert_eq!(queued(&core, &update).verdict, Some(Verdict::Refused));

    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(
        core.blob_held(&second).unwrap(),
        "a trim let go of bytes a refused update that can be released still names"
    );

    // Released under a new key, the create releases the update with it, and
    // both uploads go again under that key ahead of them.
    drop(core);
    let core = copy_in_keyed(&server, dir.path(), "second");
    assert!(core.release(&create).unwrap());
    assert_eq!(queued(&core, &update).verdict, None);
    server.on("/blobs", vec![taken(&first, 20), taken(&second, 28)]);
    server.on(
        "/items",
        vec![scripted::refusal(409, "idempotency_key_in_flight")],
    );
    core.drain().unwrap();
    assert_eq!(
        authorizations(&server, "/blobs"),
        [
            "Bearer first",
            "Bearer first",
            "Bearer second",
            "Bearer second"
        ],
        "the released update would go out under a key that never sent its bytes"
    );
}

#[test]
fn lets_go_the_bytes_of_a_file_update_refused_behind_a_withdrawn_create() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let UpdatedFile {
        core,
        create,
        update,
        second,
        ..
    } = file_updated_while_its_create_waits(&server, dir.path());
    let row = queued(&core, &create);
    {
        let conn = core.conn().unwrap();
        let held = crate::store::held_for(&conn, &create).unwrap();
        assert_eq!(
            held.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            [update.as_str()]
        );
        crate::store::withdraw(&conn, &row, &held).unwrap();
    }
    assert_eq!(queued(&core, &update).verdict, Some(Verdict::Refused));
    // No release can send the update again, so nothing waits on the bytes.
    assert!(!core.release(&update).unwrap());

    core.set_file_budget(crate::FileBudget::Bytes(0)).unwrap();
    assert!(
        !core.blob_held(&second).unwrap(),
        "a trim kept bytes for a refused update no release can send"
    );
}

#[test]
fn writes_down_a_renewal_left_in_memory_when_a_drain_ends() {
    let server = Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = copy_in_keyed(&server, dir.path(), "first");
    holding_a_catalog(&core);
    let file = dir.path().join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let added = core
        .add_file(&file, &crate::Attachment::default(), &[])
        .unwrap();
    let hash = added.upload.blob.clone().unwrap();
    let file_id = added.item.item_id.clone().unwrap();
    let r#type = core.get(&file_id).unwrap().unwrap().r#type;
    let (receipt, read) = created(&file_id, &r#type);
    server.on("/blobs", vec![taken(&hash, 20)]);
    server.on("/items", vec![scripted::json(201, &receipt)]);
    server.on(&format!("/items/{file_id}"), vec![read]);
    assert_eq!(core.drain().unwrap().undelivered, 0);
    let sent_as = || {
        crate::store::meta_get(
            &core.conn().unwrap(),
            &format!("upload_sent_as/{}", added.upload.id),
        )
        .unwrap()
    };
    let first = crate::store::credential_digest("Bearer first");
    assert_eq!(sent_as().as_deref(), Some(first.as_str()));

    // A renewal whose callback found the connection held waits in memory,
    // and this drain has nothing to send.
    let fresh = crate::store::credential_digest("Bearer fresh");
    core.renewals.lock().unwrap().push((first, fresh.clone()));
    core.drain().unwrap();

    assert_eq!(
        sent_as().as_deref(),
        Some(fresh.as_str()),
        "the renewal was left in memory, for a process that exits to lose"
    );
}
