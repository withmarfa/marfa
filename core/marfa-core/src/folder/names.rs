//! How a folder names its files.

use std::collections::HashMap;

use crate::names::folded;

/// The longest name, in bytes of UTF-8, that APFS and ext4 take.
const NAME_LIMIT: usize = 255;

/// Text after a name's last dot longer than this is part of the name, so a
/// cut keeps some of the name.
const EXTENSION_LIMIT: usize = 32;

/// A name as its stem and its extension, dot included, or no extension.
pub(crate) fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(at) if at > 0 && name.len() - at <= EXTENSION_LIMIT => name.split_at(at),
        _ => (name, ""),
    }
}

/// `stem` cut at a character boundary where it and `tail` would make a name
/// longer than a file system takes, then `tail`.
pub(crate) fn fitted(stem: &str, tail: &str) -> String {
    let room = NAME_LIMIT.saturating_sub(tail.len());
    if stem.len() <= room {
        return format!("{stem}{tail}");
    }
    let mut end = room;
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{tail}", stem[..end].trim_end())
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
