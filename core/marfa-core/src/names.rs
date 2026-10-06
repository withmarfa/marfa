//! Names compare in NFC and without regard to case, as macOS and Obsidian
//! compare them.

use unicode_normalization::UnicodeNormalization;

pub(crate) fn folded(name: &str) -> String {
    // Normalized again after lowercasing, since a lowercase mapping can
    // leave a sequence that composes differently.
    name.nfc().flat_map(char::to_lowercase).nfc().collect()
}

pub(crate) fn same(one: &str, other: &str) -> bool {
    folded(one) == folded(other)
}

/// The server compares text as it is sent, so a typed name may be held there
/// in either form.
pub(crate) fn forms(name: &str) -> Vec<String> {
    let mut forms = vec![name.nfc().collect::<String>(), name.nfd().collect()];
    forms.dedup();
    forms
}

pub(crate) fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub(crate) fn title_of(path: &str) -> String {
    let name = name_of(path);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
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
        assert!(!same("plan.md", "plans.md"));
        assert_eq!(forms(composed), forms(decomposed));
        assert_eq!(forms("plain").len(), 1);
    }
}
