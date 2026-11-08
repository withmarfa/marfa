//! Words shared by both approval pages, so they cannot say the same thing two ways.

use crate::app::access::Level;
use crate::app::oauth::offer::{LevelRow, Reach};

pub fn level(level: Level) -> &'static str {
    match level {
        Level::None => "No access",
        Level::Read => "Read only",
        Level::Write => "Read and edit",
    }
}

pub const CHOOSE_TYPES_WORD: &str = "Choose types";
pub const EDIT_LINE: &str = "Edit includes adding and deleting items.";
pub const POWERS_TITLE: &str = "More control over Marfa";
pub const UNDONE_MARK: &str = "Can't be undone.";

pub struct PowerWords {
    pub title: &'static str,
    pub note: Option<&'static str>,
}

const POWERS: [(&str, PowerWords); 12] = [
    (
        "keys.mint",
        PowerWords {
            title: "Make, see, edit and revoke keys",
            note: Some("Keys made this way never hold more than their maker."),
        },
    ),
    (
        "keys.manage",
        PowerWords {
            title: "See, edit, narrow and revoke every key",
            note: Some("A key's access can be narrowed, never widened."),
        },
    ),
    (
        "grants.manage",
        PowerWords {
            title: "See and disconnect other apps",
            note: None,
        },
    ),
    (
        "config.manage",
        PowerWords {
            title: "See and change Marfa's settings",
            note: None,
        },
    ),
    (
        "instance.read",
        PowerWords {
            title: "See health, metrics, storage and job status",
            note: None,
        },
    ),
    (
        "instance.maintain",
        PowerWords {
            title: "Run housekeeping, remove retired platform types and cancel bulk jobs",
            note: Some("Some jobs permanently delete data that is due to go."),
        },
    ),
    (
        "schema.write",
        PowerWords {
            title: "Replace or remove type definitions",
            note: Some("Only for types and relationships with edit access."),
        },
    ),
    (
        "blobs.manage",
        PowerWords {
            title: "Read and add any file, and manage file storage",
            note: None,
        },
    ),
    (
        "webhooks.manage",
        PowerWords {
            title: "Manage webhooks that send events to other services",
            note: Some("Includes seeing webhooks and sending events again."),
        },
    ),
    (
        "connectors.manage",
        PowerWords {
            title: "See, manage and remove all connectors",
            note: Some("Includes clearing what a connector has saved."),
        },
    ),
    (
        "audit.read",
        PowerWords {
            title: "Read the activity log",
            note: None,
        },
    ),
    (
        "items.purge",
        PowerWords {
            title: "Delete items in the trash for good",
            note: None,
        },
    ),
];

pub fn power_rank(literal: &str) -> usize {
    POWERS
        .iter()
        .position(|(word, _)| *word == literal)
        .unwrap_or(POWERS.len())
}

pub fn power(literal: &str) -> Option<&'static PowerWords> {
    POWERS
        .iter()
        .find(|(word, _)| *word == literal)
        .map(|(_, words)| words)
}

pub fn lower_first(text: &str) -> String {
    let mut characters = text.chars();
    match characters.next() {
        Some(first) => first.to_lowercase().chain(characters).collect(),
        None => String::new(),
    }
}

pub fn title(reach: Reach, pattern: &str, label: Option<&str>) -> String {
    let own = match (reach, pattern) {
        (Reach::Type, "*") => Some("All your data"),
        (Reach::Type, "user.*") => Some("Your custom types"),
        (Reach::Type, "core.*") => Some("Built-in types"),
        (Reach::Content, _) => Some("Your content"),
        (Reach::Edge, "edge.*") => Some("Links between items"),
        (Reach::Metadata, "metadata") => Some("Definitions on your server"),
        (Reach::Metadata, "metadata.types") => Some("Custom data types"),
        (Reach::Metadata, "metadata.edge_types") => Some("Custom relationship types"),
        (Reach::Profile, "profile") => Some("Profile"),
        (Reach::Profile, "profile.name") => Some("Name"),
        (Reach::Profile, "profile.email") => Some("Email address"),
        (Reach::Profile, "profile.avatar") => Some("Avatar"),
        _ => None,
    };
    if let Some(own) = own {
        return own.to_string();
    }
    if let Some(label) = label {
        return label.to_string();
    }
    match (reach, pattern.strip_suffix(".*")) {
        (Reach::Type, Some(root)) => format!("All types under {root}"),
        (Reach::Edge, Some(root)) => {
            format!("Links under {}", root.strip_prefix("edge.").unwrap_or(root))
        }
        _ => pattern.to_string(),
    }
}

pub fn reach_line(covers: &[String]) -> String {
    if covers.is_empty() {
        "Covers what exists today, and anything added later".to_string()
    } else {
        format!(
            "Covers {} today, and anything added later",
            covers.join(", ")
        )
    }
}

fn edge_line(pattern: &str) -> Option<&'static str> {
    Some(match pattern.strip_prefix("edge.")? {
        "about" => "Which items are about other items",
        "attached-to" => "Which items are attached to others",
        "comments-on" => "Which items are comments on others",
        "derived-from" => "Which items were made from others",
        "excerpt-of" => "Which items are excerpts of others",
        "in-collection" => "Which items are in collections",
        "in-folder" => "Which files sit in synced folders",
        "in-thread" => "Which items are messages in threads",
        "parent-of" => "Which items sit inside others",
        "references" => "Which items mention others",
        "supersedes" => "Which items replace others",
        "*" => "Every kind of link between items",
        _ => return None,
    })
}

pub fn description(row: &LevelRow) -> Option<String> {
    let writes = row
        .choices
        .iter()
        .any(|choice| choice.level == Level::Write);
    let text = match (row.reach, row.pattern.as_str()) {
        (Reach::Edge, pattern) => {
            return edge_line(pattern).map(str::to_string).or_else(|| {
                row.description
                    .as_deref()
                    .filter(|text| text.len() <= 100)
                    .map(str::to_string)
            });
        }
        (Reach::Metadata, "metadata") => "The types and relationship types you have defined",
        (Reach::Metadata, "metadata.types") => "The kinds of item you have defined",
        (Reach::Metadata, "metadata.edge_types") => "The kinds of link you have defined",
        (Reach::Profile, "profile") if writes => {
            "Read your name, email address and avatar; change only your name and avatar"
        }
        (Reach::Profile, "profile") => "Your name, email address and avatar",
        (Reach::Profile, "profile.name") if writes => "Read and change your name",
        (Reach::Profile, "profile.name") => "Your name",
        (Reach::Profile, "profile.email") => "Your email address",
        (Reach::Profile, "profile.avatar") if writes => "Read and change your avatar",
        (Reach::Profile, "profile.avatar") => "Your avatar",
        _ => return None,
    };
    Some(text.to_string())
}
