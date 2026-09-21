use std::io::{self, Write};

use marfa_core::{DrainReport, Item, QueuedWrite, SearchHit};
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

/// One queued write, as the command that queued it reports it.
///
/// The id and the kind, because a caller who has just queued something needs
/// the handle to ask about it again, and nothing about a verdict: this row
/// has not been sent, and printing a verdict column here would invite reading
/// "unanswered" as an answer.
pub fn queued_one(write: &QueuedWrite, json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(write)?)?;
        return Ok(());
    }
    writeln!(
        out,
        "queued {} {} as {}",
        write.kind,
        write.item_id.as_deref().unwrap_or("-"),
        write.id
    )?;
    if !write.depends_on.is_empty() {
        writeln!(
            out,
            "waiting on {} earlier write(s) to the same row",
            write.depends_on.len()
        )?;
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
            n => format!("  {n}/{} refused", marfa_core::CEILING),
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

/// What a drain did, one line per write it sent.
pub fn drained(drain: &DrainReport, json: bool) -> Result<(), CliError> {
    report(drain, json, || {
        let mut lines = Vec::new();
        for verdict in &drain.verdicts {
            // An unanswered row is a row the drain sent and the server did
            // not answer. Printed as such rather than left out: a caller
            // reading only the answered rows would see a short list and no
            // sign that anything was attempted.
            let mut line = format!(
                "{} {} {}",
                verdict.verdict.as_deref().unwrap_or("unanswered"),
                verdict.kind,
                verdict.item_id.as_deref().unwrap_or(verdict.id.as_str())
            );
            if let Some(reason) = &verdict.reason {
                line.push_str(&format!(" ({reason})"));
            }
            if let Some(sibling) = &verdict.conflicted_copy_id {
                line.push_str(&format!(" conflicted copy {sibling}"));
            }
            if !verdict.merged_fields.is_empty() {
                line.push_str(&format!(" merged {}", verdict.merged_fields.join(",")));
            }
            if verdict.replayed {
                line.push_str(" (answered from the record)");
            }
            if verdict.refusals > 0 {
                line.push_str(&format!(" [{} refusal(s)]", verdict.refusals));
            }
            lines.push(line);
        }
        lines.push(format!("sent {}, held {}", drain.sent, drain.held));
        if let Some(wait) = drain.retry_after_seconds {
            lines.push(format!(
                "the server asked for {wait}s before the next drain"
            ));
        }
        if let Some(stopped) = &drain.stopped {
            lines.push(stopped.clone());
        }
        lines.join("\n")
    })
}
