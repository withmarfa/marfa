//! The icon sets a type's icon may come from.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use super::{Issue, describe};

const LUCIDE: &str = include_str!("../../icons/icon-set-lucide.json");
const SIMPLE_ICONS: &str = include_str!("../../icons/icon-set-simple-icons.json");

#[derive(Deserialize)]
struct RawSet {
    prefix: String,
    version: String,
    icons: Vec<String>,
    #[serde(default)]
    aliases: HashMap<String, String>,
}

struct Set {
    prefix: String,
    version: String,
    icons: HashSet<String>,
    aliases: HashMap<String, String>,
}

fn sets() -> &'static [Set] {
    static SETS: OnceLock<Vec<Set>> = OnceLock::new();
    SETS.get_or_init(|| {
        [LUCIDE, SIMPLE_ICONS]
            .into_iter()
            .filter_map(|text| serde_json::from_str::<RawSet>(text).ok())
            .map(|raw| Set {
                prefix: raw.prefix,
                version: raw.version,
                icons: raw.icons.into_iter().collect(),
                aliases: raw.aliases,
            })
            .collect()
    })
}

pub fn is_icon_id(id: &str) -> bool {
    id.split_once(':').is_some_and(|(prefix, name)| {
        sets()
            .iter()
            .any(|set| set.prefix == prefix && set.icons.contains(name))
    })
}

/// The icon a bare Lucide `name` stands for: that name, or the one it was renamed to. An alias is not itself an accepted id.
fn lucide_icon_id(name: &str) -> Option<String> {
    let lucide = sets().iter().find(|set| set.prefix == "lucide")?;
    if lucide.icons.contains(name) {
        return Some(format!("lucide:{name}"));
    }
    lucide
        .aliases
        .get(name)
        .map(|renamed| format!("lucide:{renamed}"))
}

pub fn icon_issue(value: Option<&Value>, field: &str) -> Option<Issue> {
    if value.and_then(Value::as_str).is_some_and(is_icon_id) {
        return None;
    }
    let sets_named: Vec<String> = sets()
        .iter()
        .map(|set| format!("{} {}", set.prefix, set.version))
        .collect();
    let lucide = value.and_then(Value::as_str).and_then(lucide_icon_id);
    Some(Issue::new(
        field,
        format!(
            "an icon ID, \"<set>:<name>\", from {}",
            sets_named.join(" or ")
        ),
        describe(value),
        match lucide {
            None => "Use an ID from icon-sets.iconify.design, such as \"lucide:calendar-days\" or \"simple-icons:github\".".to_string(),
            Some(id) => format!("Use \"{id}\"."),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sets_load_and_a_name_needs_its_set() {
        assert_eq!(sets().len(), 2);
        assert!(is_icon_id("lucide:calendar-days"));
        assert!(is_icon_id("simple-icons:github"));
        assert!(!is_icon_id("calendar-days"));
        assert!(!is_icon_id("lucide:no-such-icon"));
    }

    #[test]
    fn a_bare_name_stands_for_the_icon_it_names_or_was_renamed_to_and_nothing_else() {
        assert_eq!(
            lucide_icon_id("calendar").as_deref(),
            Some("lucide:calendar")
        );
        assert_eq!(lucide_icon_id("bold").as_deref(), Some("lucide:letter-b"));
        assert_eq!(
            lucide_icon_id("archive-restore").as_deref(),
            Some("lucide:archive-arrow-up")
        );
        assert_eq!(
            lucide_icon_id("circle-parking-off").as_deref(),
            Some("lucide:circle-letter-p-off")
        );
        assert_eq!(
            lucide_icon_id("square-parking-off").as_deref(),
            Some("lucide:square-letter-p-off")
        );
        for name in ["indent", "album", "no-such-icon", "Bold", "toString"] {
            assert_eq!(lucide_icon_id(name), None, "{name}");
        }
        assert!(is_icon_id("lucide:letter-b"));
        assert!(!is_icon_id("lucide:bold"));
    }

    #[test]
    fn the_sets_are_lucide_then_simple_icons() {
        let prefixes: Vec<&str> = sets().iter().map(|set| set.prefix.as_str()).collect();
        assert_eq!(prefixes, ["lucide", "simple-icons"]);
    }
}
