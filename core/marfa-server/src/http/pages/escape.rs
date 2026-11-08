//! Named entities, so a page's text reads the same to any HTML reader.

use std::fmt::{self, Write};

use askama::filters::Escaper;

#[derive(Debug, Clone, Copy, Default)]
pub struct Html;

impl Escaper for Html {
    fn write_escaped_str<W: Write>(&self, mut dest: W, string: &str) -> fmt::Result {
        let mut clean_from = 0;
        for (at, character) in string.char_indices() {
            let entity = match character {
                '&' => "&amp;",
                '<' => "&lt;",
                '>' => "&gt;",
                '"' => "&quot;",
                '\'' => "&#39;",
                _ => continue,
            };
            dest.write_str(&string[clean_from..at])?;
            dest.write_str(entity)?;
            clean_from = at + character.len_utf8();
        }
        dest.write_str(&string[clean_from..])
    }
}
