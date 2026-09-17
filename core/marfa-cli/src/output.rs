use marfa_core::{CoreError, Item, SearchHit};
use serde::Serialize;

pub fn report<T: Serialize>(
    value: &T,
    json: bool,
    human: impl FnOnce() -> String,
) -> Result<(), CoreError> {
    if json {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        println!("{}", human());
    }
    Ok(())
}

pub fn items(items: &[Item], json: bool) -> Result<(), CoreError> {
    if json {
        println!("{}", serde_json::to_string_pretty(items)?);
        return Ok(());
    }
    for item in items {
        println!("{}", line(item));
    }
    if items.is_empty() {
        eprintln!("(no items)");
    }
    Ok(())
}

pub fn item(item: &Item, json: bool) -> Result<(), CoreError> {
    if json {
        println!("{}", serde_json::to_string_pretty(item)?);
    } else {
        println!("{}", line(item));
        println!("{}", serde_json::to_string_pretty(&item.properties)?);
        if !item.tags.is_empty() {
            println!("tags: {}", item.tags.join(", "));
        }
    }
    Ok(())
}

pub fn hits(hits: &[SearchHit], json: bool) -> Result<(), CoreError> {
    if json {
        println!("{}", serde_json::to_string_pretty(hits)?);
        return Ok(());
    }
    for hit in hits {
        println!("{:>7.3}  {}", hit.score, line(&hit.item));
        if !hit.snippet.is_empty() {
            println!("         {}", hit.snippet.replace('\n', " "));
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
        item.timestamp,
        title,
        if item.state.as_str() == "active" {
            String::new()
        } else {
            format!("  [{}]", item.state)
        }
    )
}
