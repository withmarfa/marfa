//! The icon sets a type's icon may come from, as the registry pins them.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use super::{Issue, describe};

const LUCIDE: &str = include_str!("../../../../packages/types/generated/icon-set-lucide.json");
const SIMPLE_ICONS: &str =
    include_str!("../../../../packages/types/generated/icon-set-simple-icons.json");

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

/// Whether `id` is `<prefix>:<name>` for an icon of an accepted set.
pub fn is_icon_id(id: &str) -> bool {
    id.split_once(':').is_some_and(|(prefix, name)| {
        sets()
            .iter()
            .any(|set| set.prefix == prefix && set.icons.contains(name))
    })
}

/// The Lucide icon a bare `name` stands for: the icon of that name, or the
/// one it was renamed to. An alias is not itself an accepted id.
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

/// The fault in an icon id, or `None` where it names an icon.
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
}
