//! How a folder compares names (`folders.md` 27): in NFC and without regard
//! to case, as macOS and Obsidian compare them.

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;

/// A name, a path or a title as a folder compares it.
pub(crate) fn folded(name: &str) -> String {
    // Normalized again after lowercasing, since a lowercase mapping can
    // leave a sequence that composes differently.
    name.nfc().flat_map(char::to_lowercase).nfc().collect()
}

/// Whether two names are one name to a folder.
pub(crate) fn same(one: &str, other: &str) -> bool {
    folded(one) == folded(other)
}

/// Each Unicode form a typed name can be held in on the server, which
/// compares the text it is sent as it is.
pub(crate) fn forms(name: &str) -> Vec<String> {
    let mut forms = vec![name.nfc().collect::<String>(), name.nfd().collect()];
    forms.dedup();
    forms
}

/// For each of `keys`, the one of them that holds its name: the one `bound`
/// names, else the first.
pub(crate) fn holders(keys: &[String], bound: impl Fn(&str) -> bool) -> Vec<usize> {
    let mut holder: HashMap<String, usize> = HashMap::new();
    for (at, key) in keys.iter().enumerate() {
        let name = folded(key);
        match holder.get(&name) {
            Some(&held) if bound(&keys[held]) || !bound(key) => {}
            _ => {
                holder.insert(name, at);
            }
        }
    }
    keys.iter().map(|key| holder[&folded(key)]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_differing_only_in_case_or_form_are_one() {
        let composed = "Caf\u{e9}";
        let decomposed = "Cafe\u{301}";
        assert_ne!(composed, decomposed);
        assert!(same(composed, decomposed));
        assert!(same("PLAN.md", "plan.md"));
        assert!(same("\u{c9}t\u{e9}", "e\u{301}te\u{301}"));
        // The control: a different letter is a different name.
        assert!(!same("plan.md", "plans.md"));
        assert_eq!(forms(composed), forms(decomposed));
        assert_eq!(forms("plain").len(), 1);
    }

    #[test]
    fn one_file_holds_a_name_the_bound_one_else_the_first() {
        let keys: Vec<String> = ["a/Note.md", "a/note.md", "b.md", "a/NOTE.md"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(holders(&keys, |_| false), [0, 0, 2, 0]);
        assert_eq!(holders(&keys, |key| key == "a/note.md"), [1, 1, 2, 1]);
        let forms: Vec<String> = ["Caf\u{e9}.md", "Cafe\u{301}.md"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(holders(&forms, |_| false), [0, 0]);
    }
}
