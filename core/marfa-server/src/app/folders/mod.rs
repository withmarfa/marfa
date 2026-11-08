//! Folders: a `system.folder` item holds a folder's settings, and each copy of a folder reports how
//! its sync stands.

mod inventory;
mod report;
mod settings;
mod status;

pub use inventory::{Page, list};
pub use report::Report;
pub use settings::{SETTINGS, check, refuse_null, undeclared};
pub use status::{read, report};

pub const FOLDER_TYPE: &str = "system.folder";
