//! Creates items, optionally fetching files from web or chat URLs.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use url::Url;

use super::{Definition, item_id, parsed, text};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::edges::write::{Create, Op};
use crate::app::items::captions;
use crate::app::items::write::{self, Change};
use crate::app::mcp::fetch::{self, Failed, Reason};
use crate::app::refusal::Code;
use crate::http::items::put_from;
use crate::http::mcp::results::{Outcome, Stop};

pub const NAME: &str = "marfa_create";

const ATTACHED_TO: &str = "attached-to";

pub fn definition() -> Definition {
    Definition {
        name: NAME,
        title: "Save a new item",
        description: "Use to save something new: a note, task, record or other item, or a file from a web address or the chat. To change an existing item, use marfa_update instead.",
        input: json!({
            "type": "object",
            "properties": {
                "type": { "type": "string", "minLength": 1,
                    "description": "The item's type, such as `core.note`. Required unless saving a file." },
                "properties": { "type": "object",
                    "description": "The item's fields, as the type defines them." },
                "tags": { "type": "array", "items": { "type": "string", "minLength": 1 },
                    "description": "Tags to add." },
                "edges": { "type": "object",
                    "additionalProperties": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                    "description": "Edges from the new item, as edge type to target item IDs, such as {\"in-collection\": [\"<id>\"]}." },
                "tier": { "type": "string", "enum": ["library", "feed"],
                    "description": "`library` for something the person keeps; the credential's default when left out." },
                "occurred_at": { "type": "string",
                    "description": "The item's own time, such as a meeting's date (RFC 3339)." },
                "id": { "type": "string", "minLength": 1,
                    "description": "Leave out unless a retry must not save twice. Then send a new random UUIDv7 you generate, never a made-up or patterned one." },
                "url": { "type": "string", "minLength": 1,
                    "description": "A public http or https address of a file to save. Redirects are not followed." },
                "file": {
                    "type": "object",
                    "properties": {
                        "download_url": { "type": "string", "minLength": 1,
                            "description": "Where to download the file; it works for a short time." },
                        "file_id": { "type": "string", "minLength": 1,
                            "description": "The file's ID in the chat." },
                        "mime_type": { "type": "string", "description": "The file's MIME type." },
                        "file_name": { "type": "string", "description": "The file's name." },
                    },
                    "required": ["download_url", "file_id"],
                    "additionalProperties": false,
                    "description": "A file the person attached in the chat, to save.",
                },
                "attach_to": { "type": "string", "minLength": 1,
                    "description": "With url or file: the ID of an item to attach the saved file to." },
            },
            "additionalProperties": false,
        }),
        output: json!({
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "type": { "type": "string" },
                "version": { "type": "integer" },
                "title": { "type": "string" },
                "tags": { "type": "array", "items": { "type": "string" } },
                "created": { "type": "boolean",
                    "description": "`false` when this id was saved before, so nothing was written and the item is as stored." },
                "file": { "type": "object",
                    "properties": {
                        "hash": { "type": "string" },
                        "mime_type": { "type": "string" },
                        "size_bytes": { "type": "integer" },
                    },
                    "required": ["hash", "mime_type", "size_bytes"],
                },
                "attached_to": { "type": "string" },
            },
            "required": ["id", "type", "version", "title", "tags", "created"],
        }),
        annotations: json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": true,
        }),
        meta: Some(json!({ "openai/fileParams": ["file"] })),
    }
}

/// The file type a MIME type names, as `marfa items attach` chooses it.
fn file_type_for(mime_type: &str) -> &'static str {
    let essence = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if essence == "text/html" || essence == "application/xhtml+xml" {
        return "core.file.webpage";
    }
    match essence.split('/').next().unwrap_or_default() {
        "image" => "core.file.image",
        "audio" => "core.file.audio",
        "video" => "core.file.video",
        _ => "core.file",
    }
}

/// The last path segment of a web address, as a file name.
fn name_from_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let segment = url.path_segments()?.next_back()?;
    let decoded = percent_decode(segment);
    let name = decoded.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        let escaped = (byte == b'%')
            .then(|| bytes.get(at + 1..at + 3))
            .flatten()
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match escaped {
            Some(decoded) => {
                out.push(decoded);
                at += 3;
            }
            None => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn not_fetched(reason: &Reason, from_chat: bool) -> Stop {
    let mut stop = Stop::coded("file_not_fetched", reason.message()).with("reason", reason.word());
    match reason {
        Reason::Status(status) => {
            stop = stop.with("status", *status);
            if from_chat {
                stop = stop.with(
                    "hint",
                    "The chat's link to the file may have expired. Ask the person to attach the file again.",
                );
            }
        }
        Reason::RateLimited(seconds) => stop = stop.with("retry_after_seconds", *seconds),
        _ => {}
    }
    stop
}

pub async fn run(app: &Arc<App>, caller: &Caller, arguments: Map<String, Value>) -> Outcome {
    let url = text(&arguments, "url");
    let chat_file = arguments.get("file").and_then(Value::as_object);
    let attach_to = text(&arguments, "attach_to");
    if url.is_some() && chat_file.is_some() {
        return Err(Stop::invalid("Send url or file, not both."));
    }
    let bytes_from = url.clone().or_else(|| {
        chat_file
            .and_then(|file| file.get("download_url"))
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if bytes_from.is_none() && attach_to.is_some() {
        return Err(Stop::invalid("attach_to needs url or file."));
    }
    let mut item_type = text(&arguments, "type");
    if bytes_from.is_none() && item_type.is_none() {
        return Err(Stop::invalid("type is required unless saving a file."));
    }
    if let Some(target) = &attach_to {
        item_id(target)?;
    }
    let id = text(&arguments, "id");
    if let Some(id) = &id {
        item_id(id)?;
    }

    let mut properties = match arguments.get("properties") {
        Some(Value::Object(properties)) => properties.clone(),
        _ => Map::new(),
    };
    let mut file: Option<Value> = None;
    if let Some(raw) = &bytes_from {
        let hint = chat_file
            .and_then(|file| file.get("mime_type"))
            .and_then(Value::as_str)
            .map(str::to_ascii_lowercase);
        let fetched = match fetch::file(app, caller, raw, hint).await {
            Ok(fetched) => fetched,
            Err(Failed::Not(reason)) => return Err(not_fetched(&reason, chat_file.is_some())),
            Err(Failed::Refused(refusal)) => return Err(Stop::refused(refusal)),
        };
        let mime_type = fetched.blob.mime_type.clone();
        item_type.get_or_insert_with(|| file_type_for(&mime_type).to_string());
        let title = chat_file
            .and_then(|file| file.get("file_name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or(fetched.file_name.clone())
            .or_else(|| url.as_deref().and_then(name_from_url))
            .unwrap_or_else(|| "file".to_string());
        let mut whole = Map::new();
        whole.insert("title".into(), title.into());
        whole.extend(properties);
        whole.insert("blob_ref".into(), fetched.blob.hash.as_str().into());
        whole.insert("mime_type".into(), mime_type.clone().into());
        if let Some(address) = &url {
            whole.insert("source_url".into(), address.clone().into());
        }
        properties = whole;
        file = Some(json!({
            "hash": fetched.blob.hash.as_str(),
            "mime_type": mime_type,
            "size_bytes": fetched.blob.size_bytes,
        }));
    }
    let Some(item_type) = item_type else {
        return Err(Stop::invalid("type is required."));
    };

    let mut sent = Map::new();
    sent.insert("type".into(), item_type.into());
    sent.insert("properties".into(), Value::Object(properties));
    for name in ["id", "tags", "edges", "tier", "occurred_at"] {
        if let Some(value) = arguments.get(name) {
            sent.insert(name.into(), value.clone());
        }
    }
    let put = put_from(sent, || Ok(()))?;
    let done = write::run(app, caller, None, Change::Put(Box::new(put))).await?;
    let created = parsed(&done.body)?;
    let item = created.get("item").cloned().unwrap_or(Value::Null);
    let field = |name: &str| item.get(name).cloned().unwrap_or(Value::Null);
    let item_id_made = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let acknowledged = created.get("acknowledged").and_then(Value::as_bool) == Some(true);

    let mut attached: Option<String> = None;
    if let Some(target) = attach_to {
        let edge = Op::Create(Create {
            id: None,
            source_id: item_id_made.clone(),
            target_id: target.clone(),
            edge_type: ATTACHED_TO.to_string(),
            properties: Map::new(),
            source_version: None,
        });
        match crate::app::edges::write::run(app, caller, None, edge).await {
            Ok(_) => {}
            Err(refusal) => {
                // A repeat of a call that attached the file finds the edge it wrote.
                let already = refusal.code == Code::EdgeConstraintViolation
                    && refusal
                        .details
                        .as_ref()
                        .and_then(|details| details.get("constraint"))
                        .and_then(Value::as_str)
                        == Some("duplicate");
                if !already {
                    return Err(Stop::refused(refusal)
                        .with(
                            "saved",
                            json!({ "id": item_id_made, "type": field("type"), "version": field("version") }),
                        )
                        .with(
                            "hint",
                            "The file was saved, but attaching it failed. Attach it with marfa_update on the saved item, adding an attached-to edge.",
                        )
                        .wrote(true));
                }
            }
        }
        attached = Some(target);
    }

    let title = captions(app, caller, vec![item_id_made.clone()])
        .await?
        .remove(&item_id_made)
        .map(|caption| caption.name)
        .unwrap_or_default();
    let tags = created
        .get("metadata")
        .and_then(|metadata| metadata.get("tags"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let mut answer = Map::new();
    answer.insert("id".into(), item_id_made.into());
    answer.insert("type".into(), field("type"));
    answer.insert("version".into(), field("version"));
    answer.insert("title".into(), title.into());
    answer.insert("tags".into(), tags);
    answer.insert("created".into(), (!acknowledged).into());
    if let Some(file) = file {
        let stored_here = item
            .get("properties")
            .and_then(|properties| properties.get("blob_ref"))
            == file.get("hash");
        if !acknowledged || stored_here {
            answer.insert("file".into(), file);
        }
    }
    if let Some(target) = attached {
        answer.insert("attached_to".into(), target.into());
    }
    Ok(Value::Object(answer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_type_follows_the_media_type() {
        assert_eq!(file_type_for("image/png"), "core.file.image");
        assert_eq!(
            file_type_for("TEXT/HTML; charset=utf-8"),
            "core.file.webpage"
        );
        assert_eq!(file_type_for("audio/mpeg"), "core.file.audio");
        assert_eq!(file_type_for("video/mp4"), "core.file.video");
        assert_eq!(file_type_for("application/pdf"), "core.file");
    }

    #[test]
    fn a_file_is_named_after_the_last_segment_of_its_address() {
        assert_eq!(
            name_from_url("https://example.com/a/b/My%20File.pdf?x=1").as_deref(),
            Some("My File.pdf")
        );
        assert_eq!(name_from_url("https://example.com/"), None);
        assert_eq!(name_from_url("not a url"), None);
    }
}
