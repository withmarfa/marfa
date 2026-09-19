use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use marfa_core::{Folder, Server};
use notify::{EventKind, RecursiveMode, Watcher};

use crate::error::CliError;
use crate::output;

/// How long the watcher waits for the filesystem to go quiet before it acts.
///
/// An editor saving a file writes it in several steps, and a scan run
/// between two of them reads a file halfway through being written and pushes
/// it. The debounce is what makes a burst of events one scan.
const SETTLE: Duration = Duration::from_millis(250);

/// How often the folder acts with nothing happening.
///
/// A journaled delete becomes a delete when its grace runs out
/// (`folders.md` 15), and nothing on the filesystem marks that moment: the
/// file is already gone. Without a tick, a folder that went quiet after a
/// delete would hold the journal until something else happened.
const TICK: Duration = Duration::from_secs(1);

/// Watches a folder and keeps it in step.
///
/// One path through the scan, and the watcher takes it (`folders.md` 9): the
/// same bytes present at startup and the same bytes arriving while running
/// reach the same item, because the initial pass below and every pass after
/// it are the same call.
pub fn watch(
    dir: &Path,
    server: Server,
    stop_after: Option<Duration>,
    json: bool,
) -> Result<(), CliError> {
    let folder = Folder::open(dir, Some(server))?;
    // Resolved, because the filter below strips this prefix off the paths
    // the watcher reports and macOS reports them resolved: a folder under
    // `/var/folders/...` comes back as `/private/var/folders/...`, every
    // strip fails, every path reads as not dot-led, and the folder wakes
    // itself through its own writes under `.marfa` a few times a second.
    let dir = &std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let (sender, events) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(sender)
        .map_err(|error| CliError::Watch(format!("cannot watch: {error}")))?;
    // Watching starts before the first pass, so a file that arrives during
    // that pass is seen by the watcher rather than falling between the two.
    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|error| CliError::Watch(format!("cannot watch {}: {error}", dir.display())))?;
    eprintln!("watching {} (interrupt to stop)", dir.display());

    let started = Instant::now();
    let mut quiet_since = Instant::now();
    loop {
        if let Some(limit) = stop_after
            && started.elapsed() >= limit
        {
            break;
        }
        match events.recv_timeout(TICK) {
            Ok(Ok(event)) => {
                // `Access` is a read, and a folder does not push a file
                // because somebody opened it.
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                // The folder's own state is never watched (`folders.md` 18),
                // and nor is anything else dot-led (17). The scan excludes
                // them too; this stops a write under `.marfa` from waking a
                // pass that would find nothing.
                if event.paths.iter().all(|path| dot_led(dir, path)) {
                    continue;
                }
                quiet_since = Instant::now();
            }
            Ok(Err(error)) => eprintln!("watch error: {error}"),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // A pass on every tick, not only on a change: a journaled delete
        // becomes a delete when its grace runs out, and nothing on the
        // filesystem marks that. So the only gate is the debounce — an
        // editor writes a file in several steps, and a pass between two of
        // them reads a file halfway through being written and pushes it.
        //
        // There is deliberately no "was there a change" flag beside this.
        // A pass with nothing to do is cheap and says nothing, and a flag
        // that gated the pass would stop the journal ever being swept in a
        // folder that went quiet after a delete.
        if quiet_since.elapsed() < SETTLE {
            continue;
        }
        step(&folder, json)?;
    }
    Ok(())
}

/// One pass: read the folder, send what it queued, write back what came in.
fn step(folder: &Folder, json: bool) -> Result<(), CliError> {
    let scanned = folder.scan()?;
    let drained = folder.core().drain()?;
    let pulled = folder.pull()?;
    // Quiet unless something happened, because a watcher printing a line a
    // second is a watcher nobody reads.
    if scanned == Default::default() && drained.sent == 0 && pulled == Default::default() {
        return Ok(());
    }
    output::report(
        &serde_json::json!({ "scan": scanned, "drain": drained, "pull": pulled }),
        json,
        || {
            // The counts that mean an item has no file are named rather than
            // left out: a watcher that prints zeroes while declining to write
            // is a watcher telling somebody nothing is wrong.
            let held = pulled.unwritten + pulled.collided + pulled.outside;
            format!(
                "{} created, {} updated, {} renamed, {} deleted; sent {}; {} file(s) written{}",
                scanned.created,
                scanned.updated,
                scanned.renamed,
                scanned.deleted,
                drained.sent,
                pulled.written + pulled.rewritten,
                if held > 0 {
                    format!(", {held} not written")
                } else {
                    String::new()
                }
            )
        },
    )
}

/// Whether a path lies under a dot-led directory inside the folder.
fn dot_led(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
}
