//! What a folder's settings must satisfy for a device to attach it: the server
//! refuses the same settings before it stores them, and the device reads them
//! with the same functions.

use crate::catalog::Catalog;
use crate::edges::depth_inside_folder;
use crate::pattern;
use crate::query::EVERY_TYPE;

/// A refused setting and where it sits in the settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub path: String,
    pub message: String,
}

/// The settings that decide whether a folder can be attached, as the
/// complete settings give them.
#[derive(Debug, Clone, Copy, Default)]
pub struct Settings<'a> {
    pub types: &'a [String],
    pub default_type: Option<&'a str>,
    pub include: &'a [String],
    pub ignore: &'a [String],
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
pub fn check_default_type(
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
pub fn check_placement(type_id: &str, directory: &str) -> Result<(), String> {
    if depth_inside_folder(directory).is_some() {
        return Ok(());
    }
    Err(format!(
        "{type_id}: {directory:?} is not a directory inside the folder: write a path relative to its root, with \"/\" between names and no \"..\" name"
    ))
}

/// The one judgment of the settings a device needs to attach a folder.
pub fn check(catalog: &Catalog, settings: &Settings) -> Result<(), Violation> {
    for (path, lines) in [("include", settings.include), ("ignore", settings.ignore)] {
        pattern::check_list(path, lines).map_err(|message| Violation {
            path: path.to_string(),
            message,
        })?;
    }
    check_default_type(catalog, settings.types, settings.default_type).map_err(|message| {
        Violation {
            path: "defaults.type".to_string(),
            message,
        }
    })
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
            &catalog(),
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
                &catalog(),
                &Settings {
                    include: &include,
                    ..Settings::default()
                },
            )
            .unwrap_err();
            assert_eq!(refused.path, "include", "{bad}");
            assert!(refused.message.contains(bad), "{refused:?}");
            let refused = check(
                &catalog(),
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
                &catalog(),
                &Settings {
                    include: &sound,
                    ignore: &sound,
                    ..Settings::default()
                }
            )
            .is_ok()
        );
    }

    #[test]
    fn a_placement_outside_the_folder_is_refused() {
        for outside in ["/abs", "C:\\x", "C:x", "a\\b", "a/../b", "..", "a\0b"] {
            assert!(check_placement("core.note", outside).is_err(), "{outside}");
        }
        for inside in ["Notes", "a/b", "./a", "Notes/2026"] {
            assert!(check_placement("core.note", inside).is_ok(), "{inside}");
        }
    }
}
