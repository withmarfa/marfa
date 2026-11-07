//! A refusal as data: a machine code, the words a person reads and, where a
//! write's properties or tags are refused, one entry per field.

use std::fmt;

/// What a rule answers when it refuses.
pub type Result<T> = std::result::Result<T, RuleError>;

/// How a rule refused. The first four are the contract's wire codes;
/// `Invalid` and `Decoding` have none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// `validation_error`.
    ValidationError,
    /// `invalid_properties`, with an entry per field in [`RuleError::fields`].
    InvalidProperties,
    /// `invalid_id`.
    InvalidId,
    /// `unknown_type`.
    UnknownType,
    /// The input is not one a caller may give, whatever a server says of it.
    Invalid,
    /// A definition held or shipped does not read as its kind.
    Decoding,
}

impl Code {
    /// The code as the contract spells it, or a lowercase word for the two
    /// refusals the contract has no code for.
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

/// One field a write is refused for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    /// Where the fault is: a property name, a dotted path into its value
    /// (`names.1`, `emails.1.value`), `tags[2]`, or the name of the request
    /// part that is refused. A server names it `field` under
    /// `invalid_properties` and `path` under `validation_error`.
    pub path: String,
    /// What is wrong, one of [`field_code`].
    pub code: &'static str,
    /// What is wrong, in the words a person reads, without the path.
    pub message: String,
}

/// The codes of a [`FieldError`].
pub mod field_code {
    /// A required property is missing, or a required member of an entry.
    pub const REQUIRED: &str = "required";
    /// The value is of another kind than the field's.
    pub const INVALID_TYPE: &str = "invalid_type";
    /// The value is of the right kind and is not one the field takes.
    pub const INVALID_VALUE: &str = "invalid_value";
    /// A text, list or tag is longer than the field allows.
    pub const TOO_LONG: &str = "too_long";
    /// A list holds more members than the field allows.
    pub const TOO_MANY: &str = "too_many";
    /// A number is outside the field's range.
    pub const OUT_OF_RANGE: &str = "out_of_range";
    /// A whole number the float it parses to would print differently.
    pub const INEXACT_INTEGER: &str = "inexact_integer";
    /// A name that must not be empty is.
    pub const EMPTY: &str = "empty";
    /// A name is set and cleared by the same edit.
    pub const SET_AND_CLEARED: &str = "set_and_cleared";
    /// An entry of a list holds a member its field does not declare.
    pub const UNKNOWN_MEMBER: &str = "unknown_member";
}

/// A rule's refusal. `message` is the whole text a person is shown, and
/// `fields` holds the same refusal apart, one entry per field.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleError {
    pub code: Code,
    pub message: String,
    /// Empty except where properties or tags are refused.
    pub fields: Vec<FieldError>,
}

impl RuleError {
    /// A refusal with no field to name.
    pub fn new(code: Code, message: impl Into<String>) -> RuleError {
        RuleError {
            code,
            message: message.into(),
            fields: Vec::new(),
        }
    }

    /// The same refusal, naming each of `fields`.
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
