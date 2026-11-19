//! A store reached by a plain path: one identity through every name, and the
//! file system it lives on admitted before a lock is claimed.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::scripted::{self, Scripted};
use crate::stop_tests::{holding_a_catalog, scripted_copy};
use crate::{Core, CoreError, Handle, Server};

fn on(server: &Scripted, path: &Path) -> Arc<Core> {
    let core = Core::open(
        path,
        Some(Server {
            url: server.url(),
            key: "k".into(),
        }),
    )
    .unwrap();
    assert_eq!(core.handle(), Handle::Writer, "{}", path.display());
    let core = scripted_copy(server, core);
    holding_a_catalog(&core);
    core
}

/// `real.sqlite` with the names that reach it: one link, and a link to that
/// link.
#[cfg(unix)]
fn names(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let real = dir.join("real.sqlite");
    drop(Core::open(&real, None).unwrap());
    let alias = dir.join("alias.sqlite");
    let chained = dir.join("chained.sqlite");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    std::os::unix::fs::symlink("alias.sqlite", &chained).unwrap();
    (real, alias, chained)
}

/// Queues an upload through `queue`, and drains it through `drain`.
#[cfg(unix)]
fn queued_through_drained_through(queue: &Path, drain: &Path) {
    let server = Scripted::start();
    let dir = queue.parent().unwrap();
    let file = dir.join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    let hash = {
        let core = on(&server, queue);
        let queued = core.put_blob(&file, Some("text/plain")).unwrap();
        queued.blob.clone().unwrap()
    };
    server.on(
        "/blobs",
        vec![scripted::json(
            201,
            &format!(r#"{{"hash":"{hash}","size_bytes":20}}"#),
        )],
    );
    let core = on(&server, drain);
    let report = core.drain().unwrap();
    assert_eq!(
        (report.unsent, server.seen("/blobs").len()),
        (0, 1),
        "an upload queued through {} was not sent through {}: {report:?}",
        queue.display(),
        drain.display()
    );
}

#[cfg(unix)]
#[test]
fn an_upload_queued_through_a_link_is_sent_through_the_store_and_the_reverse() {
    let dir = tempfile::tempdir().unwrap();
    let (real, alias, _) = names(dir.path());
    queued_through_drained_through(&alias, &real);
    let other = tempfile::tempdir().unwrap();
    let (real, alias, _) = names(other.path());
    queued_through_drained_through(&real, &alias);
}

#[cfg(unix)]
#[test]
fn an_upload_queued_through_a_chain_of_links_is_sent_through_each_name() {
    for (queue, drain) in [(2, 0), (0, 2), (2, 1), (1, 2)] {
        let dir = tempfile::tempdir().unwrap();
        let (real, alias, chained) = names(dir.path());
        let all = [real, alias, chained];
        queued_through_drained_through(&all[queue], &all[drain]);
    }
}

#[cfg(unix)]
#[test]
fn a_store_reached_through_a_link_keeps_its_bytes_in_one_folder() {
    let dir = tempfile::tempdir().unwrap();
    let (real, alias, chained) = names(dir.path());
    let core = Core::open(&chained, None).unwrap();
    let file = dir.path().join("photo.txt");
    std::fs::write(&file, b"the bytes of a photo").unwrap();
    core.put_blob(&file, Some("text/plain")).unwrap();
    let folder = |name: &str| dir.path().join(format!("{name}.sqlite.blobs"));
    assert!(folder("real").is_dir(), "no folder beside the store itself");
    for name in ["alias", "chained"] {
        assert!(
            !folder(name).exists(),
            "{name}.sqlite.blobs was made beside a link"
        );
    }
    drop((real, alias));
}

#[cfg(unix)]
#[test]
fn a_reader_through_one_name_keeps_bytes_from_a_trim_through_another() {
    let dir = tempfile::tempdir().unwrap();
    let (real, alias, _) = names(dir.path());
    let writer = Core::open(&real, None).unwrap();
    let reader = Core::open_reader(&alias).unwrap();
    let held = |name: &str| {
        let hex = name.repeat(64);
        let path = crate::blob::Cache::dir_beside(&real);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join(&hex), [0u8; 100]).unwrap();
        (format!("sha256:{hex}"), path.join(hex))
    };
    let (read, read_file) = held("a");
    let (_, spare_file) = held("b");
    let _guard = reader.cache().unwrap().reading(&read).unwrap();
    writer
        .cache()
        .unwrap()
        .trim(&HashSet::new(), &HashSet::new(), |_| Some(10));
    assert!(read_file.exists(), "bytes a reader holds were trimmed");
    // The witness: the same trim takes bytes nobody reads.
    assert!(!spare_file.exists(), "the trim took nothing");
}

#[cfg(all(unix, debug_assertions))]
#[test]
fn a_plain_path_on_a_file_system_that_does_not_lock_is_refused_before_a_lock_is_claimed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sqlite");
    {
        let _lockless = crate::fault::fail_on_this_thread("unlocked-filesystem");
        let refused = Core::open(&path, None);
        assert!(
            matches!(&refused, Err(CoreError::Invalid(message)) if message.contains("filesystem")),
            "{:?}",
            refused.map(|core| core.handle())
        );
        let present: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert!(present.is_empty(), "a refused open left {present:?}");
        // An in-memory store holds no file to lock.
        assert_eq!(
            Core::open_in_memory(None).unwrap().handle(),
            Handle::Writer
        );
    }
    // The witness: the same path opens as the writer where files lock.
    assert_eq!(Core::open(&path, None).unwrap().handle(), Handle::Writer);
}
