use std::io::{self, Write};

use marfa_core::{DrainReport, Item, QueuedWrite, SearchHit};
use serde::Serialize;
use serde_json::Value;

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

/// One line for a command that runs and reports as it goes: compact JSON,
/// flushed, so a reader can take each line as it arrives.
pub fn line_of<T: Serialize>(
    value: &T,
    json: bool,
    human: impl FnOnce() -> String,
) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string(value)?)?;
    } else {
        writeln!(out, "{}", human())?;
    }
    out.flush()?;
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
        let verdict = write
            .verdict
            .map_or("unanswered", marfa_core::Verdict::as_str);
        let reason = match &write.reason {
            Some(reason) => format!(" ({reason})"),
            None => String::new(),
        };
        let subject = write
            .item_id
            .as_deref()
            .or(write.edge_id.as_deref())
            .or(write.blob.as_deref())
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
                verdict
                    .verdict
                    .map_or("unanswered", marfa_core::Verdict::as_str),
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

// The direct surface prints the server's answer as it came. Under `--json`
// it is pretty-printed and nothing else, so an agent reads the same document
// a client would; without it, a listing is one line per record and a single
// record is its line and its properties, which is what a person scans.

pub struct Printer {
    pub json: bool,
}

impl Printer {
    pub fn value(&self, value: &Value) -> Result<(), CliError> {
        let mut out = io::stdout().lock();
        if self.json {
            writeln!(out, "{}", serde_json::to_string_pretty(value)?)?;
        } else {
            writeln!(out, "{}", describe(value)?)?;
        }
        Ok(())
    }

    /// One line, the same under both modes, for a report that is already a
    /// sentence.
    pub fn line(&self, text: &str) -> Result<(), CliError> {
        let mut out = io::stdout().lock();
        writeln!(out, "{text}")?;
        Ok(())
    }

    /// A report built by the binary: JSON under `--json`, the sentence
    /// otherwise.
    pub fn report(&self, value: &Value, human: impl FnOnce() -> String) -> Result<(), CliError> {
        if self.json {
            self.value(value)
        } else {
            self.line(&human())
        }
    }

    /// One record of a stream: compact JSON on one line under `--json`, so
    /// a reader takes the output a line at a time, the sentence otherwise.
    pub fn record(&self, value: &Value, human: impl FnOnce() -> String) -> Result<(), CliError> {
        let mut out = io::stdout().lock();
        if self.json {
            writeln!(out, "{}", serde_json::to_string(value)?)?;
        } else {
            writeln!(out, "{}", human())?;
        }
        out.flush()?;
        Ok(())
    }
}

fn describe(value: &Value) -> Result<String, CliError> {
    match value {
        Value::Object(map) => {
            // The write and read doors answer `{item, ...}` and `{edge}`;
            // the record is what a person is looking at, and the rest of
            // the envelope is named after it where it says something.
            for key in ["item", "edge"] {
                if let Some(record) = map.get(key) {
                    let mut text = describe(record)?;
                    if let Some(resolution) = map.get("conflict_resolution") {
                        text.push_str(&format!(
                            "\nconflict resolution: {}",
                            serde_json::to_string(resolution)?
                        ));
                    }
                    if map.get("acknowledged") == Some(&Value::Bool(true)) {
                        text.push_str("\nacknowledged: the server already held this write");
                    }
                    return Ok(text);
                }
            }
            if let Some(Value::Array(rows)) = map.get("data") {
                return lines(rows, map);
            }
            // A bulk write's per-entry outcomes, `{counts, results}`, and
            // `items bulk-get`'s `{items, metadata}`.
            if map.len() <= 2
                && let Some((_, Value::Array(rows))) =
                    map.iter().find(|(_, value)| value.is_array())
            {
                return lines(rows, map);
            }
            if map.contains_key("id") && map.contains_key("type") {
                let mut text = record_line(value);
                if let Some(properties) = map.get("properties") {
                    text.push('\n');
                    text.push_str(&serde_json::to_string_pretty(properties)?);
                }
                if let Some(Value::Array(tags)) = map.get("tags")
                    && !tags.is_empty()
                {
                    let tags: Vec<&str> = tags.iter().filter_map(Value::as_str).collect();
                    text.push_str(&format!("\ntags: {}", tags.join(", ")));
                }
                return Ok(text);
            }
            Ok(serde_json::to_string_pretty(value)?)
        }
        Value::Null => Ok("done".into()),
        other => Ok(other.to_string()),
    }
}

fn lines(rows: &[Value], page: &serde_json::Map<String, Value>) -> Result<String, CliError> {
    let mut text: Vec<String> = Vec::new();
    for row in rows {
        if row.get("id").is_some() {
            text.push(record_line(row));
        } else if let (Some(starts), Some(item)) = (row.get("starts_at"), row.get("item")) {
            // An occurrence: when it falls is the point of the view.
            let ends = row
                .get("ends_at")
                .and_then(Value::as_str)
                .map(|ends| format!(" to {ends}"))
                .unwrap_or_default();
            text.push(format!(
                "{}{ends}  {}",
                starts.as_str().unwrap_or(""),
                record_line(item)
            ));
        } else if let Some(item) = row.get("item") {
            // A search hit or a listing row carrying its metadata; a hit
            // leads with its score.
            let score = row
                .get("relevance_score")
                .and_then(Value::as_f64)
                .map(|score| format!("{score:>7.3}  "))
                .unwrap_or_default();
            text.push(format!("{score}{}", record_line(item)));
        } else {
            text.push(serde_json::to_string(row)?);
        }
    }
    if text.is_empty() {
        text.push("(none)".into());
    }
    if let Some(cursor) = page.get("next_cursor").and_then(Value::as_str) {
        text.push(format!("more: --cursor {cursor}"));
    }
    Ok(text.join("\n"))
}

/// One record on one line: the id, then what identifies it, then a state
/// if it is not the ordinary one.
fn record_line(record: &Value) -> String {
    let field = |name: &str| record.get(name).and_then(Value::as_str).unwrap_or("");
    let properties = record.get("properties");
    let title = properties
        .and_then(|properties| properties.get("title"))
        .and_then(Value::as_str)
        .or_else(|| {
            properties
                .and_then(|properties| properties.get("body"))
                .and_then(Value::as_str)
        })
        .or_else(|| record.get("label").and_then(Value::as_str))
        .or_else(|| record.get("url").and_then(Value::as_str))
        .or_else(|| record.get("edge_type").and_then(Value::as_str))
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("");
    let kind = if !field("type").is_empty() {
        field("type")
    } else if !field("edge_type").is_empty() {
        field("edge_type")
    } else {
        field("action")
    };
    let when = ["occurred_at", "created_at"]
        .iter()
        .map(|name| field(name))
        .find(|value| !value.is_empty())
        .unwrap_or("");
    let state = field("state");
    let mut line = format!("{}  {}  {}  {}", field("id"), kind, when, title)
        .trim_end()
        .to_string();
    if !state.is_empty() && state != "active" {
        line.push_str(&format!("  [{state}]"));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::describe;
    use serde_json::json;

    #[test]
    fn a_page_with_a_cursor_names_how_to_continue() {
        let text = describe(&json!({
            "data": [{"id": "i1", "type": "core.note", "created_at": "2026-01-01T00:00:00Z"}],
            "next_cursor": "c2",
        }))
        .unwrap();
        assert_eq!(
            text,
            "i1  core.note  2026-01-01T00:00:00Z\nmore: --cursor c2"
        );
    }

    #[test]
    fn the_last_page_names_no_cursor() {
        let text = describe(&json!({"data": [], "next_cursor": null})).unwrap();
        assert_eq!(text, "(none)");
    }

    #[test]
    fn an_occurrence_leads_with_when_it_falls() {
        let text = describe(&json!({
            "data": [{
                "starts_at": "2026-01-02T09:00:00Z",
                "ends_at": "2026-01-02T10:00:00Z",
                "item": {"id": "e1", "type": "core.event", "properties": {"title": "Standup"}},
            }],
            "next_cursor": null,
            "window": {},
            "scan": {},
        }))
        .unwrap();
        assert_eq!(
            text,
            "2026-01-02T09:00:00Z to 2026-01-02T10:00:00Z  e1  core.event    Standup"
        );
    }

    #[test]
    fn a_search_hit_leads_with_its_score() {
        let text = describe(&json!({
            "data": [{
                "item": {"id": "n1", "type": "core.note", "properties": {"title": "Wombat"}},
                "relevance_score": 1.5,
            }],
            "next_cursor": null,
        }))
        .unwrap();
        assert_eq!(text, "  1.500  n1  core.note    Wombat");
    }
}
