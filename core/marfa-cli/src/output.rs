use std::io::{self, Write};

use marfa_core::{Completeness, DrainReport, Item, QueuedWrite, Rows, SearchHit, Shown};
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

/// A local list, `{"items": [...], "completeness": ...}` in JSON. As text, a
/// partial answer says so after its lines.
pub fn listing(listed: Rows<(Item, Shown)>, json: bool) -> Result<(), CliError> {
    let (items, shown): (Vec<_>, Vec<_>) = listed.rows.into_iter().unzip();
    if json {
        return report(
            &serde_json::json!({ "items": items, "completeness": listed.completeness }),
            true,
            String::new,
        );
    }
    item_lines(&items, &shown)?;
    note_partial(listed.completeness);
    Ok(())
}

/// `shown` holds what each item shows, in the same order.
pub fn item_lines(items: &[Item], shown: &[Shown]) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    for (item, shown) in items.iter().zip(shown) {
        writeln!(out, "{}", line(item, shown))?;
    }
    if items.is_empty() {
        eprintln!("(no items)");
    }
    Ok(())
}

/// On stderr, as `(no items)` is, so the lines on stdout stay one per row.
fn note_partial(completeness: Completeness) {
    if completeness == Completeness::Partial {
        eprintln!(
            "(partial: a hydration is filling this copy, and rows still arriving are not shown)"
        );
    }
}

pub fn item(item: &Item, shown: &Shown, json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(item)?)?;
    } else {
        writeln!(out, "{}", line(item, shown))?;
        writeln!(out, "{}", serde_json::to_string_pretty(&item.properties)?)?;
        if !item.tags.is_empty() {
            writeln!(out, "tags: {}", item.tags.join(", "))?;
        }
    }
    Ok(())
}

/// No verdict column: the row has not been sent, and "unanswered" here would
/// read as an answer.
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
            "waiting on {} write(s) it cannot go without",
            write.depends_on.len()
        )?;
    }
    if let Some(ahead) = &write.follows {
        writeln!(
            out,
            "after {ahead}, the write ahead of it to the same row or edge"
        )?;
    }
    Ok(())
}

/// An edit that changed nothing queued no write: `null` in JSON, so a script
/// reads it as no write and not as an error.
pub fn nothing_queued(json: bool) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "null")?;
    } else {
        writeln!(out, "nothing queued: the edit changes nothing")?;
    }
    Ok(())
}

/// `writes` are printed against `queue`, the whole queue, so a write they
/// depend on is read where it stands even when it is not among them. `landing`
/// names the refused creates whose row no read has found yet, which still hold
/// the writes that depend on them, each with the row its natural key names.
pub fn queued(
    writes: &[QueuedWrite],
    queue: &[QueuedWrite],
    landing: &std::collections::HashMap<String, String>,
    json: bool,
) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    if json {
        writeln!(out, "{}", serde_json::to_string_pretty(writes)?)?;
        return Ok(());
    }
    let verdicts: std::collections::HashMap<_, _> = queue
        .iter()
        .map(|write| (write.id.as_str(), write.verdict))
        .collect();
    for write in writes {
        // Not a blank column: a person fills a blank with whichever verdict
        // they expected.
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
        let refusals = match write.refusals {
            0 => String::new(),
            n => format!("  {n}/{} refused", marfa_core::CEILING),
        };
        let refusal = write.refusal.as_ref().map(refused).unwrap_or_default();
        let last_failure = match &write.last_failure {
            Some(failure) => format!("  last answer: {}", failure.describe()),
            None => String::new(),
        };
        // One missing from the whole queue was withdrawn or discarded, and
        // holds nothing.
        let pending: Vec<_> = write
            .depends_on
            .iter()
            .filter(|id| {
                landing.contains_key(id.as_str())
                    || matches!(
                        verdicts.get(id.as_str()),
                        Some(None | Some(marfa_core::Verdict::Blocked))
                    )
            })
            .collect();
        let held = match pending.len() {
            0 => String::new(),
            1 => format!("  waiting on {}", pending[0]),
            n => format!("  waiting on {n} writes"),
        };
        // A row held with nothing it depends on is held by this.
        let after = match &write.follows {
            Some(ahead) => format!("  after {ahead}"),
            None => String::new(),
        };
        let unlanded = match landing.get(&write.id) {
            Some(target) => format!(
                "  its natural key names {target}, which no read has found; \
                 discard it to refuse the writes waiting on it"
            ),
            None => String::new(),
        };
        writeln!(
            out,
            "{}  {}  {}{}{}{}{}{}{}{}",
            write.kind,
            subject,
            verdict,
            reason,
            refusal,
            refusals,
            last_failure,
            held,
            after,
            unlanded
        )?;
    }
    if writes.is_empty() {
        eprintln!("(nothing queued)");
    }
    Ok(())
}

/// A local search, `{"hits": [...], "completeness": ...}` in JSON. As text, a
/// partial answer says so after its lines.
pub fn found(found: Rows<(SearchHit, Shown)>, json: bool) -> Result<(), CliError> {
    let (hits, shown): (Vec<_>, Vec<_>) = found.rows.into_iter().unzip();
    if json {
        return report(
            &serde_json::json!({ "hits": hits, "completeness": found.completeness }),
            true,
            String::new,
        );
    }
    hit_lines(&hits, &shown)?;
    note_partial(found.completeness);
    Ok(())
}

/// `shown` holds what each hit's item shows, in the same order.
fn hit_lines(hits: &[SearchHit], shown: &[Shown]) -> Result<(), CliError> {
    let mut out = io::stdout().lock();
    for (hit, shown) in hits.iter().zip(shown) {
        writeln!(out, "{:>7.3}  {}", hit.score, line(&hit.item, shown))?;
        if !hit.snippet.is_empty() {
            writeln!(
                out,
                "         {}",
                snippet_text(&hit.snippet).replace('\n', " ")
            )?;
        }
    }
    if hits.is_empty() {
        eprintln!("(no matches)");
    }
    Ok(())
}

/// The excerpt as the text it was cut from: the marks dropped and the
/// escapes the core writes read back, `&amp;` last so that escaped text stays
/// text.
fn snippet_text(html: &str) -> String {
    html.replace("<mark>", "")
        .replace("</mark>", "")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn line(item: &Item, shown: &Shown) -> String {
    let title = shown
        .title
        .as_deref()
        .or(shown.body.as_deref())
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

pub fn drain_exit(drain: &DrainReport) -> crate::error::Exit {
    if drain.stopped.is_some() {
        crate::error::Exit::Credential
    } else if drain.unavailable.is_some() || drain.undelivered > 0 {
        crate::error::Exit::Environment
    } else {
        crate::error::Exit::Done
    }
}

pub fn drained(drain: &DrainReport, json: bool) -> Result<(), CliError> {
    report(drain, json, || {
        let mut lines = Vec::new();
        // Printed rather than left out, or a short list would hide that
        // anything was attempted.
        for verdict in &drain.verdicts {
            lines.push(verdict_line(verdict, None, None));
        }
        lines.push(counts(drain));
        let refused = drain
            .verdicts
            .iter()
            .filter(|write| write.verdict == Some(marfa_core::Verdict::Refused))
            .count();
        if refused > 0 {
            lines.push(format!("refused {refused} write(s)"));
        }
        lines.extend(undelivered(drain));
        if let Some(wait) = drain.retry_after_seconds {
            lines.push(format!(
                "the server asked for {wait}s before the next drain"
            ));
        }
        if let Some(stopped) = &drain.stopped {
            lines.push(stopped.clone());
        }
        lines.extend(unclaimed(drain));
        lines.join("\n")
    })
}

/// One write's answer, as `device drain` prints it. A folder names the file
/// the write was for as `subject`, and the file a conflicted copy was made
/// into as `copy`, in place of their ids.
pub fn verdict_line(
    verdict: &marfa_core::DrainVerdict,
    subject: Option<&str>,
    copy: Option<&str>,
) -> String {
    let mut line = format!(
        "{} {} {}",
        verdict
            .verdict
            .map_or("unanswered", marfa_core::Verdict::as_str),
        verdict.kind,
        subject
            .or(verdict.item_id.as_deref())
            .unwrap_or(verdict.id.as_str())
    );
    if let Some(reason) = &verdict.reason {
        line.push_str(&format!(" ({reason})"));
    }
    if let Some(refusal) = &verdict.refusal {
        line.push_str(&refused(refusal));
    }
    if let Some(sibling) = &verdict.conflicted_copy_id {
        line.push_str(&format!(" conflicted copy {}", copy.unwrap_or(sibling)));
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
    line
}

/// What a refusal says beyond its code: the row in the bin, the grant the key
/// lacks, and each field the server would not take.
fn refused(refusal: &marfa_core::Refusal) -> String {
    let mut said = String::new();
    if refusal.trashed {
        said.push_str(" in the bin");
    }
    if let Some(grant) = &refusal.grant {
        let kind = match grant.kind {
            marfa_core::GrantKind::Type => "type",
            marfa_core::GrantKind::EdgeType => "edge type",
            marfa_core::GrantKind::Extension => "extension",
        };
        let level = match grant.level {
            marfa_core::GrantLevel::Read => "read",
            marfa_core::GrantLevel::Write => "write",
        };
        said.push_str(&format!(" needs {level} on the {kind} {}", grant.name));
    }
    for field in &refusal.fields {
        said.push_str(&format!(" {}: {}", field.field, field.message));
    }
    said
}

/// What the server answered in a pass, in words that say what is counted: a
/// write it answered, whatever it said, and of those the items it created. A
/// first sync queues its creates when the folder is added or confirmed, so
/// the scan that runs with the push counts none of them; this is where they
/// show.
pub fn answered_words(drain: &DrainReport) -> String {
    let created = drain
        .verdicts
        .iter()
        .filter(|write| {
            write.kind == marfa_core::WriteKind::CreateItem
                && matches!(
                    write.verdict,
                    Some(marfa_core::Verdict::Accepted | marfa_core::Verdict::Merged)
                )
        })
        .count();
    let mut line = format!("the server answered {} write(s)", drain.answered);
    if created > 0 {
        line.push_str(&format!(", creating {created} item(s)"));
    }
    line
}

/// Writes the pass left unsent because each follows a write that has no
/// answer yet, so a later pass sends them.
pub fn held_words(drain: &DrainReport) -> Option<String> {
    (drain.held > 0).then(|| {
        format!(
            "{} more held back until the write each follows is answered",
            drain.held
        )
    })
}

/// What the server answered in a pass, then the writes it left held back.
pub fn answered_and_held(drain: &DrainReport) -> String {
    let mut line = answered_words(drain);
    if let Some(held) = held_words(drain) {
        line.push_str(&format!("; {held}"));
    }
    line
}

/// Every write the pass came to, but those `stopped` names, which says how
/// many a refused credential parked.
pub fn counts(drain: &DrainReport) -> String {
    let mut line = answered_and_held(drain);
    if drain.unsent > 0 {
        line.push_str(&format!(", {} settled without being sent", drain.unsent));
    }
    if drain.unmade > 0 {
        line.push_str(&format!(
            ", {} whose request could not be made, counted",
            drain.unmade
        ));
    }
    line
}

/// Said apart from the answered count, so writes that went nowhere never
/// read as sent.
pub fn undelivered(drain: &DrainReport) -> Option<String> {
    match (drain.undelivered, &drain.unavailable) {
        (0, None) => None,
        (count, Some(why)) => Some(format!(
            "{count} write(s) not delivered, waiting for the next drain: {why}"
        )),
        (count, None) => Some(format!(
            "{count} write(s) not delivered, waiting for the next drain"
        )),
    }
}

/// The verdicts say `credential_refused`, which alone reads as a key that has
/// stopped working.
pub fn unclaimed(drain: &DrainReport) -> Vec<String> {
    drain
        .unclaimed_sources
        .iter()
        .map(|source| {
            format!(
                "this credential's key does not claim the source {source}, so every create naming it is blocked; \
                 they go on the first drain after the key claims it"
            )
        })
        .collect()
}

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

    pub fn line(&self, text: &str) -> Result<(), CliError> {
        let mut out = io::stdout().lock();
        writeln!(out, "{text}")?;
        Ok(())
    }

    /// Text exactly as given, with nothing added after it.
    pub fn raw(&self, text: &str) -> Result<(), CliError> {
        let mut out = io::stdout().lock();
        out.write_all(text.as_bytes())?;
        out.flush()?;
        Ok(())
    }

    pub fn report(&self, value: &Value, human: impl FnOnce() -> String) -> Result<(), CliError> {
        if self.json {
            self.value(value)
        } else {
            self.line(&human())
        }
    }

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
            if let (Some(purged), Some(failures)) = (
                map.get("purged").and_then(Value::as_u64),
                map.get("failures").and_then(Value::as_array),
            ) {
                let mut text = vec![format!("{purged} items deleted")];
                for failure in failures {
                    text.push(format!(
                        "{}: {}",
                        field(failure, "id"),
                        field(failure, "message")
                    ));
                }
                if failures.iter().any(|failure| {
                    failure
                        .pointer("/details/write_outcome")
                        .and_then(Value::as_str)
                        == Some("unknown")
                }) {
                    text.push("Stopped: a deletion could not be confirmed. Read the trash again before retrying.".into());
                } else if let Some(cursor) = map.get("next_cursor").and_then(Value::as_str) {
                    text.push(format!("more: --cursor {cursor}"));
                }
                return Ok(text.join("\n"));
            }
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
                let tombstones = map.get("tombstones").and_then(Value::as_array);
                let all: Vec<Value> = rows
                    .iter()
                    .chain(tombstones.into_iter().flatten())
                    .cloned()
                    .collect();
                return lines(&all, map);
            }
            // `{counts, results}` and `{items, metadata}`.
            if map.len() <= 2
                && let Some((_, Value::Array(rows))) =
                    map.iter().find(|(_, value)| value.is_array())
            {
                return lines(rows, map);
            }
            if map.len() == 1 && map.get("ok") == Some(&Value::Bool(true)) {
                return Ok("done".into());
            }
            if map.contains_key("id") && (map.contains_key("type") || is_edge(value)) {
                let mut text = record_line(value);
                if let Some(properties) = map.get("properties")
                    && properties
                        .as_object()
                        .is_none_or(|object| !object.is_empty())
                {
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

enum Row {
    Cells(Vec<String>),
    Text(String),
}

fn lines(rows: &[Value], page: &serde_json::Map<String, Value>) -> Result<String, CliError> {
    let mut out: Vec<Row> = Vec::new();
    for row in rows {
        if row.get("id").is_some() {
            out.push(Row::Cells(record_cells(row)));
        } else if let (Some(key), Some(purged)) = (
            row.get("key").and_then(Value::as_str),
            row.get("purged_at").and_then(Value::as_str),
        ) {
            let settled = row.get("settled_at").and_then(Value::as_str).unwrap_or("");
            out.push(Row::Text(format!(
                "tombstone  {key}  purged {purged}  settled {settled}"
            )));
        } else if let (Some(starts), Some(item)) = (row.get("starts_at"), row.get("item")) {
            let ends = row
                .get("ends_at")
                .and_then(Value::as_str)
                .map(|ends| format!(" to {ends}"))
                .unwrap_or_default();
            let mut cells = vec![format!("{}{ends}", starts.as_str().unwrap_or(""))];
            cells.extend(record_cells(item));
            out.push(Row::Cells(cells));
        } else if let Some(item) = row.get("item") {
            let mut cells: Vec<String> = row
                .get("relevance_score")
                .and_then(Value::as_f64)
                .map(|score| format!("{score:>7.3}"))
                .into_iter()
                .collect();
            cells.extend(record_cells(item));
            out.push(Row::Cells(cells));
        } else {
            out.push(Row::Text(serde_json::to_string(row)?));
        }
    }
    let cells: Vec<Vec<String>> = out
        .iter()
        .filter_map(|row| match row {
            Row::Cells(cells) => Some(cells.clone()),
            Row::Text(_) => None,
        })
        .collect();
    let mut aligned = table(&cells).into_iter();
    let mut text: Vec<String> = out
        .into_iter()
        .map(|row| match row {
            Row::Cells(_) => aligned.next().unwrap_or_default(),
            Row::Text(line) => line,
        })
        .collect();
    finish(&mut text, page);
    Ok(text.join("\n"))
}

fn finish(text: &mut Vec<String>, page: &serde_json::Map<String, Value>) {
    if text.is_empty() {
        text.push("(none)".into());
    }
    if let Some(days) = page.get("retention_days").and_then(Value::as_u64) {
        text.push(if days == 0 {
            "retention: automatic deletion off".into()
        } else {
            format!("retention: {days} days")
        });
    }
    if let Some(cursor) = page.get("next_cursor").and_then(Value::as_str) {
        text.push(format!("more: --cursor {cursor}"));
    }
}

fn table(rows: &[Vec<String>]) -> Vec<String> {
    let width = |cell: &str| cell.chars().count();
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let shown: Vec<(usize, usize)> = (0..columns)
        .filter_map(|column| {
            let widest = rows
                .iter()
                .filter_map(|row| row.get(column))
                .map(|cell| width(cell))
                .max()
                .unwrap_or(0);
            (widest > 0).then_some((column, widest))
        })
        .collect();
    rows.iter()
        .map(|row| {
            let mut line = String::new();
            for (position, (column, widest)) in shown.iter().enumerate() {
                let cell = row.get(*column).map_or("", String::as_str);
                if position > 0 {
                    line.push_str("  ");
                }
                line.push_str(cell);
                if position + 1 < shown.len() {
                    line.push_str(&" ".repeat(widest - width(cell)));
                }
            }
            line.trim_end().to_string()
        })
        .collect()
}

fn is_edge(record: &Value) -> bool {
    ["edge_type", "source_id", "target_id"]
        .iter()
        .all(|name| record.get(name).is_some())
}

fn field<'a>(record: &'a Value, name: &str) -> &'a str {
    record.get(name).and_then(Value::as_str).unwrap_or("")
}

fn record_title(record: &Value) -> &str {
    let property = |name: &str| {
        record
            .get("properties")
            .and_then(|properties| properties.get(name))
            .and_then(Value::as_str)
    };
    property("title")
        .or_else(|| property("name"))
        .or_else(|| property("body"))
        .or_else(|| record.get("label").and_then(Value::as_str))
        .or_else(|| record.get("url").and_then(Value::as_str))
        .unwrap_or("")
        .lines()
        .next()
        .unwrap_or("")
}

fn record_line(record: &Value) -> String {
    table(&[record_cells(record)]).remove(0)
}

fn record_cells(record: &Value) -> Vec<String> {
    let owned = |name: &str| field(record, name).to_string();
    if is_edge(record) {
        return vec![
            owned("id"),
            owned("edge_type"),
            owned("created_at"),
            format!("{} -> {}", owned("source_id"), owned("target_id")),
        ];
    }
    if record.get("key_id").is_some() && record.get("last_run").is_some() {
        let run = record.get("last_run").filter(|run| !run.is_null());
        let outcome = run.map_or("never run", |run| field(run, "outcome"));
        let when = run.map_or("", |run| field(run, "finished_at"));
        let said = run.map_or("", run_note);
        return vec![
            owned("id"),
            owned("source"),
            owned("name"),
            outcome.to_string(),
            when.to_string(),
            said.to_string(),
        ];
    }
    if record.get("connector_id").is_some() && record.get("outcome").is_some() {
        return vec![
            owned("id"),
            owned("outcome"),
            owned("finished_at"),
            run_note(record).to_string(),
        ];
    }
    if record.get("webhook_id").is_some() && record.get("event_type").is_some() {
        let attempts = record.get("attempt").and_then(Value::as_u64).unwrap_or(0);
        return vec![
            owned("id"),
            owned("status"),
            owned("event_type"),
            format!("{attempts} attempt{}", if attempts == 1 { "" } else { "s" }),
            delivery_answer(record),
        ];
    }
    if record.get("trashed_at").is_some() {
        return vec![
            owned("id"),
            owned("type"),
            format!("v{}", record["version"]),
            owned("trashed_at"),
            record
                .get("eligible_for_deletion_at")
                .and_then(Value::as_str)
                .map(|at| format!("eligible from {at}"))
                .unwrap_or_else(|| "automatic deletion date unavailable; see retention".into()),
            owned("name"),
            record
                .get("trashed_by")
                .map(|by| field(by, "name"))
                .filter(|name| !name.is_empty())
                .unwrap_or("Not recorded")
                .to_string(),
        ];
    }
    if record.get("name").is_some()
        && record.get("version").is_some()
        && record.get("properties").is_none()
    {
        return vec![
            owned("id"),
            owned("type"),
            format!("v{}", record["version"]),
            owned("created_at"),
            owned("name"),
            owned("source"),
        ];
    }
    let kind = ["type", "action"]
        .iter()
        .map(|name| owned(name))
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    let when = ["occurred_at", "created_at"]
        .iter()
        .map(|name| owned(name))
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    let state = owned("state");
    vec![
        owned("id"),
        kind,
        when,
        record_title(record).to_string(),
        if state.is_empty() || state == "active" {
            String::new()
        } else {
            format!("[{state}]")
        },
    ]
}

/// What the receiver last said, for a delivery: its HTTP status, why the
/// attempt failed, or that no attempt has recorded an answer.
fn delivery_answer(delivery: &Value) -> String {
    let status = delivery
        .get("status_code")
        .and_then(Value::as_u64)
        .map(|code| format!("HTTP {code}"));
    let error = delivery
        .get("error")
        .and_then(Value::as_str)
        .filter(|error| Some(*error) != status.as_deref());
    match (status, error) {
        (Some(status), Some(error)) => format!("{status}: {error}"),
        (Some(status), None) => status,
        (None, Some(error)) => error.to_string(),
        (None, None) => "no answer yet".to_string(),
    }
}

fn run_note(run: &Value) -> &str {
    match field(run, "error") {
        "" => field(run, "summary"),
        error => error,
    }
}

pub fn edges_from(
    page: &Value,
    inbound: bool,
    titles: &std::collections::HashMap<String, String>,
) -> String {
    let empty = serde_json::Map::new();
    let map = page.as_object().unwrap_or(&empty);
    let rows: Vec<Vec<String>> = map
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|edge| {
            let other = other_end(edge, inbound);
            vec![
                field(edge, "id").to_string(),
                field(edge, "edge_type").to_string(),
                field(edge, "created_at").to_string(),
                format!("{} {other}", if inbound { "<-" } else { "->" }),
                titles.get(other).cloned().unwrap_or_default(),
            ]
        })
        .collect();
    let mut text = table(&rows);
    finish(&mut text, map);
    text.join("\n")
}

pub fn other_end(edge: &Value, inbound: bool) -> &str {
    field(edge, if inbound { "source_id" } else { "target_id" })
}

pub fn titles(answer: &Value) -> impl Iterator<Item = (String, String)> + '_ {
    answer
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| {
            (
                field(item, "id").to_string(),
                record_title(item).to_string(),
            )
        })
}

/// One line per link and embed: what the body carries, then what it names.
pub fn body_links(links: &marfa_core::BodyLinks) -> String {
    let named = |target: &marfa_core::BodyTarget| match target {
        marfa_core::BodyTarget::Item { id } => id.clone(),
        marfa_core::BodyTarget::Pending => "pending: not yet looked up on the server".into(),
        marfa_core::BodyTarget::Missing => "missing: names no item".into(),
        marfa_core::BodyTarget::Ambiguous => "ambiguous: names more than one item".into(),
        marfa_core::BodyTarget::Refused { reason } => format!("refused: {reason}"),
    };
    let lines: Vec<String> = links
        .links
        .iter()
        .chain(&links.embeds)
        .map(|name| format!("{}\t{}", name.text, named(&name.target)))
        .collect();
    if lines.is_empty() {
        "the body carries no link or embed of a file".into()
    } else {
        lines.join("\n")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;

    use super::{answered_words, counts, describe, edges_from, snippet_text};
    use marfa_core::{DrainReport, DrainVerdict, Verdict, WriteKind};
    use serde_json::json;

    pub(crate) fn verdict(kind: WriteKind, verdict: Option<Verdict>) -> DrainVerdict {
        DrainVerdict {
            id: "write".into(),
            kind,
            item_id: Some("item".into()),
            edge_id: None,
            verdict,
            reason: None,
            refusal: None,
            conflicted_copy_id: None,
            refusals: 0,
            replayed: false,
            merged_fields: Vec::new(),
        }
    }

    pub(crate) fn pass(answered: usize, held: usize, verdicts: Vec<DrainVerdict>) -> DrainReport {
        DrainReport {
            answered,
            held,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            verdicts,
            stopped: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        }
    }

    #[test]
    fn a_pass_says_what_the_server_answered_and_how_many_items_that_created() {
        let report = pass(
            4,
            0,
            vec![
                verdict(WriteKind::CreateItem, Some(Verdict::Accepted)),
                verdict(WriteKind::CreateItem, Some(Verdict::Accepted)),
                verdict(WriteKind::CreateItem, Some(Verdict::Refused)),
                verdict(WriteKind::UpdateItem, Some(Verdict::Accepted)),
            ],
        );
        assert_eq!(
            answered_words(&report),
            "the server answered 4 write(s), creating 2 item(s)"
        );
        assert_eq!(
            counts(&report),
            "the server answered 4 write(s), creating 2 item(s)"
        );
        assert_eq!(
            counts(&pass(1, 0, vec![verdict(WriteKind::UpdateItem, None)])),
            "the server answered 1 write(s)"
        );
    }

    #[test]
    fn held_writes_are_said_as_waiting_on_a_write_with_no_answer_yet() {
        let said = counts(&pass(1101, 12377, Vec::new()));
        assert_eq!(
            said,
            "the server answered 1101 write(s); 12377 more held back until the write each follows is answered"
        );
        assert!(!said.contains("held 12377"), "{said}");
    }

    #[test]
    fn summary_lists_show_the_name_and_version_needed_for_an_action() {
        let row = json!({"id":"item-one", "type":"core.note", "version":3, "name":"Shopping list", "source":"notes", "created_at":"2026-01-01T00:00:00Z"});
        let text = describe(&json!({"data":[row], "next_cursor":null})).unwrap();
        assert!(text.contains("Shopping list"));
        assert!(text.contains("v3"));
    }

    #[test]
    fn uncertain_trash_batch_reports_unknown_without_continuation() {
        let text = describe(&json!({"purged":1,"failures":[{"id":"one","message":"Refresh before retrying", "details":{"write_outcome":"unknown"}}], "next_cursor":"unsafe"})).unwrap();
        assert!(text.contains("1 items deleted"));
        assert!(text.contains("deletion could not be confirmed"));
        assert!(!text.contains("--cursor"));
    }

    #[test]
    fn trash_lists_show_deletion_identity_version_and_retention() {
        let text = describe(&json!({"data":[{"id":"item-one", "type":"core.note", "version":3, "name":"Shopping list", "trashed_at":"2026-01-02T00:00:00Z", "eligible_for_deletion_at":"2026-02-01T00:00:00Z", "trashed_by":{"name":"Notes app"}}], "next_cursor":null, "retention_days":30})).unwrap();
        for word in [
            "Shopping list",
            "v3",
            "Notes app",
            "2026-01-02",
            "retention: 30 days",
            "eligible from 2026-02-01T00:00:00Z",
        ] {
            assert!(text.contains(word), "missing {word}: {text}");
        }
        assert!(
            describe(&json!({"data":[], "next_cursor":null, "retention_days":0}))
                .unwrap()
                .contains("retention: automatic deletion off")
        );
    }

    #[test]
    fn a_snippet_prints_as_the_text_it_was_cut_from() {
        assert_eq!(
            snippet_text(
                "&lt;b&gt;<mark>numbat</mark>&lt;/b&gt; &amp;lt; &amp; &quot;q&quot; &#39;p&#39; &lt;mark&gt;"
            ),
            "<b>numbat</b> &lt; & \"q\" 'p' <mark>"
        );
    }

    #[test]
    fn drain_exit_distinguishes_undelivered_held_and_credential_stopped() {
        use crate::error::Exit;
        let mut report = marfa_core::DrainReport {
            answered: 0,
            held: 1,
            undelivered: 0,
            unsent: 0,
            unmade: 0,
            unavailable: None,
            verdicts: Vec::new(),
            stopped: None,
            unclaimed_sources: Vec::new(),
            retry_after_seconds: None,
        };
        assert_eq!(super::drain_exit(&report), Exit::Done);
        report.undelivered = 1;
        assert_eq!(super::drain_exit(&report), Exit::Environment);
        report.stopped = Some("credential refused".into());
        assert_eq!(super::drain_exit(&report), Exit::Credential);
    }

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
            "2026-01-02T09:00:00Z to 2026-01-02T10:00:00Z  e1  core.event  Standup"
        );
    }

    #[test]
    fn a_lookup_names_the_tombstones_beside_the_rows() {
        let tombstone = json!({
            "key": "v2",
            "purged_at": "2026-01-01T00:00:00.000Z",
            "settled_at": "2026-01-02T00:00:00.000Z",
        });
        let text = describe(&json!({
            "data": [{"id": "i1", "type": "user.issue", "created_at": "2026-01-01T00:00:00Z"}],
            "tombstones": [tombstone],
        }))
        .unwrap();
        assert_eq!(
            text,
            "i1  user.issue  2026-01-01T00:00:00Z\n\
             tombstone  v2  purged 2026-01-01T00:00:00.000Z  settled 2026-01-02T00:00:00.000Z"
        );
        let purged_only = describe(&json!({"data": [], "tombstones": [tombstone]})).unwrap();
        assert_eq!(
            purged_only,
            "tombstone  v2  purged 2026-01-01T00:00:00.000Z  settled 2026-01-02T00:00:00.000Z"
        );
        let moved = describe(&json!({"tombstones": [tombstone]})).unwrap();
        assert_eq!(moved, purged_only);
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
        assert_eq!(text, "  1.500  n1  core.note  Wombat");
    }

    fn edge(id: &str, source: &str, target: &str) -> serde_json::Value {
        json!({
            "id": id,
            "source_id": source,
            "target_id": target,
            "edge_type": "references",
            "properties": {},
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "version": 1,
        })
    }

    #[test]
    fn an_items_edges_name_the_other_end_and_what_it_is_called() {
        let page = json!({
            "data": [edge("e1", "a", "b"), edge("e2", "a", "c")],
            "next_cursor": null,
        });
        let titles = HashMap::from([("b".to_string(), "Wombat".to_string())]);
        assert_eq!(
            edges_from(&page, false, &titles),
            "e1  references  2026-01-01T00:00:00Z  -> b  Wombat\n\
             e2  references  2026-01-01T00:00:00Z  -> c"
        );
        assert_eq!(
            edges_from(&page, true, &HashMap::new()),
            "e1  references  2026-01-01T00:00:00Z  <- a\n\
             e2  references  2026-01-01T00:00:00Z  <- a"
        );
    }

    #[test]
    fn an_edge_names_both_ends_where_no_item_is_the_point_of_view() {
        let text = describe(&json!({"edge": edge("e1", "a", "b"), "acknowledged": false})).unwrap();
        assert_eq!(text, "e1  references  2026-01-01T00:00:00Z  a -> b");
    }

    #[test]
    fn a_door_that_answers_only_ok_reads_as_done() {
        assert_eq!(describe(&json!({"ok": true})).unwrap(), "done");
    }

    #[test]
    fn a_listing_lines_up_its_columns_and_leaves_out_empty_ones() {
        let text = describe(&json!({
            "data": [
                {"id": "core.bookmark", "label": "Bookmark", "fields": {}, "version": 1},
                {"id": "core.entity.person", "label": "Person", "fields": {}, "version": 1},
            ],
            "next_cursor": null,
        }))
        .unwrap();
        assert_eq!(
            text,
            "core.bookmark       Bookmark\n\
             core.entity.person  Person"
        );
    }

    #[test]
    fn a_person_is_called_by_its_name() {
        let text = describe(&json!({
            "data": [{
                "id": "p1",
                "type": "core.entity.person",
                "created_at": "2026-01-01T00:00:00Z",
                "properties": {"name": "Ada"},
            }],
            "next_cursor": null,
        }))
        .unwrap();
        assert_eq!(text, "p1  core.entity.person  2026-01-01T00:00:00Z  Ada");
    }

    #[test]
    fn a_connector_shows_its_source_name_and_last_run() {
        let text = describe(&json!({
            "data": [
                {
                    "id": "c1", "key_id": "k1", "source": "github", "name": "Issues",
                    "last_run": {
                        "id": "r1", "connector_id": "c1", "outcome": "failed",
                        "started_at": "2026-01-01T00:00:00Z",
                        "finished_at": "2026-01-01T00:01:00Z",
                        "summary": null, "error": "rate limited",
                    },
                },
                {"id": "c2", "key_id": "k1", "source": "linear", "name": "Tickets", "last_run": null},
            ],
            "next_cursor": null,
        }))
        .unwrap();
        assert_eq!(
            text,
            "c1  github  Issues   failed     2026-01-01T00:01:00Z  rate limited\n\
             c2  linear  Tickets  never run"
        );
    }

    #[test]
    fn a_delivery_shows_its_status_event_attempts_and_last_answer() {
        use serde_json::Value;
        let delivery = |id: &str, status: &str, code: Value, attempt: u64, error: Value| {
            json!({
                "id": id, "webhook_id": "w1", "event_type": "item.created",
                "status": status, "status_code": code, "attempt": attempt,
                "succeeded": status == "success", "error": error,
                "created_at": "2026-01-01T00:00:00Z",
            })
        };
        let text = describe(&json!({
            "data": [
                delivery("d1", "dead_letter", json!(503), 9, json!("Max attempts reached")),
                delivery("d2", "dead_letter", json!(404), 1, json!("HTTP 404")),
                delivery("d3", "dead_letter", Value::Null, 2, json!("The receiver could not be reached.")),
                delivery("d4", "success", json!(204), 1, Value::Null),
                delivery("d5", "pending", Value::Null, 0, Value::Null),
            ],
            "next_cursor": null,
        }))
        .unwrap();
        assert_eq!(
            text,
            "d1  dead_letter  item.created  9 attempts  HTTP 503: Max attempts reached\n\
             d2  dead_letter  item.created  1 attempt   HTTP 404\n\
             d3  dead_letter  item.created  2 attempts  The receiver could not be reached.\n\
             d4  success      item.created  1 attempt   HTTP 204\n\
             d5  pending      item.created  0 attempts  no answer yet"
        );
    }

    #[test]
    fn a_connector_run_shows_its_outcome_time_and_summary() {
        let text = describe(&json!({
            "data": [{
                "id": "r1", "connector_id": "c1", "outcome": "succeeded",
                "started_at": "2026-01-01T00:00:00Z",
                "finished_at": "2026-01-01T00:01:00Z",
                "summary": "12 created, 3 updated", "error": null,
            }],
            "next_cursor": null,
        }))
        .unwrap();
        assert_eq!(
            text,
            "r1  succeeded  2026-01-01T00:01:00Z  12 created, 3 updated"
        );
    }
}

/// `text` with each control character and bidirectional formatting character
/// escaped as `\u{..}`, so text a server holds, such as a name an app chose,
/// cannot move the cursor, erase a line or reorder what follows it.
pub fn printable(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}') {
                c.escape_unicode().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

#[cfg(test)]
mod printable_tests {
    use super::printable;

    #[test]
    fn escapes_control_and_bidirectional_characters_and_keeps_the_rest() {
        assert_eq!(printable("a\r\u{1b}[2Kb"), "a\\u{d}\\u{1b}[2Kb");
        assert_eq!(printable("line\nnext\u{85}"), "line\\u{a}next\\u{85}");
        assert_eq!(printable("evil\u{202e}txt.exe"), "evil\\u{202e}txt.exe");
        assert_eq!(printable("x\u{2068}y"), "x\\u{2068}y");
        assert_eq!(printable("Café naïve \u{1F600}"), "Café naïve \u{1F600}");
    }
}
