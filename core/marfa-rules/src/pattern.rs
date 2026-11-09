//! The gitignore grammar a folder's `include` and `ignore` lists are written in:
//! one reading for the device that matches with it and the server that refuses
//! a line before it is stored.

use std::collections::HashMap;
use std::sync::OnceLock;

use globset::GlobBuilder;
use regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use unicode_normalization::UnicodeNormalization;

/// One line of a list, as it decides between two that match.
#[derive(Debug, Clone)]
pub struct Line {
    /// The line's place in its list.
    pub index: usize,
    pub is_whitelist: bool,
    pub is_only_dir: bool,
}

/// One form of a list: each line's regex beside what the line says.
#[derive(Debug, Default)]
pub struct Form {
    pub regexes: Vec<String>,
    pub lines: Vec<Line>,
}

/// A list's lines as written and with their names folded.
#[derive(Debug)]
pub struct Compiled {
    pub original: Form,
    pub folded: Form,
}

/// Each line read, or the refusal naming the first that is no pattern.
pub fn compile_list(list: &str, lines: &[String]) -> Result<Compiled, String> {
    let mut compiled = Compiled {
        original: Form::default(),
        folded: Form::default(),
    };
    for (index, original) in lines.iter().enumerate() {
        let pattern: String = original.nfc().collect();
        for (form, read) in [
            (pattern.clone(), &mut compiled.original),
            (folded(&pattern), &mut compiled.folded),
        ] {
            if let Some((regex, line)) =
                compile(index, &form).map_err(|why| refusal(list, original, &why))?
            {
                read.regexes.push(regex);
                read.lines.push(line);
            }
        }
    }
    Ok(compiled)
}

/// One form of a list, compiled together.
#[derive(Debug)]
pub struct Set {
    pub set: RegexSet,
    /// Each pattern in `set`, in order.
    pub lines: Vec<Line>,
}

/// A list's lines as written and with their names folded, ready to match with.
#[derive(Debug)]
pub struct Built {
    pub original: Set,
    pub folded: Set,
}

/// A list ready to match with, or the refusal naming the line that is no
/// pattern, or saying the list compiles past the bound.
pub fn build_list(list: &str, lines: &[String]) -> Result<Built, String> {
    let compiled = compile_list(list, lines)?;
    let set = |form: Form| match limited_set(&form.regexes) {
        Ok(set) => Ok(Set {
            set,
            lines: form.lines,
        }),
        Err(error) => Err(read_again(list, lines, &form, &error)),
    };
    Ok(Built {
        original: set(compiled.original)?,
        folded: set(compiled.folded)?,
    })
}

/// The refusal for a form that failed to compile together: the line whose
/// regex fails alone, or the list's length.
fn read_again(list: &str, lines: &[String], form: &Form, error: &regex::Error) -> String {
    for (regex, line) in form.regexes.iter().zip(&form.lines) {
        if let Err(why) = limited(&mut RegexBuilder::new(regex)).build() {
            return refusal(list, &lines[line.index], &why.to_string());
        }
    }
    format!("the folder's {list} list is too long to match: {error}")
}

fn limited_set(regexes: &[String]) -> Result<RegexSet, regex::Error> {
    RegexSetBuilder::new(regexes)
        .dot_matches_new_line(true)
        .size_limit(SET_LIMIT)
        .dfa_size_limit(SET_LIMIT)
        .build()
}

/// Whether the include and ignore lists hold no more text together than a
/// device compiles. Counting costs nothing, so it is judged on the settings a
/// write leaves.
pub fn check_text(include: &[String], ignore: &[String]) -> Result<(), (&'static str, String)> {
    let mut held = 0;
    for (path, lines) in [("include", include), ("ignore", ignore)] {
        held += lines.iter().map(|line| line.chars().count()).sum::<usize>();
        if held > MAX_TEXT {
            return Err((
                path,
                format!(
                    "the folder's include and ignore lists hold at most {MAX_TEXT} characters together"
                ),
            ));
        }
    }
    Ok(())
}

/// Whether every line of a list is a pattern and the list compiles within the
/// bound. Each list stands alone, so two lists compile within twice the bound.
pub fn check_list(list: &str, lines: &[String]) -> Result<(), String> {
    build_list(list, lines)?;
    if list == "include" {
        for name in lines
            .iter()
            .filter(|line| !line.trim_start().starts_with('!'))
            .flat_map(|line| dot_names(line))
        {
            name_regexes(&name)?;
        }
    }
    Ok(())
}

/// The dot-led names an `include` line walks into: a `!` line names no
/// directory to enter.
pub fn dot_names(line: &str) -> Vec<String> {
    let line = line.trim();
    let line = line.strip_prefix('!').unwrap_or(line);
    line.nfc()
        .collect::<String>()
        .split('/')
        .filter(|name| name.starts_with('.') && *name != "." && *name != "..")
        .map(str::to_string)
        .collect()
}

/// The regex that matches a dot-led name an `include` line names, as the
/// line's own form and as its folded form.
pub fn name_regexes(name: &str) -> Result<(Regex, Regex), String> {
    let compile = |pattern: &str| {
        GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| error.to_string())
            .and_then(|glob| {
                limited(&mut RegexBuilder::new(&by_character(glob.regex())))
                    .build()
                    .map_err(|error| error.to_string())
            })
            .map_err(|why| refusal("include", name, &why))
    };
    Ok((compile(name)?, compile(&folded(name))?))
}

pub fn refusal(list: &str, line: &str, why: &str) -> String {
    format!("the folder's {list} list holds {line:?}, which is not a gitignore pattern: {why}")
}

/// The compiled size one form of one list may reach. Compiling stops at it, so a
/// list cannot cost more than this to refuse.
const SET_LIMIT: usize = 1 << 20;

/// The characters the include and ignore lists may hold together.
pub const MAX_TEXT: usize = 6_144;

/// A gitignore line, read as git reads one: a comment or a blank line is
/// nothing, `!` negates, a leading `/` anchors it to the folder, a trailing
/// `/` matches only a directory, and a line with no other `/` matches a name
/// at any depth. Answers the line's regex and what else it says.
fn compile(index: usize, line: &str) -> std::result::Result<Option<(String, Line)>, String> {
    if line.starts_with('#') {
        return Ok(None);
    }
    let mut line = if line.ends_with("\\ ") {
        line
    } else {
        line.trim_end()
    };
    if line.is_empty() {
        return Ok(None);
    }
    let (mut is_whitelist, mut is_only_dir, mut is_absolute) = (false, false, false);
    if line.starts_with("\\!") || line.starts_with("\\#") {
        line = &line[1..];
        is_absolute = line.starts_with('/');
    } else {
        if let Some(rest) = line.strip_prefix('!') {
            is_whitelist = true;
            line = rest;
        }
        if let Some(rest) = line.strip_prefix('/') {
            line = rest;
            is_absolute = true;
        }
    }
    if let Some(rest) = line.strip_suffix('/') {
        is_only_dir = true;
        line = rest.strip_suffix('\\').unwrap_or(rest);
    }
    let mut actual = line.to_string();
    if !is_absolute && !line.contains('/') && !actual.starts_with("**/") && actual != "**" {
        actual = format!("**/{actual}");
    }
    if actual.ends_with("/**") {
        actual.push_str("/*");
    }
    let glob = GlobBuilder::new(&actual)
        .literal_separator(true)
        .backslash_escape(true)
        // As git reads `[` with no `]` after it: a literal bracket.
        .allow_unclosed_class(true)
        .build()
        .map_err(|error| error.kind().to_string())?;
    let regex = by_character(glob.regex());
    Ok(Some((
        regex,
        Line {
            index,
            is_whitelist,
            is_only_dir,
        },
    )))
}

/// As globset builds its own: a wildcard crosses a newline in a name, and a
/// pattern is held to the same size.
fn limited(builder: &mut RegexBuilder) -> &mut RegexBuilder {
    builder
        .dot_matches_new_line(true)
        .size_limit(SET_LIMIT)
        .dfa_size_limit(SET_LIMIT)
}

/// Match Unicode characters using the same case folding as names::same.
fn by_character(bytes: &str) -> String {
    let source = bytes.strip_prefix("(?-u)").unwrap_or(bytes);
    let mut decoded = String::with_capacity(source.len());
    let mut pending: Vec<u8> = Vec::new();
    let flush = |out: &mut String, pending: &mut Vec<u8>| {
        out.push_str(&String::from_utf8_lossy(pending));
        pending.clear();
    };
    let mut chars = source.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            flush(&mut decoded, &mut pending);
            decoded.push(ch);
            continue;
        }
        let mut ahead = chars.clone();
        if ahead.next() == Some('x') {
            let hex: String = ahead.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16)
                && hex.len() == 2
                && byte > 0x7f
            {
                pending.push(byte);
                chars = ahead;
                continue;
            }
        }
        flush(&mut decoded, &mut pending);
        decoded.push('\\');
        if let Some(escaped) = chars.next() {
            decoded.push(escaped);
        }
    }
    flush(&mut decoded, &mut pending);
    case_free(&decoded)
}

/// The regex with each ASCII letter, alone or in a class, standing for both
/// its cases, and each class holding every character the name comparison
/// folds with one of its members.
fn case_free(source: &str) -> String {
    let mut out = String::with_capacity(source.len() * 2);
    let mut chars = source.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                out.push('\\');
                if let Some(escaped) = chars.next() {
                    out.push(escaped);
                }
            }
            '[' => {
                let negated = chars.next_if_eq(&'^').is_some();
                let mut ranges = Vec::new();
                let member = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let ch = chars.next()?;
                    if ch == '\\' { chars.next() } else { Some(ch) }
                };
                while chars.peek().is_some_and(|ch| *ch != ']') {
                    let Some(start) = member(&mut chars) else {
                        break;
                    };
                    let mut ahead = chars.clone();
                    let end =
                        if ahead.next() == Some('-') && ahead.peek().is_some_and(|ch| *ch != ']') {
                            chars.next();
                            member(&mut chars).unwrap_or(start)
                        } else {
                            start
                        };
                    ranges.push((start, end));
                }
                chars.next();
                let mut both = ranges.clone();
                for &(start, end) in &ranges {
                    for (low, high) in [('a', 'z'), ('A', 'Z')] {
                        let (from, to) = (start.max(low), end.min(high));
                        if from <= to {
                            let swap = |ch: char| {
                                if ch.is_ascii_lowercase() {
                                    ch.to_ascii_uppercase()
                                } else {
                                    ch.to_ascii_lowercase()
                                }
                            };
                            both.push((swap(from), swap(to)));
                        }
                    }
                }
                for &(start, end) in &ranges {
                    let members = (start as u32)..=(end as u32);
                    // A range wider than a script's letters is not walked:
                    // its other case is mostly itself.
                    if members.clone().count() > FOLDED_RANGE_LIMIT {
                        continue;
                    }
                    for ch in members.filter_map(char::from_u32) {
                        for &same in folded_with(ch) {
                            if same != ch {
                                both.push((same, same));
                            }
                        }
                    }
                }
                out.push('[');
                if negated {
                    out.push('^');
                }
                for (start, end) in both {
                    class_member(&mut out, start);
                    if start != end {
                        out.push('-');
                        class_member(&mut out, end);
                    }
                }
                out.push(']');
            }
            ch if ch.is_ascii_alphabetic() => {
                out.push('[');
                out.push(ch.to_ascii_lowercase());
                out.push(ch.to_ascii_uppercase());
                out.push(']');
            }
            ch => out.push(ch),
        }
    }
    out
}

/// Every character the name comparison folds as it folds `ch`, `ch` among
/// them, or none where nothing else folds with it.
fn folded_with(ch: char) -> &'static [char] {
    // Read once from every cased character, so a letter more than one case
    // step from another, such as `ß` and `ẞ` or the three forms of `ǅ`, is
    // found as the comparison finds it.
    static FOLDS: OnceLock<HashMap<String, Vec<char>>> = OnceLock::new();
    let folds = FOLDS.get_or_init(|| {
        let mut folds: HashMap<String, Vec<char>> = HashMap::new();
        for cased in (0..=char::MAX as u32)
            .filter_map(char::from_u32)
            .filter(|ch| {
                ch.to_lowercase().ne(std::iter::once(*ch))
                    || ch.to_uppercase().ne(std::iter::once(*ch))
            })
        {
            folds
                .entry(crate::names::folded(&cased.to_string()))
                .or_default()
                .push(cased);
        }
        // The fold itself, where it is one character nothing maps from.
        for (fold, members) in folds.iter_mut() {
            let mut chars = fold.chars();
            if let (Some(one), None) = (chars.next(), chars.next())
                && !members.contains(&one)
            {
                members.push(one);
            }
        }
        folds.retain(|_, members| members.len() > 1);
        folds
    });
    folds
        .get(&crate::names::folded(&ch.to_string()))
        .map_or(&[], Vec::as_slice)
}

/// The widest class range whose members' folded companions a class holds.
const FOLDED_RANGE_LIMIT: usize = 1024;

fn class_member(out: &mut String, ch: char) {
    if matches!(ch, '\\' | '[' | ']' | '^' | '-' | '&' | '~') {
        out.push('\\');
    }
    out.push(ch);
}

pub fn folded(pattern: &str) -> String {
    let mut result = String::new();
    let mut literal = String::new();
    let mut chars = pattern.chars().peekable();
    let flush = |result: &mut String, literal: &mut String| {
        result.push_str(&crate::names::folded(literal));
        literal.clear();
    };
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                if let Some(escaped) = chars.next() {
                    // An unnecessary escape must not split a combining
                    // sequence. Keep only escapes that protect pattern syntax
                    // or whitespace from the gitignore parser.
                    if matches!(
                        escaped,
                        '\\' | '*' | '?' | '[' | ']' | '{' | '}' | ',' | '/' | '#' | '!'
                    ) || escaped.is_whitespace()
                    {
                        literal.push('\\');
                    }
                    literal.push(escaped);
                } else {
                    literal.push('\\');
                }
            }
            '[' => {
                // Class endpoints are syntax, not case-foldable names. An
                // initial ] is a member, including after a negation marker.
                let mut rest = chars.clone();
                let mut class = String::from("[");
                if rest.peek().is_some_and(|ch| matches!(ch, '!' | '^')) {
                    class.push(rest.next().unwrap());
                }
                let mut closed = false;
                for (index, ch) in rest.by_ref().enumerate() {
                    class.push(ch);
                    if ch == ']' && index > 0 {
                        closed = true;
                        break;
                    }
                }
                if closed {
                    flush(&mut result, &mut literal);
                    result.push_str(&class);
                    chars = rest;
                } else {
                    literal.push('[');
                }
            }
            '*' | '?' | '{' | '}' | ',' | '/' => {
                flush(&mut result, &mut literal);
                result.push(ch);
            }
            _ => literal.push(ch),
        }
    }
    flush(&mut result, &mut literal);
    result
}
