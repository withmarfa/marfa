//! The settings a folder's `system.folder` item holds, judged before anything is written.

use marfa_rules::folder as rules;
use marfa_rules::validation;
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

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

/// Pattern lists compiled at once: each peaks at a few MiB, and a queue of
/// them waits here and not on the writer.
static COMPILING: Semaphore = Semaphore::const_new(2);

/// The request's `include` and `ignore` lists, read and compiled. Only
/// `compile_patterns` makes one, and a folder write needs one.
#[derive(Debug)]
pub struct Patterns(());

/// Undeclared keys, by path from the request body.
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
    if let Some(properties) = defaults.get("properties")
        && !properties.is_object()
    {
        return Err(at(
            "defaults.properties",
            "defaults.properties must be an object.",
        ));
    }
    if let Some(tags) = defaults.get("tags")
        && !tags
            .as_array()
            .is_some_and(|tags| tags.iter().all(Value::is_string))
    {
        return Err(at("defaults.tags", "defaults.tags must be a list of tags."));
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
        let named = directory
            .as_str()
            .is_some_and(|directory| (1..=MAX_TEXT).contains(&directory.chars().count()));
        if !named {
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
    for (key, message) in [
        (
            "files",
            format!("{name}.files is a whole number from 0 to 9007199254740991."),
        ),
        ("fraction", format!("{name}.fraction is from 0 to 1.")),
    ] {
        if threshold.get(key).is_some_and(|number| !number.is_number()) {
            return Err(at(&format!("{name}.{key}"), message));
        }
    }
    Ok(())
}

/// Judges the lists a request sends before its write is queued: compiling takes
/// milliseconds that no other write should wait for, and depends on nothing
/// the writer holds.
pub async fn compile_patterns(settings: &Map<String, Value>) -> Result<Patterns> {
    check_patterns(settings, "include")?;
    check_patterns(settings, "ignore")?;
    let (include, ignore) = (
        strings(settings.get("include")),
        strings(settings.get("ignore")),
    );
    if include.is_empty() && ignore.is_empty() {
        return Ok(Patterns(()));
    }
    let permit = COMPILING
        .acquire()
        .await
        .map_err(|_| Refusal::internal("the pattern checks have stopped"))?;
    let judged = tokio::task::spawn_blocking(move || rules::check_patterns(&include, &ignore))
        .await
        .map_err(|_| Refusal::internal("a pattern check did not finish"))?;
    drop(permit);
    judged
        .map(|()| Patterns(()))
        .map_err(|violation| at(&violation.path, violation.message))
}

/// Judges the settings a request names, but for the patterns `compile_patterns` judged.
pub fn check(settings: &Map<String, Value>, catalog: &Catalog, _: &Patterns) -> Result<()> {
    check_settings(settings, catalog)
}

/// Judges whole settings the server rewrote, whose pattern lists were judged when they were stored.
pub fn check_stored(settings: &Map<String, Value>, catalog: &Catalog) -> Result<()> {
    check_settings(settings, catalog)?;
    judge(settings, catalog)
}

fn check_settings(settings: &Map<String, Value>, catalog: &Catalog) -> Result<()> {
    if let Some(title) = settings.get("title") {
        check_title(title)?;
    }
    if let Some(query) = settings.get("query") {
        check_query(query, catalog, true)?;
    }
    if let Some(defaults) = settings.get("defaults") {
        check_defaults(defaults, catalog)?;
    }
    if let Some(placement) = settings.get("first_placement") {
        check_placement(placement, catalog)?;
    }
    check_threshold(settings, "removal_threshold")?;
    check_threshold(settings, "addition_threshold")?;
    if settings
        .get("full_pass_interval_seconds")
        .is_some_and(|interval| !interval.is_number())
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
    judged(settings, catalog, false)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn threshold(settings: &Map<String, Value>, name: &str) -> rules::Threshold {
    let number = |key: &str| {
        settings
            .get(name)
            .and_then(|threshold| threshold.get(key))
            .and_then(Value::as_f64)
    };
    rules::Threshold {
        files: number("files"),
        fraction: number("fraction"),
    }
}

/// Cross-setting checks require the complete settings after merging a patch.
pub fn judge(settings: &Map<String, Value>, catalog: &Catalog) -> Result<()> {
    judged(settings, catalog, true)
}

/// A partial patch cannot establish whether the query holds a default.
fn judged(settings: &Map<String, Value>, catalog: &Catalog, complete: bool) -> Result<()> {
    let query = settings.get("query");
    let defaults = settings.get("defaults");
    let types = strings(query.and_then(|query| query.get("types")));
    let state = query
        .and_then(|query| query.get("state"))
        .map(|state| strings(Some(state)));
    let (tags, include, ignore) = (
        strings(defaults.and_then(|defaults| defaults.get("tags"))),
        strings(settings.get("include")),
        strings(settings.get("ignore")),
    );
    let placements: Vec<(&str, &str)> = settings
        .get("first_placement")
        .and_then(Value::as_object)
        .map(|placement| {
            placement
                .iter()
                .filter_map(|(type_id, directory)| Some((type_id.as_str(), directory.as_str()?)))
                .collect()
        })
        .unwrap_or_default();
    rules::check_settled(
        Some(&catalog.rules),
        &rules::Settings {
            types: &types,
            tier: query
                .and_then(|query| query.get("tier"))
                .and_then(Value::as_str),
            state: state.as_deref(),
            filter: query
                .and_then(|query| query.get("filter"))
                .and_then(Value::as_str),
            default_type: defaults
                .and_then(|defaults| defaults.get("type"))
                .and_then(Value::as_str)
                .filter(|_| complete),
            default_tier: defaults
                .and_then(|defaults| defaults.get("tier"))
                .and_then(Value::as_str)
                .filter(|_| complete),
            tags: &tags,
            properties: defaults
                .and_then(|defaults| defaults.get("properties"))
                .and_then(Value::as_object),
            include: &include,
            ignore: &ignore,
            first_placement: &placements,
            removal: threshold(settings, "removal_threshold"),
            addition: threshold(settings, "addition_threshold"),
            full_pass_interval_seconds: settings
                .get("full_pass_interval_seconds")
                .and_then(Value::as_f64),
        },
    )
    .map_err(|violation| at(&violation.path, violation.message))
}
