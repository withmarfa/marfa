use std::fmt;

/// How long until another attempt is allowed, as the redirect that sent the
/// person to the page named it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wait {
    seconds: u32,
}

impl Wait {
    pub const LONGEST_SECONDS: u32 = 86_400;

    /// A `retry_after` query value: whole seconds from 1 to 86400. Anything
    /// else names no wait.
    pub fn from_query(value: Option<&str>) -> Option<Wait> {
        let value = value?;
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let seconds: u32 = value.parse().ok()?;
        (1..=Self::LONGEST_SECONDS)
            .contains(&seconds)
            .then_some(Wait { seconds })
    }

    pub fn minutes(self) -> u32 {
        self.seconds.div_ceil(60)
    }
}

/// "1 minute" or "15 minutes".
impl fmt::Display for Wait {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.minutes() {
            1 => formatter.write_str("1 minute"),
            minutes => write!(formatter, "{minutes} minutes"),
        }
    }
}
