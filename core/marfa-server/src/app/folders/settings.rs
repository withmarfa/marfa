//! The settings a folder's `system.folder` item holds, judged before anything is written.

use marfa_rules::edges::depth_inside_folder;
use marfa_rules::filter::{EdgeDirection, FilterExpression, FilterField};
use marfa_rules::validation;
use serde_json::{Map, Value, json};

use crate::app::catalog::Catalog;
use crate::app::refusal::{Code, Refusal, Result};
use crate::app::types::check_id;
use crate::app::views::{QUERY, at, check_query, check_title, undeclared_in};

pub use crate::app::views::refuse_null;

pub const SETTINGS: [&str; 10] = [
    "title",
    "query",
    "defaults",
    "include",
    "ignore",
    "first_placement",
    "removal_threshold",
    "addition_threshold",
    "outside_query",
    "full_pass_interval_seconds",
];

const DEFAULTS: [&str; 5] = ["type", "tier", "properties", "tags", "edges"];
const THRESHOLD: [&str; 2] = ["files", "fraction"];
const MAX_PATTERNS: usize = 1_000;
const MAX_TEXT: usize = 1_024;
const MAX_DEFAULT_EDGE_TYPES: usize = 100;
const MAX_DEFAULT_EDGE_TARGETS: usize = 100;
const MOST_FILES: f64 = 9_007_199_254_740_991.0;
const FULL_PASS_SECONDS: std::ops::RangeInclusive<f64> = 60.0..=86_400.0;

/// Every key the body or one of its settings names that the folder does not declare, by its path
/// from the body.
pub fn undeclared(body: &Map<String, Value>, allowed: &[&str]) -> Vec<String> {
    let mut paths = Vec::new();
    undeclared_in(body, allowed, "", &mut paths);
    for (name, declared) in [
        ("query", &QUERY[..]),
        ("defaults", &DEFAULTS[..]),
        ("removal_threshold", &THRESHOLD[..]),
        ("addition_threshold", &THRESHOLD[..]),
    ] {
        if let Some(inner) = body.get(name).and_then(Value::as_object) {
            undeclared_in(inner, declared, &format!("{name}."), &mut paths);
        }
    }
    paths.sort_unstable();
    paths
}

fn known_type(value: &Value, path: &str, catalog: &Catalog) -> Result<()> {
    let Some(type_id) = value.as_str() else {
        return Err(at(path, "A type is a string."));
    };
    check_id(type_id, path)?;
    if type_id == "system" || type_id.starts_with("system.") {
        return Err(at(path, "A folder holds no system type."));
    }
    if catalog.rules.known(type_id) {
        return Ok(());
    }
    Err(
        Refusal::new(Code::UnknownType, format!("Unknown type: {type_id}")).with_detail(
            "errors",
            json!([{ "path": path, "message": "Unknown type" }]),
        ),
    )
}

fn check_filter(query: &Value) -> Result<()> {
    let Some(text) = query.get("filter").and_then(Value::as_str) else {
        return Ok(());
    };
    let expression =
        FilterExpression::decode(text).map_err(|error| at("query.filter", error.message))?;
    let backref = expression.conditions.iter().any(|condition| {
        matches!(
            condition.field,
            FilterField::Edge {
                direction: EdgeDirection::Backref,
                ..
            }
        )
    });
    if backref {
        return Err(at(
            "query.filter",
            "A folder's query cannot hold a backref condition: a folder on disk cannot follow one.",
        ));
    }
    Ok(())
}

fn check_edges(value: &Value, catalog: &Catalog) -> Result<()> {
    let Some(edges) = value.as_object() else {
        return Err(at("defaults.edges", "defaults.edges must be an object."));
    };
    if edges.len() > MAX_DEFAULT_EDGE_TYPES {
        return Err(at(
            "defaults.edges",
            format!("defaults.edges holds at most {MAX_DEFAULT_EDGE_TYPES} edge types."),
        ));
    }
    for (edge_type, targets) in edges {
        let path = format!("defaults.edges.{edge_type}");
        if edge_type == "in-folder" {
            return Err(at(
                &path,
                "in-folder is not a default: it needs the file's own path.",
            ));
        }
        if catalog.edge_kind(edge_type).is_none() {
            return Err(at(&path, format!("Unknown edge type: {edge_type}.")));
        }
        let Some(targets) = targets.as_array() else {
            return Err(at(&path, format!("{path} must be a list of item IDs.")));
        };
        if targets.len() > MAX_DEFAULT_EDGE_TARGETS {
            return Err(at(
                &path,
                format!("{path} holds at most {MAX_DEFAULT_EDGE_TARGETS} item IDs."),
            ));
        }
        if !targets.iter().all(|target| {
            target
                .as_str()
                .is_some_and(|id| validation::id(&path, id).is_ok())
        }) {
            return Err(at(&path, format!("{path} holds item IDs.")));
        }
    }
    Ok(())
}

fn check_defaults(value: &Value, catalog: &Catalog) -> Result<()> {
    let Some(defaults) = value.as_object() else {
        return Err(at("defaults", "defaults must be an object."));
    };
    if let Some(type_id) = defaults.get("type") {
        known_type(type_id, "defaults.type", catalog)?;
    }
    if let Some(tier) = defaults.get("tier")
        && !matches!(tier.as_str(), Some("library" | "feed"))
    {
        return Err(at("defaults.tier", "defaults.tier is library or feed."));
    }
    if let Some(properties) = defaults.get("properties") {
        let Some(properties) = properties.as_object() else {
            return Err(at(
                "defaults.properties",
                "defaults.properties must be an object.",
            ));
        };
        validation::property_names(properties)
            .map_err(|error| at("defaults.properties", error.message))?;
    }
    if let Some(tags) = defaults.get("tags") {
        let tags: Option<Vec<String>> = tags.as_array().and_then(|tags| {
            tags.iter()
                .map(|tag| tag.as_str().map(str::to_string))
                .collect()
        });
        let Some(tags) = tags else {
            return Err(at("defaults.tags", "defaults.tags must be a list of tags."));
        };
        validation::tags(&tags).map_err(|error| at("defaults.tags", error.message))?;
    }
    match defaults.get("edges") {
        Some(edges) => check_edges(edges, catalog),
        None => Ok(()),
    }
}

fn check_patterns(settings: &Map<String, Value>, name: &str) -> Result<()> {
    let Some(value) = settings.get(name) else {
        return Ok(());
    };
    let Some(patterns) = value.as_array() else {
        return Err(at(name, format!("{name} must be a list of patterns.")));
    };
    if patterns.len() > MAX_PATTERNS {
        return Err(at(
            name,
            format!("{name} holds at most {MAX_PATTERNS} patterns."),
        ));
    }
    for (index, pattern) in patterns.iter().enumerate() {
        let sound = pattern
            .as_str()
            .is_some_and(|text| (1..=MAX_TEXT).contains(&text.chars().count()));
        if !sound {
            return Err(at(
                &format!("{name}.{index}"),
                format!("A pattern holds 1 to {MAX_TEXT} characters."),
            ));
        }
    }
    Ok(())
}

fn check_placement(value: &Value, catalog: &Catalog) -> Result<()> {
    let Some(placement) = value.as_object() else {
        return Err(at("first_placement", "first_placement must be an object."));
    };
    for (type_id, directory) in placement {
        let path = format!("first_placement.{type_id}");
        known_type(&Value::from(type_id.as_str()), &path, catalog)?;
        let inside = directory.as_str().is_some_and(|directory| {
            (1..=MAX_TEXT).contains(&directory.chars().count())
                && depth_inside_folder(directory).is_some()
        });
        if !inside {
            return Err(at(
                &path,
                "A directory is a path relative to the folder's root, with / between names and no .. name.",
            ));
        }
    }
    Ok(())
}

fn check_threshold(settings: &Map<String, Value>, name: &str) -> Result<()> {
    let Some(value) = settings.get(name) else {
        return Ok(());
    };
    let Some(threshold) = value.as_object() else {
        return Err(at(name, format!("{name} must be an object.")));
    };
    if let Some(files) = threshold.get("files")
        && !files
            .as_f64()
            .is_some_and(|files| (0.0..=MOST_FILES).contains(&files) && files.fract() == 0.0)
    {
        return Err(at(
            &format!("{name}.files"),
            format!("{name}.files is a whole number from 0 to 9007199254740991."),
        ));
    }
    if let Some(fraction) = threshold.get("fraction")
        && !fraction
            .as_f64()
            .is_some_and(|fraction| (0.0..=1.0).contains(&fraction))
    {
        return Err(at(
            &format!("{name}.fraction"),
            format!("{name}.fraction is from 0 to 1."),
        ));
    }
    Ok(())
}

pub fn check(settings: &Map<String, Value>, catalog: &Catalog) -> Result<()> {
    if let Some(title) = settings.get("title") {
        check_title(title)?;
    }
    if let Some(query) = settings.get("query") {
        check_query(query, catalog)?;
        check_filter(query)?;
    }
    if let Some(defaults) = settings.get("defaults") {
        check_defaults(defaults, catalog)?;
    }
    check_patterns(settings, "include")?;
    check_patterns(settings, "ignore")?;
    if let Some(placement) = settings.get("first_placement") {
        check_placement(placement, catalog)?;
    }
    check_threshold(settings, "removal_threshold")?;
    check_threshold(settings, "addition_threshold")?;
    if let Some(interval) = settings.get("full_pass_interval_seconds")
        && !interval
            .as_f64()
            .is_some_and(|seconds| FULL_PASS_SECONDS.contains(&seconds) && seconds.fract() == 0.0)
    {
        return Err(at(
            "full_pass_interval_seconds",
            "full_pass_interval_seconds is a whole number of seconds from 60 to 86400.",
        ));
    }
    if let Some(outside) = settings.get("outside_query")
        && !matches!(outside.as_str(), Some("send" | "hold"))
    {
        return Err(at("outside_query", "outside_query is send or hold."));
    }
    Ok(())
}
