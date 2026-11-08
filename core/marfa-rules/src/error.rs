//! A refusal as data: a code, a message and, for properties or tags, one entry per field.

use std::fmt;

pub type Result<T> = std::result::Result<T, RuleError>;

/// The first four are wire codes; `Invalid` and `Decoding` have none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    ValidationError,
    InvalidProperties,
    InvalidId,
    UnknownType,
    /// The input is not one a caller may give.
    Invalid,
    Decoding,
}

impl Code {
    /// The wire code, or a lowercase word for the two refusals without one.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::ValidationError => "validation_error",
            Code::InvalidProperties => "invalid_properties",
            Code::InvalidId => "invalid_id",
            Code::UnknownType => "unknown_type",
            Code::Invalid => "invalid",
            Code::Decoding => "decoding",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    /// A property name, a dotted path into its value (`names.1`), `tags[2]`, or the refused request part.
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

pub mod field_code {
    pub const REQUIRED: &str = "required";
    pub const INVALID_TYPE: &str = "invalid_type";
    pub const INVALID_VALUE: &str = "invalid_value";
    pub const TOO_LONG: &str = "too_long";
    pub const TOO_MANY: &str = "too_many";
    pub const OUT_OF_RANGE: &str = "out_of_range";
    /// A whole number the float it parses to would print differently.
    pub const INEXACT_INTEGER: &str = "inexact_integer";
    pub const EMPTY: &str = "empty";
    /// A name is set and cleared by the same edit.
    pub const SET_AND_CLEARED: &str = "set_and_cleared";
    pub const UNKNOWN_MEMBER: &str = "unknown_member";
}

/// `message` is the whole text a person is shown; `fields` holds the same refusal apart.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleError {
    pub code: Code,
    pub message: String,
    pub fields: Vec<FieldError>,
}

impl RuleError {
    pub fn new(code: Code, message: impl Into<String>) -> RuleError {
        RuleError {
            code,
            message: message.into(),
            fields: Vec::new(),
        }
    }

    pub fn with_fields(mut self, fields: Vec<FieldError>) -> RuleError {
        self.fields = fields;
        self
    }

    pub fn validation(message: impl Into<String>) -> RuleError {
        RuleError::new(Code::ValidationError, message)
    }

    pub fn invalid(message: impl Into<String>) -> RuleError {
        RuleError::new(Code::Invalid, message)
    }

    pub fn decoding(message: impl Into<String>) -> RuleError {
        RuleError::new(Code::Decoding, message)
    }
}

impl FieldError {
    pub fn new(path: impl Into<String>, code: &'static str, message: impl Into<String>) -> Self {
        FieldError {
            path: path.into(),
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for RuleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for RuleError {}
