//! File properties the server reads by name; `db::shared_names` ties the triggers' paths to them.

pub const BLOB_REF: &str = "blob_ref";
pub const MIME_TYPE: &str = "mime_type";
pub const EXTRACTED_TEXT: &str = "extracted_text";
pub const WIDTH: &str = "width";
pub const HEIGHT: &str = "height";
pub const DURATION: &str = "duration";

/// Every name above, for the test that ties the triggers to them.
#[cfg(test)]
pub const ALL: [&str; 6] = [BLOB_REF, MIME_TYPE, EXTRACTED_TEXT, WIDTH, HEIGHT, DURATION];
