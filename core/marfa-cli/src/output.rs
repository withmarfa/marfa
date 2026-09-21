use std::io::{self, Write};

use marfa_core::{Item, QueuedWrite, SearchHit};
use serde::Serialize;

use crate::error::CliError;

pub fn report<T: Serialize>(
    value: &T,
    json: bool,
    human: impl FnOnce() -> String,
) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(value)?)?;
    } else {
        writeln!(out, "{}", human())?;
    }
    Ok(())
}

pub fn items(items: &[Item], json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(items)?)?;
        return Ok(());
    }
    for item in items {
        writeln!(out, "{}", line(item))?;
    }
    if items.is_empty() {
        eprintln!("(no items)");
    }
    Ok(())
}

pub fn item(item: &Item, json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(item)?)?;
    } else {
        writeln!(out, "{}", line(item))?;
        writeln!(out, "{}", serde_json::to_string_pretty(&item.properties)?)?;
        if !item.tags.is_empty() {
            writeln!(out, "tags: {}", item.tags.join(", "))?;
        }
    }
    Ok(())
}

pub fn queued(writes: &[QueuedWrite], json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(writes)?)?;
        return Ok(());
    }
    for write in writes {
        // A row with no verdict is printed as unanswered rather than as a
        // blank column. It is the absence of an answer, not a seventh
        // verdict, and a person reading a blank space fills it in with
        // whichever of the six they were expecting.
        let verdict = write.verdict.as_deref().unwrap_or("unanswered");
        let reason = match &write.reason {
            Some(reason) => format!(" ({reason})"),
            None => String::new(),
        };
        let subject = write
            .item_id
            .as_deref()
            .or(write.edge_id.as_deref())
            .unwrap_or("-");
        // The two things a person acts on, and neither is visible from the
        // verdict alone: how close a row is to the ceiling of five
        // (`queue-and-verdicts.md` 25), and what is holding it (24). Shown
        // only when they say something, so an ordinary queue stays readable.
        let refusals = match write.refusals {
            0 => String::new(),
            n => format!("  {n}/5 refused"),
        };
        let held = match write.depends_on.len() {
            0 => String::new(),
            1 => format!("  waiting on {}", write.depends_on[0]),
            n => format!("  waiting on {n} writes"),
        };
        writeln!(
            out,
            "{}  {}  {}{}{}{}",
            write.kind, subject, verdict, reason, refusals, held
        )?;
    }
    if writes.is_empty() {
        eprintln!("(nothing queued)");
    }
    Ok(())
}

pub fn hits(hits: &[SearchHit], json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(hits)?)?;
        return Ok(());
    }
    for hit in hits {
        writeln!(out, "{:>7.3}  {}", hit.score, line(&hit.item))?;
        if !hit.snippet.is_empty() {
            writeln!(out, "         {}", hit.snippet.replace('\n', " "))?;
        }
    }
    if hits.is_empty() {
        eprintln!("(no matches)");
    }
    Ok(())
}

fn line(item: &Item) -> String {
    let title = item
        .title(None)
        .or_else(|| item.properties.get("body").and_then(|body| body.as_str()))
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("");
    format!(
        "{}  {}  {}  {}{}",
        item.id,
        item.r#type,
        item.occurred_at,
        title,
        if item.state.as_str() == "active" {
            String::new()
        } else {
            format!("  [{}]", item.state)
        }
    )
}
