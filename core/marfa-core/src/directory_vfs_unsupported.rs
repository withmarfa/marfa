use crate::{CoreError, Result};

pub(crate) struct DirectoryVfs;
impl DirectoryVfs {
    pub(crate) fn supported(_: &std::fs::File) -> Result<()> {
        Err(CoreError::Invalid(
            "folder storage is unavailable on this platform".into(),
        ))
    }
}
