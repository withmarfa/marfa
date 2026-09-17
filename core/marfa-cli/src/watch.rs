use std::path::Path;
use std::sync::mpsc;

use marfa_core::CoreError;
use notify::{Event, EventKind, RecursiveMode, Watcher};

/// Prints every change under `dir` until the process is interrupted.
pub fn watch(dir: &Path) -> Result<(), CoreError> {
    if !dir.is_dir() {
        return Err(CoreError::Invalid(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    let (sender, events) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(sender)
        .map_err(|error| CoreError::Invalid(format!("cannot watch: {error}")))?;
    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|error| CoreError::Invalid(format!("cannot watch {}: {error}", dir.display())))?;
    eprintln!("watching {} (interrupt to stop)", dir.display());
    for event in events {
        match event {
            Ok(event) => {
                let kind = match event.kind {
                    EventKind::Create(_) => "create",
                    EventKind::Modify(_) => "modify",
                    EventKind::Remove(_) => "remove",
                    EventKind::Access(_) => continue,
                    EventKind::Any | EventKind::Other => "other",
                };
                for path in &event.paths {
                    println!("{kind}  {}", path.display());
                }
            }
            Err(error) => eprintln!("watch error: {error}"),
        }
    }
    Ok(())
}
