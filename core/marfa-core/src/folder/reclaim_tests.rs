//! A watch gives a copy's freed pages back to the disk, soon after it starts
//! on a copy whose rows left before, and not while it is told to stop.

use super::held_links_tests::{nothing_found, online_folder};
use super::*;

fn size(dir: &std::path::Path) -> u64 {
    std::fs::metadata(dir.join(STATE_DIR).join("core.sqlite"))
        .unwrap()
        .len()
}

#[test]
fn the_first_pass_over_a_copy_that_let_its_rows_go_gives_the_disk_back() {
    let (dir, folder, _server) = online_folder(nothing_found());
    crate::reclaim_tests::fill_and_let_go(folder.core(), 700, 9);
    folder
        .core()
        .conn()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let before = size(dir.path());
    let mut passes = watch::Passes::default();

    passes.run(&folder, true).unwrap();

    let after = size(dir.path());
    assert!(after * 4 < before, "{before} bytes became {after}");
    assert!(
        matches!(passes.reclaimed.as_slice(), [WatchEvent::Reclaimed { from, to }] if to < from),
        "{:?}",
        passes.reclaimed
    );
    // The rule is false now, so the next pass tells nothing.
    assert!(folder.reclaim_space(&[]).is_none());
}

#[test]
fn a_pass_over_a_small_copy_tells_nothing() {
    let (_dir, folder, _server) = online_folder(nothing_found());
    let mut passes = watch::Passes::default();
    passes.run(&folder, true).unwrap();
    assert!(passes.reclaimed.is_empty());
}

#[test]
fn a_watch_that_is_stopping_starts_no_rewrite() {
    let (_dir, folder, _server) = online_folder(nothing_found());
    crate::reclaim_tests::fill_and_let_go(folder.core(), 700, 9);
    let stop = AtomicBool::new(true);
    assert!(folder.reclaim_space(&[&stop]).is_none());
    assert!(
        folder.reclaim_space(&[&AtomicBool::new(false)]).is_some(),
        "the same copy is rewritten when nothing stops it"
    );
}
