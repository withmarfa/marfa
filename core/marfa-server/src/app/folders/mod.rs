//! Folder settings and per-copy sync reports.

mod inventory;
mod report;
mod settings;
mod status;

pub use inventory::{Page, list};
pub use report::Report;
pub use settings::{Patterns, SETTINGS, check, compile_patterns, judge, refuse_null, undeclared};
pub use status::{read, report};

pub const FOLDER_TYPE: &str = "system.folder";
