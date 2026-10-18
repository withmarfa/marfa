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

    core.trim_blobs(None, 0);
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
    core.trim_blobs(None, 0);
    assert!(!core.blob_held(&hash).unwrap());
}
