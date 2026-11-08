//! What a folder's settings must satisfy for a device to attach it: the server
//! refuses the same settings before it stores them, and the device reads them
//! with the same functions.

use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::edges::depth_inside_folder;
use crate::error::Code;
use crate::filter::{EdgeDirection, FilterExpression, FilterField};
use crate::query::{EVERY_TYPE, StateFault, check_states};
use crate::{integers, pattern, validation};

/// The most files a threshold counts: the largest whole number a JSON number holds exactly.
pub const MOST_FILES: f64 = 9_007_199_254_740_991.0;

/// The fewest and most seconds between a watch's full passes.
pub const FULL_PASS_SECONDS: std::ops::RangeInclusive<f64> = 60.0..=86_400.0;

/// A refused setting and where it sits in the settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: String,
    pub message: String,
    /// `ValidationError` or `InvalidProperties` for a value the grammar refuses,
    /// `Invalid` for settings that read but that no folder can follow.
    pub code: Code,
}

impl Violation {
    fn new(path: &str, code: Code, message: impl Into<String>) -> Violation {
        Violation {
            path: path.to_string(),
            message: message.into(),
            code,
        }
    }

    fn invalid(path: &str, message: impl Into<String>) -> Violation {
        Violation::new(path, Code::Invalid, message)
    }
}

/// One threshold: a count and a fraction, each as a number so that a value
/// that is no whole count, or a count too large to hold exactly, is seen.
#[derive(Debug, Clone, Copy, Default)]
pub struct Threshold {
    pub files: Option<f64>,
    pub fraction: Option<f64>,
}

/// The complete settings a device follows a folder by. An absent setting is
/// `None` or empty and is judged as the folder's default.
#[derive(Debug, Clone, Default)]
pub struct Settings<'a> {
    pub types: &'a [String],
    /// `library`, `feed` or `all`.
    pub tier: Option<&'a str>,
    pub state: Option<&'a [String]>,
    pub filter: Option<&'a str>,
    pub default_type: Option<&'a str>,
    /// `library` or `feed`.
    pub default_tier: Option<&'a str>,
    pub tags: &'a [String],
    pub properties: Option<&'a Map<String, Value>>,
    pub include: &'a [String],
    pub ignore: &'a [String],
    /// A type and the directory its new files go in.
    pub first_placement: &'a [(&'a str, &'a str)],
    pub removal: Threshold,
    pub addition: Threshold,
    pub full_pass_interval_seconds: Option<f64>,
}

pub fn is_system(type_id: &str) -> bool {
    type_id.starts_with("system.")
}

/// Whether the query names no type or names `*`: every type but `system.*`.
pub fn names_every_type(types: &[String]) -> bool {
    types.is_empty() || types.iter().any(|named| named.trim() == EVERY_TYPE)
}

/// The types a copy of the folder declares: `*` for every type, and the
/// trimmed types otherwise.
pub fn slice_types(types: &[String]) -> Vec<String> {
    if names_every_type(types) {
        vec![EVERY_TYPE.to_string()]
    } else {
        types.iter().map(|named| named.trim().to_string()).collect()
    }
}

/// Whether a declaration names the type: `*` names every type but `system.*`.
pub fn declares_type(catalog: &Catalog, declared: &[String], row_type: &str) -> bool {
    declared.iter().any(|declared| {
        if declared == EVERY_TYPE {
            !is_system(row_type)
        } else {
            catalog.matches(declared, row_type)
        }
    })
}

/// Whether a folder with the query's types holds `named`.
pub fn holds_type(catalog: &Catalog, types: &[String], named: &str) -> bool {
    declares_type(catalog, &slice_types(types), named)
}

/// A default type the query does not hold would put every new file outside
/// its own folder.
fn check_default_type(
    catalog: &Catalog,
    types: &[String],
    default_type: Option<&str>,
) -> Result<(), String> {
    match default_type {
        Some(named) if !holds_type(catalog, types, named) => Err(format!(
            "a new file would become a {named}, which the query does not hold"
        )),
        _ => Ok(()),
    }
}

/// A placement directory a device cannot write to is refused: an absolute or
/// drive-absolute one, one with a backslash or NUL, and one with a `..` name.
fn check_placement(type_id: &str, directory: &str) -> Result<(), String> {
    if depth_inside_folder(directory).is_some() {
        return Ok(());
    }
    Err(format!(
        "{type_id}: {directory:?} is not a directory inside the folder: write a path relative to its root, with \"/\" between names and no \"..\" name"
    ))
}

fn check_threshold(name: &str, threshold: Threshold) -> Result<(), Violation> {
    if let Some(files) = threshold.files
        && !((0.0..=MOST_FILES).contains(&files) && files.fract() == 0.0)
    {
        return Err(Violation::invalid(
            &format!("{name}.files"),
            format!("{name}.files is a whole number from 0 to 9007199254740991."),
        ));
    }
    if let Some(fraction) = threshold.fraction
        && !(0.0..=1.0).contains(&fraction)
    {
        return Err(Violation::invalid(
            &format!("{name}.fraction"),
            format!("{name}.fraction is from 0 to 1."),
        ));
    }
    Ok(())
}

fn check_filter(text: &str) -> Result<(), Violation> {
    let expression = FilterExpression::decode(text)
        .map_err(|error| Violation::new("query.filter", Code::ValidationError, error.message))?;
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
        return Err(Violation::invalid(
            "query.filter",
            "A folder's query cannot hold a backref condition: a folder on disk cannot follow one.",
        ));
    }
    Ok(())
}

/// Whether the two lists hold no more text than a device compiles, every line
/// is a pattern and each list compiles within the bound. It compiles them, so
/// a server runs it before its writer and not inside it.
pub fn check_patterns(include: &[String], ignore: &[String]) -> Result<(), Violation> {
    pattern::check_text(include, ignore)
        .map_err(|(path, message)| Violation::invalid(path, message))?;
    for (path, lines) in [("include", include), ("ignore", ignore)] {
        pattern::check_list(path, lines).map_err(|message| Violation::invalid(path, message))?;
    }
    Ok(())
}

/// Checks complete settings, patterns included.
pub fn check(catalog: Option<&Catalog>, settings: &Settings) -> Result<(), Violation> {
    check_patterns(settings.include, settings.ignore)?;
    check_settled(catalog, settings)
}

/// Everything but the compiling of the lists: what a write is judged on in
/// its transaction. Checking the default type requires a catalog.
pub fn check_settled(catalog: Option<&Catalog>, settings: &Settings) -> Result<(), Violation> {
    if let Some(states) = settings.state {
        check_states(states).map_err(|fault| match fault {
            StateFault::Empty => {
                Violation::invalid("query.state", "query.state is a list of states.")
            }
            StateFault::Unknown(index) => Violation::invalid(
                &format!("query.state.{index}"),
                "A query lists the active and archived states.",
            ),
        })?;
    }
    if let Some(filter) = settings.filter {
        check_filter(filter)?;
    }
    validation::tags(settings.tags)
        .map_err(|error| Violation::new("defaults.tags", error.code, error.message))?;
    if let Some(properties) = settings.properties {
        validation::property_names(properties)
            .and_then(|()| integers::refuse_in_value(properties))
            .map_err(|error| Violation::new("defaults.properties", error.code, error.message))?;
    }
    for (type_id, directory) in settings.first_placement {
        check_placement(type_id, directory).map_err(|message| {
            Violation::new(
                &format!("first_placement.{type_id}"),
                Code::ValidationError,
                message,
            )
        })?;
    }
    pattern::check_text(settings.include, settings.ignore)
        .map_err(|(path, message)| Violation::invalid(path, message))?;
    check_threshold("removal_threshold", settings.removal)?;
    if let Some(seconds) = settings.full_pass_interval_seconds
        && !(FULL_PASS_SECONDS.contains(&seconds) && seconds.fract() == 0.0)
    {
        return Err(Violation::invalid(
            "full_pass_interval_seconds",
            "full_pass_interval_seconds is a whole number of seconds from 60 to 86400.",
        ));
    }
    check_threshold("addition_threshold", settings.addition)?;
    if let Some(catalog) = catalog {
        check_default_type(catalog, settings.types, settings.default_type)
            .map_err(|message| Violation::invalid("defaults.type", message))?;
    }
    let held = settings.tier.unwrap_or("library");
    match settings.default_tier {
        Some(tier) if held != "all" && held != tier => Err(Violation::invalid(
            "defaults.tier",
            format!(
                "a new file would be made at the {tier} tier, and the query holds the {held} tier"
            ),
        )),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Catalog {
        let entries = [
            ("core.note", None),
            ("core.task", None),
            ("core.media", None),
            ("core.media.photo", Some("core.media")),
        ];
        Catalog::from_wire(
            &entries
                .iter()
                .map(|(id, parent)| {
                    serde_json::from_value(serde_json::json!({
                        "id": id,
                        "parent": parent,
                    }))
                    .unwrap()
                })
                .collect::<Vec<_>>(),
            None,
        )
    }

    fn lines(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| line.to_string()).collect()
    }

    fn judged(types: &[&str], default_type: Option<&str>) -> Result<(), Violation> {
        check(
            Some(&catalog()),
            &Settings {
                types: &lines(types),
                default_type,
                ..Settings::default()
            },
        )
    }

    #[test]
    fn a_default_type_outside_the_query_is_refused() {
        let refused = judged(&["core.note"], Some("core.task")).unwrap_err();
        assert_eq!(refused.path, "defaults.type");
        assert!(refused.message.contains("core.task"), "{refused:?}");
        assert!(judged(&["core.note"], Some("core.note")).is_ok());
        assert!(judged(&["core.media"], Some("core.media.photo")).is_ok());
        assert!(judged(&["core.media.photo"], Some("core.media")).is_err());
        assert!(judged(&[], Some("core.task")).is_ok());
    }

    #[test]
    fn the_star_holds_every_type_but_the_system_types() {
        for types in [&["*"][..], &[" * "], &["*", "core.note"]] {
            assert!(judged(types, Some("core.task")).is_ok(), "{types:?}");
        }
        assert!(!holds_type(&catalog(), &lines(&["*"]), "system.folder"));
        assert_eq!(slice_types(&lines(&[" * ", "core.note"])), lines(&["*"]));
        assert_eq!(slice_types(&lines(&[" core.note "])), lines(&["core.note"]));
    }

    #[test]
    fn a_line_that_is_no_pattern_is_refused_in_either_list() {
        for bad in ["{a,b", "a{b", "[z-a]"] {
            let include = lines(&[bad]);
            let refused = check(
                Some(&catalog()),
                &Settings {
                    include: &include,
                    ..Settings::default()
                },
            )
            .unwrap_err();
            assert_eq!(refused.path, "include", "{bad}");
            assert!(refused.message.contains(bad), "{refused:?}");
            let refused = check(
                Some(&catalog()),
                &Settings {
                    ignore: &include,
                    ..Settings::default()
                },
            )
            .unwrap_err();
            assert_eq!(refused.path, "ignore", "{bad}");
        }
        let sound = lines(&["*.md", "{a,b}/", "!keep.md", "# a comment", "", "[abc"]);
        assert!(
            check(
                Some(&catalog()),
                &Settings {
                    include: &sound,
                    ignore: &sound,
                    ..Settings::default()
                }
            )
            .is_ok()
        );
    }

    fn patterns(include: &[String], ignore: &[String]) -> Result<(), Violation> {
        check(
            None,
            &Settings {
                include,
                ignore,
                ..Settings::default()
            },
        )
    }

    #[test]
    fn lists_that_compile_past_the_bound_are_refused() {
        let wild = vec!["?".repeat(500); 12];
        let refused = patterns(&wild, &[]).unwrap_err();
        assert_eq!(refused.path, "include");
        assert!(refused.message.contains("too long"), "{refused:?}");
        let refused = patterns(&[], &wild).unwrap_err();
        assert_eq!(refused.path, "ignore");
        let some = vec!["?".repeat(500)];
        assert!(patterns(&some, &some).is_ok());
    }

    #[test]
    fn lists_that_hold_too_much_text_together_are_refused() {
        let line = "a".repeat(1_000);
        let half = vec![line; 4];
        assert!(patterns(&half, &[]).is_ok());
        let refused = patterns(&half, &half).unwrap_err();
        assert_eq!(refused.path, "ignore");
        assert!(refused.message.contains("characters"), "{refused:?}");
    }

    fn placed(directory: &str) -> Result<(), Violation> {
        check(
            None,
            &Settings {
                first_placement: &[("core.note", directory)],
                ..Settings::default()
            },
        )
    }

    #[test]
    fn a_placement_outside_the_folder_is_refused() {
        for outside in ["/abs", "C:\\x", "C:x", "a\\b", "a/../b", "..", "a\0b"] {
            assert!(placed(outside).is_err(), "{outside}");
        }
        for inside in ["Notes", "a/b", "./a", "Notes/2026"] {
            assert!(placed(inside).is_ok(), "{inside}");
        }
    }

    #[test]
    fn a_default_tier_the_query_does_not_hold_is_refused() {
        let judged = |tier: Option<&str>, default_tier: Option<&str>| {
            check(
                None,
                &Settings {
                    tier,
                    default_tier,
                    ..Settings::default()
                },
            )
        };
        assert_eq!(
            judged(None, Some("feed")).unwrap_err().path,
            "defaults.tier"
        );
        assert!(judged(Some("library"), Some("feed")).is_err());
        assert!(judged(Some("feed"), Some("library")).is_err());
        for (tier, default_tier) in [(None, Some("library")), (Some("all"), Some("feed"))] {
            assert!(judged(tier, default_tier).is_ok(), "{tier:?}");
        }
    }

    #[test]
    fn a_threshold_and_an_interval_hold_their_bounds() {
        let removal = |files, fraction| {
            check(
                None,
                &Settings {
                    removal: Threshold {
                        files: Some(files),
                        fraction: Some(fraction),
                    },
                    ..Settings::default()
                },
            )
        };
        assert!(removal(MOST_FILES, 1.0).is_ok());
        for (files, fraction) in [(MOST_FILES + 2.0, 0.5), (-1.0, 0.5), (1.5, 0.5), (1.0, 1.1)] {
            assert!(removal(files, fraction).is_err(), "{files} {fraction}");
        }
        let interval = |seconds: f64| {
            check(
                None,
                &Settings {
                    full_pass_interval_seconds: Some(seconds),
                    ..Settings::default()
                },
            )
        };
        for seconds in [60.0, 86_400.0] {
            assert!(interval(seconds).is_ok(), "{seconds}");
        }
        for seconds in [59.0, 86_401.0, 60.5, f64::NAN] {
            assert!(interval(seconds).is_err(), "{seconds}");
        }
    }

    #[test]
    fn a_state_a_filter_and_a_default_a_folder_cannot_hold_are_refused() {
        let states = lines(&["active", "deleted"]);
        let refused = check(
            None,
            &Settings {
                state: Some(&states),
                ..Settings::default()
            },
        )
        .unwrap_err();
        assert_eq!(refused.path, "query.state.1");
        assert!(
            check(
                None,
                &Settings {
                    state: Some(&[]),
                    ..Settings::default()
                }
            )
            .is_err()
        );
        let backref = check(
            None,
            &Settings {
                filter: Some("backref[parent-of] exists"),
                ..Settings::default()
            },
        )
        .unwrap_err();
        assert_eq!(backref.path, "query.filter");
        assert!(backref.message.contains("backref"), "{backref:?}");
        let properties = serde_json::json!({ "": 1 });
        let refused = check(
            None,
            &Settings {
                properties: properties.as_object(),
                ..Settings::default()
            },
        )
        .unwrap_err();
        assert_eq!(refused.path, "defaults.properties");
    }
}
