use super::*;

#[cfg(unix)]
#[test]
fn captured_binary_upload_does_not_reopen_the_replacement_path() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap().join("owned");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join(".marfa")).unwrap();
    let admitted = directory::Directory::open(&root).unwrap();
    let state = admitted.child(Path::new(".marfa"), false).unwrap();
    let core = Core::open_directory(&state, &root.join(".marfa/core.sqlite"), None).unwrap();
    store::replace_types(
        &core.conn().unwrap(),
        &[store::testing::wire_type("core.file", None, Some("title"))],
    )
    .unwrap();
    let path = root.join("source.bin");
    std::fs::write(&path, b"original binary").unwrap();
    let mut file = admitted.capture_file(Path::new("source.bin")).unwrap();
    let size = file.metadata().unwrap().len();
    let mut captured = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut captured).unwrap();
    assert_eq!(captured.len() as u64, size);
    let draft = Draft {
        r#type: "core.file".into(),
        ..Default::default()
    };
    let witness = core
        .create_file_item_from(&path, &captured[..], &draft)
        .unwrap()
        .item_id
        .unwrap();
    assert_eq!(
        core.get(&witness).unwrap().unwrap().properties["blob_ref"],
        blob::name_of(&captured)
    );
    std::fs::rename(&root, temp.path().join("original")).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join(".marfa")).unwrap();
    std::fs::write(root.join(".marfa/core.sqlite"), b"foreign database").unwrap();
    std::fs::write(&path, b"foreign replacement").unwrap();
    let queued = core
        .create_file_item_from(&path, &captured[..], &draft)
        .unwrap()
        .item_id
        .unwrap();
    assert_eq!(
        core.get(&queued).unwrap().unwrap().properties["blob_ref"],
        blob::name_of(&captured)
    );
    core.update_file_item_from(
        &queued,
        &path,
        &b"captured update"[..],
        &Edit {
            base_version: Some(core.get(&queued).unwrap().unwrap().version),
            ..Edit::default()
        },
        Based::OnHeld,
    )
    .unwrap();
    assert_eq!(
        core.get(&queued).unwrap().unwrap().properties["blob_ref"],
        blob::name_of(b"captured update")
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"foreign replacement");
    assert_eq!(
        std::fs::read(root.join(".marfa/core.sqlite")).unwrap(),
        b"foreign database"
    );
    assert_eq!(std::fs::read_dir(root.join(".marfa")).unwrap().count(), 1);
}

#[test]
fn a_file_added_with_a_tag_the_server_refuses_takes_in_no_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let file = dir.path().join("note.txt");
    std::fs::write(&file, b"bytes to hold").unwrap();
    let hash = blob::name_of(b"bytes to hold");
    let bad = ["".to_string()];
    let failure = core
        .add_file(&file, &Attachment::default(), &bad)
        .unwrap_err();
    assert!(
        matches!(failure, CoreError::Validation { .. }),
        "{failure:?}"
    );
    assert!(core.queue().unwrap().is_empty());
    assert!(
        !core.blob_held(&hash).unwrap(),
        "a refused file left its bytes behind"
    );
    let good = ["a".repeat(MAX_TAG_LENGTH)];
    assert!(core.add_file(&file, &Attachment::default(), &good).is_ok());
    assert!(core.blob_held(&hash).unwrap());
}

#[test]
fn a_file_taken_in_shows_the_length_of_its_bytes_before_any_server_answers() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    store::replace_types(
        &core.conn().unwrap(),
        &[
            store::testing::wire_type("core.note", None, Some("title")),
            store::testing::wire_type("core.file", None, Some("title")),
            store::testing::wire_type("core.file.image", Some("core.file"), Some("title")),
            store::testing::wire_type("acme.scan", None, Some("title")),
        ],
    )
    .unwrap();
    let photo = dir.path().join("photo.png");
    std::fs::write(&photo, b"twelve bytes").unwrap();
    let longer = dir.path().join("longer.png");
    std::fs::write(&longer, b"fifteen bytes!!").unwrap();
    let size_of = |id: &str| {
        core.get(id)
            .unwrap()
            .unwrap()
            .properties
            .get("size_bytes")
            .cloned()
    };

    let added = core.add_file(&photo, &Attachment::default(), &[]).unwrap();
    let added = added.item.item_id.unwrap();
    assert_eq!(core.get(&added).unwrap().unwrap().r#type, "core.file.image");
    assert_eq!(size_of(&added), Some(12.into()));

    let note = core
        .create_item(&Draft {
            r#type: "core.note".into(),
            properties: serde_json::json!({ "title": "holder" })
                .as_object()
                .unwrap()
                .clone(),
            ..Default::default()
        })
        .unwrap()
        .item_id
        .unwrap();
    let attached = core.attach(&note, &longer, &Attachment::default()).unwrap();
    assert_eq!(size_of(&attached.item.item_id.unwrap()), Some(15.into()));

    let draft = Draft {
        r#type: "core.file.image".into(),
        properties: serde_json::json!({ "title": "photo.png" })
            .as_object()
            .unwrap()
            .clone(),
        ..Default::default()
    };
    let created = core
        .create_file_item(&photo, &draft)
        .unwrap()
        .item_id
        .unwrap();
    assert_eq!(size_of(&created), Some(12.into()));
    let held = core.get(&created).unwrap().unwrap();
    let edit = Edit {
        base_version: Some(held.version),
        ..Edit::default()
    };
    core.update_file_item(&created, &longer, &edit, Based::OnHeld)
        .unwrap();
    assert_eq!(size_of(&created), Some(15.into()));

    let scan = Attachment {
        r#type: Some("acme.scan".into()),
        ..Attachment::default()
    };
    let other = core
        .add_file(&photo, &scan, &[])
        .unwrap()
        .item
        .item_id
        .unwrap();
    let other = core.get(&other).unwrap().unwrap();
    assert_eq!(
        other.properties.get("blob_ref"),
        Some(&blob::name_of(b"twelve bytes").into())
    );
    assert_eq!(
        other.properties.get("size_bytes"),
        None,
        "a type outside the file family took a size"
    );
}

#[test]
fn with_no_server_held_bytes_are_answered_and_the_rest_are_absent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    let core = Core::open(&path, None).unwrap();
    let file = dir.path().join("note.txt");
    std::fs::write(&file, b"held here").unwrap();
    let hash = core
        .cache()
        .unwrap()
        .take_reader(&file, std::fs::File::open(&file).unwrap())
        .unwrap()
        .hash;
    let held = core.blob(&hash).unwrap();
    assert_eq!(std::fs::read(held.path()).unwrap(), b"held here");
    let other = blob::name_of(b"never held");
    assert!(matches!(
        core.blob(&other),
        Err(CoreError::BytesAbsent { hash, .. }) if hash == other
    ));
}

/// Two readers on one shared handle under a budget of zero: the second
/// reader's trim must not take the bytes the first has fetched and not
/// yet answered.
#[cfg(debug_assertions)]
#[test]
fn a_trim_on_another_thread_keeps_the_bytes_a_caller_is_reading() {
    let server = crate::scripted::Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    core.set_file_budget(FileBudget::Bytes(0)).unwrap();
    let serve = |bytes: &[u8]| {
        let hash = blob::name_of(bytes);
        let link = blob::tests::linking(bytes.to_vec(), false);
        server.on(
            &format!("/blobs/{hash}/url"),
            vec![crate::scripted::json(
                200,
                &format!(r#"{{"url":"{link}"}}"#),
            )],
        );
        hash
    };
    let first = serve(b"read on the first thread");
    let second = serve(b"read on the second thread");
    let point = format!("blob-answered:{first}");
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let reading = scope.spawn(|| core.blob(&first));
        let waited = std::time::Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the first reader never reached its answer"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let other = core.blob(&second);
        crate::fault::release(&point);
        assert_eq!(
            std::fs::read(other.unwrap().path()).unwrap(),
            b"read on the second thread"
        );
        let path = reading.join().unwrap().unwrap();
        assert_eq!(
            std::fs::read(path.path()).ok().as_deref(),
            Some(&b"read on the first thread"[..]),
            "another thread's trim took the bytes a caller was about to read"
        );
    });
    // The witness: once both are answered, the next trim takes them.
    assert_eq!(core.trim_files().unwrap(), 24 + 25);
    assert!(!core.blob_held(&first).unwrap());
    assert!(!core.blob_held(&second).unwrap());
}

#[cfg(debug_assertions)]
#[test]
fn a_trim_through_the_writer_keeps_the_bytes_a_reading_handle_is_reading() {
    let server = crate::scripted::Scripted::start();
    let dir = tempfile::tempdir().unwrap();
    let core = crate::stop_tests::copy_in_keyed(&server, dir.path(), "k");
    core.set_file_budget(FileBudget::KeepAll).unwrap();
    let bytes = b"read through the reading handle";
    let hash = blob::name_of(bytes);
    let link = blob::tests::linking(bytes.to_vec(), false);
    server.on(
        &format!("/blobs/{hash}/url"),
        vec![crate::scripted::json(
            200,
            &format!(r#"{{"url":"{link}"}}"#),
        )],
    );
    core.blob(&hash).unwrap();
    let reader = Core::open_reader(dir.path().join("core.sqlite")).unwrap();
    let point = format!("blob-answered:{hash}");
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let reading = scope.spawn(|| reader.blob(&hash));
        let waited = std::time::Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the reading handle never reached its answer"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let taken = core.set_file_budget(FileBudget::Bytes(0));
        crate::fault::release(&point);
        assert_eq!(taken.unwrap(), 0);
        let path = reading.join().unwrap().unwrap();
        assert_eq!(
            std::fs::read(path.path()).ok().as_deref(),
            Some(&bytes[..]),
            "the writer's trim took the bytes a reading handle was about to read"
        );
    });
    // The witness: once the reading handle is answered, a trim takes them.
    assert_eq!(core.trim_files().unwrap(), bytes.len() as u64);
    assert!(!core.blob_held(&hash).unwrap());
}

/// Bytes an upload names are the only copy until the server has them,
/// whether the upload is queued after they were fetched or while a fetch
/// of them is arriving.
#[cfg(debug_assertions)]
#[cfg(target_os = "macos")]
#[test]
fn bytes_an_upload_names_stay_in_backups_whichever_comes_first() {
    use crate::file_cache::tests::excluded;
    // The system excludes its own temporary folders, so the witness has to
    // sit under the home folder.
    let home = std::env::var_os("HOME").expect("HOME");
    let area = tempfile::Builder::new()
        .prefix(".marfa-backup-test-")
        .tempdir_in(home)
        .unwrap();
    let server = crate::scripted::Scripted::start();
    let core = crate::stop_tests::copy_in_keyed(&server, area.path(), "k");
    core.set_file_budget(FileBudget::KeepAll).unwrap();
    let serve = |bytes: &[u8]| {
        let hash = blob::name_of(bytes);
        let link = blob::tests::linking(bytes.to_vec(), false);
        server.on(
            &format!("/blobs/{hash}/url"),
            vec![crate::scripted::json(
                200,
                &format!(r#"{{"url":"{link}"}}"#),
            )],
        );
        hash
    };
    let upload = |name: &str, bytes: &[u8]| {
        let path = area.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        core.put_blob(&path, Some("text/plain")).unwrap();
    };

    let fetched_first = b"fetched, then queued as an upload";
    let hash = serve(fetched_first);
    let path = core.blob(&hash).unwrap().path().to_path_buf();
    assert!(
        excluded(&path),
        "fetched bytes were not left out of backups"
    );
    upload("fetched-first.txt", fetched_first);
    assert!(
        !excluded(&path),
        "bytes fetched and then queued as an upload stayed out of backups"
    );

    let queued_first = b"queued while a fetch of it arrived";
    let hash = serve(queued_first);
    let point = format!("blob-arrived:{hash}");
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let fetching = scope.spawn(|| core.blob(&hash).map(|held| held.path().to_path_buf()));
        let waited = std::time::Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the fetch never arrived"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        upload("queued-first.txt", queued_first);
        crate::fault::release(&point);
        let path = fetching.join().unwrap().unwrap();
        assert!(
            !excluded(&path),
            "a fetch that settled after an upload of its bytes was queued left them out of backups"
        );
    });
    assert_eq!(core.file_cache().unwrap().backup_mark_failure, None);
}

#[cfg(debug_assertions)]
#[test]
fn two_budgets_set_at_once_each_trim_to_the_one_they_stored() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let path = dir.path().join("kept.txt");
    std::fs::write(&path, b"fetched once").unwrap();
    let hash = core
        .cache()
        .unwrap()
        .take_reader(&path, std::fs::File::open(&path).unwrap())
        .unwrap()
        .hash;
    core.set_file_budget(FileBudget::KeepAll).unwrap();
    let point = &format!("budget-stored:{:p}", &core);
    crate::fault::arm(point);
    std::thread::scope(|scope| {
        let zero = scope.spawn(|| core.set_file_budget(FileBudget::Bytes(0)));
        let waited = std::time::Instant::now();
        while crate::fault::waiting(point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the first call never stored its budget"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let keep_all = scope.spawn(|| core.set_file_budget(FileBudget::KeepAll));
        // Long enough for a second call that is not held back to store
        // its budget over the first one's.
        std::thread::sleep(std::time::Duration::from_millis(200));
        crate::fault::release(point);
        assert_eq!(
            zero.join().unwrap().unwrap(),
            12,
            "a budget of zero was stored and then never enforced"
        );
        assert_eq!(keep_all.join().unwrap().unwrap(), 0);
    });
    assert!(!core.blob_held(&hash).unwrap());
    assert_eq!(core.file_budget().unwrap(), FileBudget::KeepAll);
}

/// The queue is written here without the cache's settling lock, which
/// every public call that queues an upload takes, so the trim's own read
/// is all that keeps the write from landing between what it read and
/// what it takes.
#[cfg(debug_assertions)]
#[test]
fn an_upload_queued_while_a_trim_reads_what_to_keep_waits_for_the_trim() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    core.set_file_budget(FileBudget::Bytes(0)).unwrap();
    let path = dir.path().join("fetched.txt");
    std::fs::write(&path, b"fetched once").unwrap();
    let hash = core
        .cache()
        .unwrap()
        .take_reader(&path, std::fs::File::open(&path).unwrap())
        .unwrap()
        .hash;
    let point = format!("uploads-read:{:p}", &core);
    crate::fault::arm(&point);
    std::thread::scope(|scope| {
        let trim = scope.spawn(|| {
            let taken = core.trim_files().unwrap();
            (taken, std::time::Instant::now())
        });
        let waited = std::time::Instant::now();
        while crate::fault::waiting(&point) == 0 {
            assert!(
                waited.elapsed() < std::time::Duration::from_secs(10),
                "the trim never read the queue"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let queued = scope.spawn(|| {
            queue_upload(&core.conn().unwrap(), &hash, "text/plain").unwrap();
            std::time::Instant::now()
        });
        // Long enough for a write that is not held back to land.
        std::thread::sleep(std::time::Duration::from_millis(200));
        crate::fault::release(&point);
        let (taken, trimmed) = trim.join().unwrap();
        let queued = queued.join().unwrap();
        assert_eq!(taken, 12);
        assert!(
            queued >= trimmed,
            "an upload was queued between the trim's read of the queue and its removal"
        );
    });
}

#[cfg(unix)]
#[test]
fn the_state_report_says_held_bytes_are_unknown_where_the_cache_cannot_be_read() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let absent = core.file_cache().unwrap();
    assert_eq!((absent.held, absent.held_unreadable), (Some(0), None));
    let path = dir.path().join("kept.txt");
    std::fs::write(&path, b"fetched once").unwrap();
    let hash = core
        .cache()
        .unwrap()
        .take_reader(&path, std::fs::File::open(&path).unwrap())
        .unwrap()
        .hash;
    assert_eq!(core.file_cache().unwrap().held, Some(12));
    let folder = dir.path().join("core.sqlite.blobs");
    let _shut = crate::test_folders::locked(&folder, 0o000);
    let sealed = std::fs::read_dir(&folder).is_err();
    let report = core.file_cache();
    let taken = core.set_file_budget(FileBudget::Bytes(0));
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(sealed, "the folder could still be read");
    let report = report.unwrap();
    assert_eq!(
        report.held, None,
        "an incomplete count was reported as exact"
    );
    assert!(report.held_unreadable.is_some());
    assert_eq!(taken.unwrap(), 0);
    assert!(
        core.blob_held(&hash).unwrap(),
        "a trim took bytes it could not count"
    );
}

#[test]
fn a_trim_keeps_the_bytes_an_upload_still_names() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().join("core.sqlite"), None).unwrap();
    let file = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        core.cache()
            .unwrap()
            .take_reader(&path, std::fs::File::open(&path).unwrap())
            .unwrap()
            .hash
    };
    let waiting = file("waiting.txt", b"to be sent");
    let read = file("read.txt", b"fetched once");
    let upload = queue_upload(&core.conn().unwrap(), &waiting, "text/plain").unwrap();

    core.set_file_budget(FileBudget::Bytes(0)).unwrap();
    assert!(
        core.blob_held(&waiting).unwrap(),
        "the cap took bytes an upload still names, so it can never be sent"
    );
    assert!(!core.blob_held(&read).unwrap(), "nothing was trimmed");

    store::record_verdict(
        &core.conn().unwrap(),
        &upload.id,
        &store::Answered {
            verdict: Verdict::Accepted,
            reason: None,
            answer: None,
            conflicted_copy_id: None,
        },
    )
    .unwrap();
    core.set_file_budget(FileBudget::Bytes(0)).unwrap();
    assert!(
        !core.blob_held(&waiting).unwrap(),
        "bytes the server has taken were kept past the cap"
    );
}
