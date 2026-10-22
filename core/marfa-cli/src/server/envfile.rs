//! A settings file read and rewritten line by line, so a setting the person
//! added by hand and every comment survive a rewrite.

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

impl EnvFile {
    pub fn parse(text: &str) -> Self {
        Self {
            lines: text.lines().map(str::to_string).collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.lines
            .iter()
            .filter_map(|line| assignment(line))
            .find(|(found, _)| *found == name)
            .map(|(_, value)| value.trim())
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
        assert_eq!(file.get("CUSTOM"), Some("yes"));
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

    #[test]
    fn a_secret_is_long_and_new_each_time() {
        let (one, two) = (secret().unwrap(), secret().unwrap());
        assert_eq!(one.len(), 64);
        assert_ne!(one, two);
    }
}
