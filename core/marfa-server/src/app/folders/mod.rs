//! Folder settings and per-copy sync reports.

mod inventory;
mod report;
mod settings;
mod status;

pub use inventory::{Page, list};
pub use report::Report;
pub use settings::{
    Patterns, SETTINGS, check, check_stored, compile_patterns, judge, refuse_null, undeclared,
};
pub use status::{Concern, concerns, read, remove_of as remove_reports_of, report};

pub const FOLDER_TYPE: &str = "system.folder";
