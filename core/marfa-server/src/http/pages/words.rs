//! Words shared by both approval pages, so they cannot say the same thing two ways.

use crate::app::access::Level;
use crate::app::oauth::offer::{AdminLevel, AppShown, LevelRow, Reach};

pub fn level(level: Level) -> &'static str {
    match level {
        Level::None => "No Access",
        Level::Read => "Read Only",
        Level::Write => "Read and Edit",
    }
}

pub const CHOOSE_TYPES_WORD: &str = "Each Type…";
pub const EDIT_LINE: &str = "Edit includes adding and deleting.";
pub const LATER_INCLUDED: &str = "Types added later are included.";
pub const LATER_NOT_INCLUDED: &str = "Types added later aren't included.";
pub const PROFILE_FIELDS: &str = "Name, username, email and picture.";
pub const PROFILE_EDIT_FIELDS: &str =
    "Name, username, email and picture. Editing covers all but the username.";
pub const ADMIN_TITLE: &str = "Settings, keys and more";
pub const ADMIN_GLANCE: &str = "Admin access";
pub const ALSO_WANTS: &str = "It also wants";
pub const ALREADY_ALLOWED: &str = "Already allowed";
pub const ALLOW: &str = "Allow";
pub const DONT_ALLOW: &str = "Don't Allow";

pub fn admin_level(level: AdminLevel) -> &'static str {
    match level {
        AdminLevel::Full => "Full Access",
        AdminLevel::Limited => "Limited",
        AdminLevel::None => "No Access",
        AdminLevel::Custom => "Custom…",
    }
}

/// Without scripts, which levels of the all-items row reach types added later, and that Each Type does not.
pub fn later_by_level(levels: &[&str]) -> String {
    let verb = if levels.len() == 1 {
        "includes"
    } else {
        "include"
    };
    format!(
        "{} {verb} types added later. {} does not.",
        and_list(levels),
        CHOOSE_TYPES_WORD.trim_end_matches('…')
    )
}

/// Under a group of rows that counts only at one choice of the control above it.
pub fn counts_when(control: &str, choice: &str) -> String {
    format!(
        "These count when {control} is set to {}.",
        choice.trim_end_matches('…')
    )
}

/// Follows the app's name, which the app chose itself.
pub fn app_bracket(app: &AppShown) -> String {
    match app.destinations.first() {
        Some(host) => format!("(unverified, {host})"),
        None => "(unverified)".to_string(),
    }
}

/// What approving reaches beyond the bracket, each part only where it applies.
pub fn app_line(app: &AppShown) -> Option<String> {
    let mut sentences = Vec::new();
    if app.destinations.len() > 1 {
        let hosts: Vec<&str> = app.destinations.iter().map(String::as_str).collect();
        sentences.push(format!("It sends you back to {}.", and_list(&hosts)));
    }
    if let Some(host) = &app.document_host {
        sentences.push(format!("Its details come from {host}."));
    }
    if !app.web_origins.is_empty() {
        let origins: Vec<&str> = app
            .web_origins
            .iter()
            .map(|origin| origin.strip_prefix("https://").unwrap_or(origin))
            .collect();
        sentences.push(format!(
            "Allowing it also lets {} reach Marfa from your browser.",
            and_list(&origins)
        ));
    }
    (!sentences.is_empty()).then(|| sentences.join(" "))
}

fn and_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

pub const POWER_COUNT: usize = POWERS.len();

pub struct PowerWords {
    pub title: &'static str,
    pub note: Option<&'static str>,
}

const POWERS: [(&str, PowerWords); 14] = [
    (
        "keys.mint",
        PowerWords {
            title: "Make keys",
            note: Some("They hold no more than this app does."),
        },
    ),
    (
        "keys.manage",
        PowerWords {
            title: "Manage every key",
            note: Some("With Make keys, it can make keys that outlast its access."),
        },
    ),
    (
        "grants.manage",
        PowerWords {
            title: "Disconnect other apps",
            note: None,
        },
    ),
    (
        "config.manage",
        PowerWords {
            title: "Change settings",
            note: None,
        },
    ),
    (
        "instance.read",
        PowerWords {
            title: "See server health",
            note: None,
        },
    ),
    (
        "instance.maintain",
        PowerWords {
            title: "Run housekeeping and updates",
            note: Some("Some jobs delete data for good."),
        },
    ),
    (
        "schema.write",
        PowerWords {
            title: "Replace or remove types",
            note: None,
        },
    ),
    (
        "blobs.manage",
        PowerWords {
            title: "Manage files",
            note: None,
        },
    ),
    (
        "webhooks.manage",
        PowerWords {
            title: "Manage webhooks",
            note: None,
        },
    ),
    (
        "connectors.manage",
        PowerWords {
            title: "Manage connectors",
            note: None,
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
            title: "Empty the trash",
            note: None,
        },
    ),
    (
        "backups.manage",
        PowerWords {
            title: "Back up and restore",
            note: Some("It can restore items outside its usual access."),
        },
    ),
    (
        "sign_ins.manage",
        PowerWords {
            title: "Manage sign-ins and passkeys",
            note: Some("Includes changing your password."),
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
        (Reach::Type, "*") => Some("Your items"),
        (Reach::Type, "user.*") => Some("Your custom types"),
        (Reach::Type, "core.*") => Some("Built-in types"),
        (Reach::Type, "common.*") => Some("Shared types"),
        (Reach::Type, "app.*") => Some("Every app's own data"),
        (Reach::Content, _) => Some("Your content"),
        (Reach::Edge, "edge.*") => Some("Links between items"),
        (Reach::Metadata, "metadata") => Some("Definitions on your server"),
        (Reach::Metadata, "metadata.types") => Some("Custom data types"),
        (Reach::Metadata, "metadata.edge_types") => Some("Custom relationship types"),
        (Reach::Profile, "profile") => Some("Your profile"),
        (Reach::Profile, "profile.name") => Some("Name"),
        (Reach::Profile, "profile.username") => Some("Username"),
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
        (Reach::Type, Some(root))
            if root.strip_prefix("app.").is_some_and(|v| !v.contains('.')) =>
        {
            format!("{}'s own data", &root["app.".len()..])
        }
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
    let verb = if writes { "Read and change" } else { "Read" };
    match (row.reach, row.pattern.as_str()) {
        (Reach::Type, "app.*") => {
            return Some(format!("{verb} what other apps keep for themselves"));
        }
        (Reach::Type, pattern) => {
            if let Some(vendor) = pattern
                .strip_prefix("app.")
                .and_then(|rest| rest.strip_suffix(".*"))
                .filter(|vendor| !vendor.contains('.'))
            {
                return Some(format!("{verb} what the {vendor} app keeps for itself"));
            }
        }
        _ => {}
    }
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
        _ => return None,
    };
    Some(text.to_string())
}

/// What approving a row gives, at the level it starts at, for the summary box: the verb, and the
/// object, which may carry a type's own name and so is drawn in its own direction.
pub fn gives(
    reach: Reach,
    pattern: &str,
    label: Option<&str>,
    level: Level,
) -> (&'static str, String) {
    let own = title(reach, pattern, label);
    let (verb, object) = match reach {
        Reach::Profile => (
            if level == Level::Write {
                "See and edit"
            } else {
                "See"
            },
            match pattern {
                "profile" => "your profile".to_string(),
                "profile.name" => "your name".to_string(),
                "profile.username" => "your username".to_string(),
                "profile.email" => "your email".to_string(),
                "profile.avatar" => "your picture".to_string(),
                _ => lower_first(&own),
            },
        ),
        _ => (
            if level == Level::Write {
                "Read and edit"
            } else {
                "Read"
            },
            match (reach, pattern) {
                (Reach::Type, "*") => "all your items".to_string(),
                (Reach::Type, _) if pattern.contains('*') => lower_first(&own),
                (Reach::Type, _) => format!("{own} items"),
                (Reach::Content, _) => "your content".to_string(),
                (Reach::Edge, "edge.*") => "links between items".to_string(),
                (Reach::Edge, _) if own.starts_with("Links") => lower_first(&own),
                (Reach::Edge, _) => format!("{own} links"),
                (Reach::Metadata, "metadata") => "definitions on your server".to_string(),
                _ => lower_first(&own),
            },
        ),
    };
    (verb, object)
}

/// The name of the symbol a summary row starts with.
pub fn symbol(reach: Reach) -> &'static str {
    match reach {
        Reach::Edge => "link",
        Reach::Profile => "person",
        Reach::Type | Reach::Content | Reach::Metadata => "items",
    }
}

/// What every power asked amounts to as one line, or all of them as admin access.
pub fn admin_gives(powers: &[String]) -> String {
    if powers.len() >= POWERS.len() {
        ADMIN_GLANCE.to_string()
    } else {
        format!("{ADMIN_GLANCE}: {}", powers.join(", "))
    }
}

/// The line under the admin box at Limited, from the powers that level holds.
pub fn limited_line(powers: &[String]) -> String {
    format!("Only {}.", powers_list(powers))
}

/// Without scripts, what Limited holds, since no choice shows the line above.
pub fn limited_by_level(powers: &[String]) -> String {
    format!(
        "{} lets the app only {}.",
        admin_level(AdminLevel::Limited),
        powers_list(powers)
    )
}

fn powers_list(powers: &[String]) -> String {
    and_list(&powers.iter().map(String::as_str).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_namespace_row_says_whose_data_it_covers() {
        assert_eq!(title(Reach::Type, "app.*", None), "Every app's own data");
        assert_eq!(title(Reach::Type, "app.acme.*", None), "acme's own data");
        assert_eq!(
            title(Reach::Type, "app.acme.widget", Some("Widget")),
            "Widget"
        );
        assert_eq!(title(Reach::Type, "acme.*", None), "All types under acme");
    }
}
