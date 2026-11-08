use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wait {
    seconds: u32,
}

impl Wait {
    pub const LONGEST_SECONDS: u32 = 86_400;

    /// Whole seconds from 1 to 86400; anything else names no wait.
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

impl fmt::Display for Wait {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.minutes() {
            1 => formatter.write_str("1 minute"),
            minutes => write!(formatter, "{minutes} minutes"),
        }
    }
}
