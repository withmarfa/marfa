use std::io::{self, Write};
use std::path::Path;
use std::sync::mpsc;

use notify::{Event, EventKind, RecursiveMode, Watcher};

use crate::error::CliError;

pub fn watch(dir: &Path) -> Result<(), CliError> {
    if !dir.is_dir() {
        return Err(CliError::Watch(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    let (sender, events) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(sender)
        .map_err(|error| CliError::Watch(format!("cannot watch: {error}")))?;
    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|error| CliError::Watch(format!("cannot watch {}: {error}", dir.display())))?;
    eprintln!("watching {} (interrupt to stop)", dir.display());
    let mut out = io::stdout().lock();
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
                    writeln!(out, "{kind}  {}", path.display())?;
                }
                out.flush()?;
            }
            Err(error) => eprintln!("watch error: {error}"),
        }
    }
    Ok(())
}
