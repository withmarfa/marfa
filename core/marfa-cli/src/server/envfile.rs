//! A settings file read and rewritten line by line, so a setting the person
//! added by hand and every comment survive a rewrite. A value is read the
//! way Docker Compose reads it from `env_file`, which is how the container
//! gets it.

use crate::error::CliError;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvFile {
    lines: Vec<String>,
}

fn assignment(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_start();
    if line.starts_with('#') {
        return None;
    }
    let (name, value) = line.split_once('=')?;
    let name = name.trim();
    (!name.is_empty()).then_some((name, value))
}

/// A value as Docker Compose (the `compose-go` dotenv parser) reads it. An
/// unquoted value ends at the first ` #` and loses its trailing space. A value
/// in matching quotes is what lies between them; whatever follows the closing
/// quote, such as a comment, is dropped. Single quotes keep every backslash
/// but one before a quote. Double quotes decode `\a \b \f \n \r \t \v \$ \" \\`.
/// A quote with no partner on the line is left as written, because a value
/// that runs over several lines is beyond a line-by-line reader. `$` and `${}`
/// are not expanded, since that needs the environment Compose runs in.
fn read_value(raw: &str) -> String {
    let raw = raw.trim_start();
    let Some(quote @ ('\'' | '"')) = raw.chars().next() else {
        let value = raw.split_once(" #").map_or(raw, |(value, _)| value);
        return value.trim_end().to_string();
    };
    let body = &raw[1..];
    let mut escaped = false;
    for (at, c) in body.char_indices() {
        if std::mem::take(&mut escaped) {
            continue;
        }
        if c == '\\' {
            escaped = true;
        } else if c == quote {
            return unescape(&body[..at], quote);
        }
    }
    raw.trim_end().to_string()
}

fn unescape(body: &str, quote: char) -> String {
    let mut value = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            value.push(c);
            continue;
        }
        let Some(next) = chars.next() else {
            value.push(c);
            break;
        };
        let decoded = match (quote, next) {
            ('\'', '\'') => Some('\''),
            ('"', 'a') => Some('\u{7}'),
            ('"', 'b') => Some('\u{8}'),
            ('"', 'f') => Some('\u{c}'),
            ('"', 'n') => Some('\n'),
            ('"', 'r') => Some('\r'),
            ('"', 't') => Some('\t'),
            ('"', 'v') => Some('\u{b}'),
            ('"', '$' | '"' | '\\') => Some(next),
            _ => None,
        };
        match decoded {
            Some(decoded) => value.push(decoded),
            None => {
                value.push(c);
                value.push(next);
            }
        }
    }
    value
}

impl EnvFile {
    pub fn parse(text: &str) -> Self {
        Self {
            lines: text.lines().map(str::to_string).collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<String> {
        self.lines
            .iter()
            .filter_map(|line| assignment(line))
            .find(|(found, _)| *found == name)
            .map(|(_, value)| read_value(value))
    }

    /// Replaces the first assignment of `name`, or appends one. A value the
    /// two readers of this file, Docker Compose and `docker run --env-file`,
    /// would read differently is refused, because the container would then
    /// start on a setting the person never wrote.
    pub fn set(&mut self, name: &str, value: &str) -> Result<(), CliError> {
        if value.is_empty()
            || !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._:/@+=,-".contains(c))
        {
            return Err(CliError::Usage(format!(
                "{name} holds a character a settings file cannot carry safely: use letters, digits and . _ : / @ + = , - only"
            )));
        }
        let line = format!("{name}={value}");
        match self
            .lines
            .iter_mut()
            .find(|existing| assignment(existing).is_some_and(|(found, _)| found == name))
        {
            Some(existing) => *existing = line,
            None => self.lines.push(line),
        }
        Ok(())
    }

    pub fn remove(&mut self, name: &str) {
        self.lines
            .retain(|line| assignment(line).is_none_or(|(found, _)| found != name));
    }

    pub fn render(&self) -> String {
        let mut text = self.lines.join("\n");
        text.push('\n');
        text
    }
}

/// A secret of 64 hexadecimal characters from the system's random source.
pub fn secret() -> Result<String, CliError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| CliError::Install(format!("the system has no random source: {error}")))?;
    Ok(hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rewrite_keeps_comments_and_settings_it_does_not_know() {
        let mut file = EnvFile::parse("# mine\nA=1\nCUSTOM=yes\nB=2\n");
        file.set("A", "3").unwrap();
        file.set("C", "4").unwrap();
        file.remove("B");
        assert_eq!(file.render(), "# mine\nA=3\nCUSTOM=yes\nC=4\n");
        assert_eq!(file.get("CUSTOM").as_deref(), Some("yes"));
        assert_eq!(file.get("B"), None);
    }

    #[test]
    fn a_commented_assignment_is_not_a_setting() {
        let file = EnvFile::parse("#A=1\n");
        assert_eq!(file.get("A"), None);
    }

    #[test]
    fn a_value_the_readers_would_disagree_on_is_refused() {
        let mut file = EnvFile::default();
        for value in ["a b", "a$b", "'a'", "a#b", "", "a\nb"] {
            assert!(file.set("A", value).is_err(), "{value:?}");
        }
        file.set("A", "abc/DEF+123==").unwrap();
    }

    fn read(line: &str) -> Option<String> {
        EnvFile::parse(line).get("A")
    }

    #[test]
    fn a_value_is_read_the_way_compose_reads_it() {
        assert_eq!(read("A='https://x.test'"), Some("https://x.test".into()));
        assert_eq!(read("A=\"https://x.test\""), Some("https://x.test".into()));
        assert_eq!(read("A=https://x.test"), Some("https://x.test".into()));
        assert_eq!(read("A=  'spaced'  "), Some("spaced".into()));
        assert_eq!(read("A='  padded  '"), Some("  padded  ".into()));
        assert_eq!(read("A=it's"), Some("it's".into()));
        assert_eq!(read("A="), Some(String::new()));
    }

    #[test]
    fn an_empty_pair_of_quotes_is_an_empty_value() {
        assert_eq!(read("A=''"), Some(String::new()));
        assert_eq!(read("A=\"\""), Some(String::new()));
    }

    #[test]
    fn a_hash_inside_quotes_is_part_of_the_value() {
        assert_eq!(read("A='a#b'"), Some("a#b".into()));
        assert_eq!(read("A=\"a #b\""), Some("a #b".into()));
    }

    #[test]
    fn a_comment_ends_an_unquoted_value_only_after_a_space() {
        assert_eq!(
            read("A=https://x.test # note"),
            Some("https://x.test".into())
        );
        assert_eq!(read("A=a#b"), Some("a#b".into()));
        assert_eq!(read("A=a\t# b"), Some("a\t# b".into()));
        assert_eq!(read("A=#b"), Some("#b".into()));
    }

    #[test]
    fn a_comment_after_the_closing_quote_is_dropped() {
        assert_eq!(read("A='x' # note"), Some("x".into()));
        assert_eq!(read("A=\"x\" # note"), Some("x".into()));
        assert_eq!(read("A='x'#note"), Some("x".into()));
    }

    #[test]
    fn single_quotes_keep_a_backslash_and_double_quotes_decode_it() {
        assert_eq!(read(r"A='a\nb'"), Some(r"a\nb".into()));
        assert_eq!(read(r"A='it\'s'"), Some("it's".into()));
        assert_eq!(read(r#"A="a\nb""#), Some("a\nb".into()));
        assert_eq!(read(r#"A="say \"hi\"""#), Some("say \"hi\"".into()));
        assert_eq!(read(r#"A="a\\b""#), Some(r"a\b".into()));
        assert_eq!(read(r#"A="a\$b""#), Some("a$b".into()));
        assert_eq!(read(r#"A="a\qb""#), Some(r"a\qb".into()));
        assert_eq!(read(r#"A=a\nb"#), Some(r"a\nb".into()));
    }

    #[test]
    fn a_quote_with_no_partner_is_left_as_written() {
        assert_eq!(read("A='unbalanced"), Some("'unbalanced".into()));
        assert_eq!(read("A=\"unbalanced"), Some("\"unbalanced".into()));
        assert_eq!(read("A=\"a\\\""), Some("\"a\\\"".into()));
    }

    #[test]
    fn a_rewrite_keeps_a_quoted_line_byte_for_byte() {
        let text =
            "# renderer\nSALT='abc'\nURL=\"https://x.test\"  # mine\nHEADER='CF-Connecting-IP'\n";
        let mut file = EnvFile::parse(text);
        file.set("NEW", "1").unwrap();
        assert_eq!(file.render(), format!("{text}NEW=1\n"));
        file.remove("NEW");
        assert_eq!(file.render(), text);
        file.set("HEADER", "X-Real-IP").unwrap();
        assert_eq!(
            file.render(),
            "# renderer\nSALT='abc'\nURL=\"https://x.test\"  # mine\nHEADER=X-Real-IP\n"
        );
    }

    #[test]
    fn a_secret_is_long_and_new_each_time() {
        let (one, two) = (secret().unwrap(), secret().unwrap());
        assert_eq!(one.len(), 64);
        assert_ne!(one, two);
    }
}
