use std::path::Path;
use std::sync::OnceLock;

use globset::GlobBuilder;
use regex::{Regex, RegexBuilder, RegexSet, RegexSetBuilder};
use unicode_normalization::UnicodeNormalization;

use crate::Result;
use crate::error::CoreError;

/// The folder's own state, and another folder's inside it.
const STATE: &[&str] = &[".marfa"];

const JUNK: &[&str] = &[
    ".DS_Store",
    "Thumbs.db",
    "._*",
    ".Spotlight-V100",
    ".Trashes",
    // A class, because a gitignore line loses a trailing `\r` as whitespace.
    "Icon[\r]",
    "desktop.ini",
];

/// What an editor keeps beside an open file, and what a download or a copy
/// writes before its bytes are whole.
const SWAP: &[&str] = &[
    "*.swp",
    "*~",
    ".#*",
    // Escaped, because a gitignore line opening with `#` is a comment.
    "\\#*#",
    "~$*",
    "*.tmp",
    ".~lock.*#",
    "*___jb_tmp___",
    "*___jb_old___",
    "*.crswap",
    "*.crdownload",
    "*.part",
    "*.download",
];

/// Files that exist to hold a secret in a form anyone holding the file can
/// use: sent, it reaches every machine and key that reads the folder, and
/// cannot be called back.
const SECRETS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_dsa*",
    "id_ecdsa*",
    "id_ed25519*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    "credentials",
    "*credentials.json",
    "credentials.db",
];

/// Directory extensions macOS shows and opens as one document or program.
const PACKAGES: &[&str] = &[
    "app",
    "bundle",
    "pages",
    "numbers",
    "key",
    "photoslibrary",
    "xcodeproj",
    "rtfd",
];

pub struct Lists {
    machine: &'static Patterns,
    secrets: &'static Patterns,
    include: Patterns,
    /// The include lines that name a dot-led name, which alone reach one.
    dotted: Patterns,
    /// Those dot-led names, so the walk enters only a directory one names.
    dotted_names: Vec<DotName>,
    ignore: Patterns,
}

struct Patterns {
    original: Lines,
    folded: Lines,
}

/// One list's gitignore lines, compiled together.
struct Lines {
    set: RegexSet,
    /// Each pattern in `set`, in order.
    lines: Vec<Line>,
}

struct Line {
    /// The line's place in its list, which decides between two that match.
    index: usize,
    is_whitelist: bool,
    is_only_dir: bool,
}

impl Lines {
    fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// The last line that matches `path`, as gitignore reads a list.
    fn matched(&self, path: &str, is_dir: bool) -> Option<&Line> {
        self.set
            .matches(path)
            .into_iter()
            .rev()
            .map(|at| &self.lines[at])
            .find(|line| !line.is_only_dir || is_dir)
    }
}

struct DotName {
    original: Regex,
    folded: Regex,
}

impl DotName {
    fn is_match(&self, name: &str) -> bool {
        self.original.is_match(name) || self.folded.is_match(&crate::names::folded(name))
    }
}

impl Lists {
    pub fn new(include: &[String], ignore: &[String]) -> Result<Lists> {
        let owned = |lines: &[&str]| {
            lines
                .iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
        };
        let dotted: Vec<String> = include
            .iter()
            .filter(|line| line.trim_start().starts_with('!') || !dot_names(line).is_empty())
            .cloned()
            .collect();
        let mut dotted_names = Vec::new();
        // A `!` line names no directory to enter.
        for name in include
            .iter()
            .filter(|line| !line.trim_start().starts_with('!'))
            .flat_map(|line| dot_names(line))
        {
            let compile = |pattern: &str, folded: bool| {
                GlobBuilder::new(pattern)
                    .literal_separator(true)
                    .build()
                    .map_err(|error| error.to_string())
                    .and_then(|glob| {
                        limited(&mut RegexBuilder::new(&by_character(glob.regex(), folded)))
                            .build()
                            .map_err(|error| error.to_string())
                    })
                    .map_err(|why| refused("include", &name, &why))
            };
            dotted_names.push(DotName {
                original: compile(&name, false)?,
                folded: compile(&folded_pattern(&name), true)?,
            });
        }
        // Compiled once: every pass builds the folder's lists, and these
        // lines never change.
        static BUILT_IN: OnceLock<(Patterns, Patterns)> = OnceLock::new();
        let (machine, secrets) = BUILT_IN.get_or_init(|| {
            (
                built("built-in", &owned(&[STATE, JUNK, SWAP].concat()))
                    .expect("the built-in lines are patterns"),
                built("built-in", &owned(SECRETS)).expect("the built-in lines are patterns"),
            )
        });
        Ok(Lists {
            machine,
            secrets,
            include: built("include", include)?,
            dotted: built("include", &dotted)?,
            dotted_names,
            ignore: built("ignore", ignore)?,
        })
    }

    /// As wide as the built-in lists, entering the dot-led directories
    /// `include` names: a look into another folder never narrower than it.
    pub(super) fn wider(include: &[String]) -> Result<Lists> {
        let mut lines = vec!["*".to_string()];
        lines.extend(
            include
                .iter()
                .filter(|line| !line.trim_start().starts_with('!') && !dot_names(line).is_empty())
                .cloned(),
        );
        Lists::new(&lines, &[])
    }

    /// Whether the folder takes the file at `relative`, a path inside it
    /// with `/` between its names.
    pub fn takes(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        let folded = crate::names::folded(&path);
        if [self.machine, self.secrets, &self.ignore]
            .into_iter()
            .any(|list| hit(list, &path, &folded, false))
        {
            return false;
        }
        if !self.include.original.is_empty() && !hit(&self.include, &path, &folded, false) {
            return false;
        }
        // Every dot-led directory on the way is one the walk enters, or a
        // pull would write where no scan looks.
        let (name, directories) = path
            .rsplit_once('/')
            .map_or((path.as_str(), ""), |(dirs, name)| (name, dirs));
        if directories
            .split('/')
            .filter(|dir| dir.starts_with('.'))
            .any(|dir| !self.dotted_names.iter().any(|glob| glob.is_match(dir)))
        {
            return false;
        }
        !name.starts_with('.') || hit(&self.dotted, &path, &folded, false)
    }

    pub(super) fn secret(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        hit(self.secrets, &path, &crate::names::folded(&path), false)
    }

    /// A secret's name is refused file by file, so a package named like one is
    /// still reported.
    pub(super) fn enters(&self, relative: &str) -> bool {
        let path: String = relative.nfc().collect();
        let folded = crate::names::folded(&path);
        if hit(self.machine, &path, &folded, true) || hit(&self.ignore, &path, &folded, true) {
            return false;
        }
        let name = path.rsplit('/').next().unwrap_or(&path);
        !name.starts_with('.') || self.dotted_names.iter().any(|glob| glob.is_match(name))
    }
}

fn hit(list: &Patterns, path: &str, folded: &str, mut is_dir: bool) -> bool {
    let (mut path, mut folded) = (path, folded);
    loop {
        // Resolve line order across both forms before walking to a parent:
        // a direct match, including a negation, takes precedence over one there.
        let matched = [
            list.original.matched(path, is_dir),
            list.folded.matched(folded, is_dir),
        ]
        .into_iter()
        .flatten()
        .max_by_key(|line| line.index);
        if let Some(line) = matched {
            return !line.is_whitelist;
        }
        let (Some((parent, _)), Some((folded_parent, _))) =
            (path.rsplit_once('/'), folded.rsplit_once('/'))
        else {
            return false;
        };
        (path, folded, is_dir) = (parent, folded_parent, true);
    }
}

fn built(list: &str, lines: &[String]) -> Result<Patterns> {
    let (mut original, mut folded) = ((Vec::new(), Vec::new()), (Vec::new(), Vec::new()));
    for (index, line) in lines.iter().enumerate() {
        let pattern: String = line.nfc().collect();
        let refuse = |why: String| refused(list, line, &why);
        for (form, is_folded, (regexes, read)) in [
            (pattern.clone(), false, &mut original),
            (folded_pattern(&pattern), true, &mut folded),
        ] {
            if let Some((regex, line)) = compiled(index, &form, is_folded).map_err(refuse)? {
                regexes.push(regex);
                read.push(line);
            }
        }
    }
    let set = |(regexes, lines): (Vec<String>, Vec<Line>)| {
        limited_set(&mut RegexSetBuilder::new(&regexes))
            .build()
            .map(|set| Lines { set, lines })
            .map_err(|error| refused(list, "", &error.to_string()))
    };
    Ok(Patterns {
        original: set(original)?,
        folded: set(folded)?,
    })
}

/// A gitignore line, read as git reads one: a comment or a blank line is
/// nothing, `!` negates, a leading `/` anchors it to the folder, a trailing
/// `/` matches only a directory, and a line with no other `/` matches a name
/// at any depth. Answers the line's regex and what else it says.
fn compiled(
    index: usize,
    line: &str,
    folded: bool,
) -> std::result::Result<Option<(String, Line)>, String> {
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
    let regex = by_character(glob.regex(), folded);
    // Refused here, line by line, so the refusal names the line.
    limited(&mut RegexBuilder::new(&regex))
        .build()
        .map_err(|error| error.to_string())?;
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
        .size_limit(10 << 20)
        .dfa_size_limit(10 << 20)
}

fn limited_set(builder: &mut RegexSetBuilder) -> &mut RegexSetBuilder {
    builder
        .dot_matches_new_line(true)
        .size_limit(10 << 20)
        .dfa_size_limit(10 << 20)
}

/// A glob's regex, read over characters. globset writes its regex over bytes,
/// spelling each character outside ASCII as its UTF-8 bytes, so a class, a
/// negated class or a `?` meets such a character as several bytes and cannot
/// match it as one. Read again with those bytes as the characters they spell,
/// the regex matches by character, as the pattern's literals already do.
///
/// Case is ignored for ASCII letters alone, as globset ignores it. The folded
/// form carries the rest: its literals are folded already, and `folded` adds
/// to each class the lowercase of its members, so a pattern matches what the
/// name comparison (`names::same`) calls the same name and nothing more.
fn by_character(bytes: &str, folded: bool) -> String {
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
    ascii_case_free(&decoded, folded)
}

/// The regex with each ASCII letter, alone or in a class, standing for both
/// its cases, and with `folded`, each class holding its members' lowercase.
fn ascii_case_free(source: &str, folded: bool) -> String {
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
                if folded {
                    for &(start, end) in &ranges {
                        let members = (start as u32)..=(end as u32);
                        // A range wider than a script's letters is not
                        // walked: its lowercase is mostly itself.
                        if members.clone().count() > FOLDED_RANGE_LIMIT {
                            continue;
                        }
                        for ch in members.filter_map(char::from_u32) {
                            let mut lower = ch.to_lowercase();
                            if let (Some(one), None) = (lower.next(), lower.next())
                                && one != ch
                            {
                                both.push((one, one));
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

/// The widest class range whose members' lowercase a folded class holds.
const FOLDED_RANGE_LIMIT: usize = 1024;

fn class_member(out: &mut String, ch: char) {
    if matches!(ch, '\\' | '[' | ']' | '^' | '-' | '&' | '~') {
        out.push('\\');
    }
    out.push(ch);
}

fn folded_pattern(pattern: &str) -> String {
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

fn refused(list: &str, line: &str, why: &str) -> CoreError {
    CoreError::Invalid(format!(
        "the folder's {list} list holds {line:?}, which is not a gitignore pattern: {why}"
    ))
}

fn dot_names(line: &str) -> Vec<String> {
    let line = line.trim();
    let line = line.strip_prefix('!').unwrap_or(line);
    line.nfc()
        .collect::<String>()
        .split('/')
        .filter(|name| name.starts_with('.') && *name != "." && *name != "..")
        .map(str::to_string)
        .collect()
}

pub(super) fn is_package(path: &Path) -> bool {
    // Only a name with an extension is asked of the system, which a walk
    // would otherwise ask of every directory on every pass.
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    PACKAGES
        .iter()
        .any(|known| known.eq_ignore_ascii_case(extension))
        || system::marks(path)
}

pub(super) fn in_package(root: &Path, relative: &str) -> bool {
    let mut here = root.to_path_buf();
    let mut names = relative.split('/').peekable();
    while let Some(name) = names.next() {
        if names.peek().is_none() {
            break;
        }
        here.push(name);
        if is_package(&here) {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
mod system {
    use std::path::Path;

    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::error::CFErrorRef;
    use core_foundation::string::CFStringRef;
    use core_foundation::url::{CFURL, CFURLRef, kCFURLIsPackageKey};

    unsafe extern "C" {
        fn CFURLCopyResourcePropertyForKey(
            url: CFURLRef,
            key: CFStringRef,
            value: *mut CFTypeRef,
            error: *mut CFErrorRef,
        ) -> u8;
    }

    /// Whether the system opens the directory as one thing, by its type or
    /// by the bundle bit, as the Finder does.
    pub(super) fn marks(path: &Path) -> bool {
        let Some(url) = CFURL::from_path(path, true) else {
            return false;
        };
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: the URL outlives the call, the key is CoreFoundation's own
        // constant, and a null error pointer asks for no error.
        let found = unsafe {
            CFURLCopyResourcePropertyForKey(
                url.as_concrete_TypeRef(),
                kCFURLIsPackageKey,
                &mut value,
                std::ptr::null_mut(),
            )
        };
        if found == 0 || value.is_null() {
            return false;
        }
        // SAFETY: a Copy function hands its caller the one reference, which
        // the wrapper releases.
        let value = unsafe { CFType::wrap_under_create_rule(value) };
        value.downcast::<CFBoolean>().is_some_and(bool::from)
    }
}

#[cfg(not(target_os = "macos"))]
mod system {
    pub(super) fn marks(_path: &std::path::Path) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lists(include: &[&str], ignore: &[&str]) -> Lists {
        let owned = |lines: &[&str]| {
            lines
                .iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
        };
        Lists::new(&owned(include), &owned(ignore)).unwrap()
    }

    #[test]
    fn an_include_narrows_and_an_ignore_removes_even_from_it() {
        let narrowed = lists(&["Notes/", "*.txt"], &["Notes/drafts/"]);
        assert!(narrowed.takes("Notes/plan.md"));
        assert!(narrowed.takes("elsewhere/list.txt"));
        assert!(!narrowed.takes("elsewhere/plan.md"));
        assert!(!narrowed.takes("Notes/drafts/plan.md"));
        assert!(!narrowed.enters("Notes/drafts"));
        assert!(narrowed.takes("notes/Plan.md"));
        assert!(lists(&["Caf\u{e9}/"], &[]).takes("Cafe\u{301}/menu.md"));
    }

    #[test]
    fn an_include_reaches_a_dot_led_path_only_where_it_names_one() {
        let dotted = lists(&[".notes/", "*.md"], &[]);
        assert!(dotted.enters(".notes"));
        assert!(dotted.takes(".notes/a.md"));
        assert!(dotted.takes(".notes/deep/a.md"));
        assert!(!dotted.enters(".git"));
        assert!(!dotted.takes(".git/a.md"));
        assert!(!dotted.enters(".marfa"));
        assert!(!lists(&[".marfa/"], &[]).takes(".marfa/folder.yaml"));
    }

    #[test]
    fn a_wider_look_enters_what_the_folder_includes_and_everything_else() {
        let wider = Lists::wider(&["*.md".into(), ".notes/".into(), "!.notes/x".into()]).unwrap();
        assert!(wider.enters(".notes"));
        assert!(wider.takes(".notes/plan.md"));
        assert!(wider.takes(".notes/x"));
        assert!(wider.takes("photo.png"));
        assert!(!wider.enters(".git"));
        assert!(!wider.takes(".env"));
    }

    #[test]
    fn a_built_in_line_stands_whatever_the_lists_say() {
        let reaching = lists(&[".env", "*.pem", ".DS_Store", "*.swp", "*"], &[]);
        for path in [
            ".env",
            "deep/.env.local",
            "server.pem",
            "Server.PEM",
            "ssh/id_ed25519",
            "id_rsa.pub",
            "Deep/credentials",
            "gcloud/application_default_credentials.json",
            ".DS_Store",
            "._photo.jpg",
            "Icon\r",
            "desktop.ini",
            "note.md.swp",
            "note.md~",
            "~$report.docx",
            ".~lock.sheet.ods#",
            "draft.tmp",
            "#note.md#",
            "Deep/#note.md#",
            "notes.txt___jb_tmp___",
            "notes.txt___jb_old___",
            "page.html.crswap",
            "report.pdf.crdownload",
            "archive.zip.part",
            "movie.mov.download",
            "image.png.download/image.png",
        ] {
            assert!(!reaching.takes(path), "{path:?} was taken");
        }
        assert!(reaching.takes("note.md"));
        assert!(reaching.takes("Icon"));
        assert!(reaching.takes("#hashtag.md"));
        assert!(!reaching.enters("image.png.download"));
    }

    #[test]
    fn refuses_a_line_that_is_not_a_pattern() {
        let bad = vec!["a{b".to_string()];
        assert!(Lists::new(&bad, &[]).is_err());
        assert!(Lists::new(&[], &bad).is_err());
    }

    #[test]
    fn literal_folding_preserves_classes_and_escaped_metacharacters() {
        for pattern in ["[A-z]CAFÉ.md", "[Z-a]CAFÉ.md"] {
            let included = lists(&[pattern], &[]);
            assert!(included.takes("_Cafe\u{301}.md"));
            assert!(!included.takes("5Café.md"));
        }
        for (pattern, name) in [
            ("[]A-Z]CAFÉ.md", "]café.md"),
            ("[!A-Z]CAFÉ.md", "5café.md"),
            ("[CAFÉ.md", "[café.md"),
            (r"\[CAFÉ\].md", "[café].md"),
            (r"\?CAFÉ.md", "?café.md"),
            (r"\!CAFÉ.md", "!café.md"),
            (r"\#CAFÉ.md", "#café.md"),
            (r"\{CAFÉ\}.md", "{café}.md"),
            (r"\\CAFÉ.md", "\\café.md"),
            (r"CAFÉ.md\ ", "café.md "),
            ("\\J\u{30c}.md", "ǰ.md"),
            ("J\\\u{30c}.md", "ǰ.md"),
            ("{CAFÉ,ÉTÉ}.md", "été.md"),
        ] {
            assert!(lists(&[pattern], &[]).takes(name), "{pattern:?}, {name:?}");
        }
        assert!(Lists::new(&["[z-a]".into()], &[]).is_err());
        assert!(Lists::new(&[], &["[z-a]".into()]).is_err());
    }

    #[test]
    fn a_class_or_a_question_mark_matches_one_character_outside_ascii() {
        for (pattern, name, matches) in [
            ("caf[\u{e9}\u{e8}].md", "caf\u{e9}.md", true),
            ("caf[\u{e9}\u{e8}].md", "caf\u{e8}.md", true),
            ("caf[\u{e9}\u{e8}].md", "cafe.md", false),
            ("caf[\u{e0}-\u{ea}].md", "caf\u{e9}.md", true),
            ("caf[\u{e0}-\u{ea}].md", "caf\u{eb}.md", false),
            ("CAF[\u{c9}].md", "caf\u{e9}.md", true),
            ("caf[\u{e9}].md", "cafe\u{301}.md", true),
            ("caf[!\u{e9}].md", "caf\u{e8}.md", true),
            ("caf[!\u{e9}].md", "caf\u{e9}.md", false),
            ("caf?.md", "caf\u{e9}.md", true),
            ("caf?.md", "caf.md", false),
            (
                "\u{65e5}[\u{672c}]?.md",
                "\u{65e5}\u{672c}\u{8a9e}.md",
                true,
            ),
        ] {
            assert_eq!(
                !lists(&[], &[pattern]).takes(name),
                matches,
                "{pattern:?}, {name:?}"
            );
        }
        assert!(lists(&[".caf[\u{e9}]/"], &[]).enters(".caf\u{e9}"));
    }

    #[test]
    fn a_wildcard_crosses_a_newline_in_a_name() {
        let bare = lists(&[], &[]);
        assert!(!bare.takes("keys\n/id_rsa"));
        assert!(!bare.takes("a\nb/server.pem"));
        assert!(!bare.takes("}\n/k~~"));
        assert!(lists(&["docs/**"], &[]).takes("docs/a\nb.md"));
        assert!(!lists(&[], &["drafts/**"]).takes("drafts/a\nb.md"));
        assert!(lists(&[".a*/"], &[]).enters(".a\nb"));
    }

    #[test]
    fn case_is_ignored_as_names_compare_and_no_further() {
        // Unicode's own case pairs that the name comparison does not fold.
        assert!(lists(&[], &["S"]).takes("\u{17f}"));
        assert!(lists(&[], &["*\u{3c3}.md"]).takes("\u{3bb}\u{3cc}\u{3b3}\u{3bf}\u{3c2}.md"));
        // What it does fold, through the folded form.
        assert!(!lists(&[], &["k"]).takes("\u{212a}"));
        assert!(!lists(&[], &["CAF\u{c9}.md"]).takes("caf\u{e9}.md"));
        // ASCII case in classes and literals alike.
        assert!(!lists(&[], &["[a-c]*.MD"]).takes("B.md"));
        assert!(!lists(&[], &["[!a-c]*.md"]).takes("D.md"));
        assert!(lists(&[], &["[!a-c]*.md"]).takes("C.md"));
    }

    #[test]
    fn a_line_naming_only_directories_never_names_the_folder_itself() {
        assert!(!lists(&["*/"], &[]).takes("top.md"));
        assert!(lists(&["*/"], &[]).takes("deep/top.md"));
        assert!(!lists(&["/"], &[]).takes("top.md"));
        assert!(lists(&[], &["**/"]).takes("top.md"));
    }

    #[test]
    fn wildcard_matching_keeps_the_original_name_alongside_its_folded_form() {
        assert!(lists(&["??.md"], &[]).takes("İ.md"));
        assert!(!lists(&[], &["??.md"]).takes("İ.md"));
        let dotted = lists(&[".??/**"], &[]);
        assert!(dotted.enters(".İ"));
        assert!(dotted.takes(".İ/note.md"));
    }

    #[test]
    fn line_order_is_shared_by_original_and_folded_matches() {
        assert!(!lists(&["??.md", "!i\u{307}.md"], &[]).takes("İ.md"));
        assert!(lists(&["!i\u{307}.md", "??.md"], &[]).takes("İ.md"));
        assert!(lists(&[], &["??.md", "!i\u{307}.md"]).takes("İ.md"));
        assert!(!lists(&[], &["!i\u{307}.md", "??.md"]).takes("İ.md"));

        // More than ten lines distinguish numeric from unpadded string order.
        let mut ignore = vec![""; 12];
        ignore[2] = "??.md";
        ignore[10] = "!i\u{307}.md";
        assert!(lists(&[], &ignore).takes("İ.md"));
        ignore.swap(2, 10);
        assert!(!lists(&[], &ignore).takes("İ.md"));
    }

    #[test]
    fn both_forms_match_the_path_before_considering_its_parents() {
        assert!(!lists(&["!i\u{307}/keep.md", "??/"], &[]).takes("İ/keep.md"));
        assert!(lists(&["i\u{307}/keep.md", "!??/"], &[]).takes("İ/keep.md"));
        assert!(!lists(&[], &["i\u{307}/keep.md", "!??/"]).takes("İ/keep.md"));
        assert!(lists(&[], &["!i\u{307}/keep.md", "??/"]).takes("İ/keep.md"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_directory_the_system_marks_is_a_package() {
        let dir = tempfile::tempdir().unwrap();
        let marked = dir.path().join("Thing.mystery");
        std::fs::create_dir(&marked).unwrap();
        assert!(
            !is_package(&marked),
            "an unmarked directory read as a package"
        );
        // The Finder's bundle bit, in the Finder info's flags.
        let mut info = [0u8; 32];
        info[8] = 0x20;
        let set = std::process::Command::new("xattr")
            .args(["-wx", "com.apple.FinderInfo"])
            .arg(
                info.iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            )
            .arg(&marked)
            .status()
            .unwrap();
        assert!(set.success());
        assert!(
            is_package(&marked),
            "a directory the system marks was not read as a package"
        );
    }
}
