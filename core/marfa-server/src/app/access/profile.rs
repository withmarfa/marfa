use super::{Axis, Caller, Level};
use crate::app::refusal::{Code, Refusal, Result};

impl Caller {
    /// A direct caller holds every profile field; a key or an app holds what its map names.
    pub fn require_profile(&self, field: &str, level: Level) -> Result<()> {
        if self.level_on(Axis::Profile, field) >= level {
            return Ok(());
        }
        Err(Refusal::new(
            Code::Forbidden,
            format!("Missing profile.{field}:{} permission", level.word()),
        )
        .with_detail("profile_field", field)
        .with_detail("required", level.word()))
    }
}
