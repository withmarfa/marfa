//! A refusal: what the server answers when it will not do what was asked.
//! Its status comes from its code, and nothing ever reads its message.

use std::borrow::Cow;

use rusqlite::ErrorCode;
use serde_json::{Map, Value};

pub type Result<T> = std::result::Result<T, Refusal>;

macro_rules! codes {
    ($($variant:ident = $wire:literal, $status:literal;)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Code {
            $($variant,)*
            /// A bulk write's refusal of one entry, answered with the status
            /// that entry's own refusal has.
            BulkAtomicRollback { status: u16 },
        }

        impl Code {
            pub const fn wire(self) -> &'static str {
                match self {
                    $(Code::$variant => $wire,)*
                    Code::BulkAtomicRollback { .. } => "bulk_atomic_rollback",
                }
            }

            pub const fn status(self) -> u16 {
                match self {
                    $(Code::$variant => $status,)*
                    Code::BulkAtomicRollback { status } => status,
                }
            }
        }

        #[cfg(test)]
        const FIXED_STATUS: &[(&str, u16)] = &[$(($wire, $status),)*];
    };
}

codes! {
    BulkCapExceeded = "bulk_cap_exceeded", 400;
    BulkConfirmationRequired = "bulk_confirmation_required", 400;
    EdgeConstraintViolation = "edge_constraint_violation", 400;
    EdgeCycle = "edge_cycle", 400;
    InheritanceViolation = "inheritance_violation", 400;
    InvalidClient = "invalid_client", 400;
    InvalidId = "invalid_id", 400;
    InvalidProperties = "invalid_properties", 400;
    InvalidSchema = "invalid_schema", 400;
    InvalidTransition = "invalid_transition", 400;
    MissingRequiredField = "missing_required_field", 400;
    PropertyShadowsField = "property_shadows_field", 400;
    UnknownType = "unknown_type", 400;
    ValidationError = "validation_error", 400;
    SetupProofInvalid = "setup_proof_invalid", 401;
    Unauthorized = "unauthorized", 401;
    CoreTypeImmutable = "core_type_immutable", 403;
    EdgePermissionDenied = "edge_permission_denied", 403;
    Forbidden = "forbidden", 403;
    TypeNotPermitted = "type_not_permitted", 403;
    ApiKeyNotFound = "api_key_not_found", 404;
    BlobCopyNotFound = "blob_copy_not_found", 404;
    BlobNotFound = "blob_not_found", 404;
    BulkJobNotFound = "bulk_job_not_found", 404;
    ConnectorNotFound = "connector_not_found", 404;
    DeliveryNotFound = "delivery_not_found", 404;
    EdgeNotFound = "edge_not_found", 404;
    EdgeTypeNotFound = "edge_type_not_found", 404;
    EndpointNotFound = "endpoint_not_found", 404;
    HousekeepingJobNotFound = "housekeeping_job_not_found", 404;
    ItemNotFound = "item_not_found", 404;
    NotFound = "not_found", 404;
    OauthGrantNotFound = "oauth_grant_not_found", 404;
    OwnerNotFound = "owner_not_found", 404;
    PasskeyNotFound = "passkey_not_found", 404;
    SignInNotFound = "sign_in_not_found", 404;
    SourceNotFound = "source_not_found", 404;
    TypeNotFound = "type_not_found", 404;
    WebhookNotFound = "webhook_not_found", 404;
    RequestTimeout = "request_timeout", 408;
    AncestorUnavailable = "ancestor_unavailable", 409;
    Conflict = "conflict", 409;
    ConnectorHeld = "connector_held", 409;
    CopiesBelowMinimum = "copies_below_minimum", 409;
    EdgeTypeInUse = "edge_type_in_use", 409;
    ExportRowsUnrestorable = "export_rows_unrestorable", 409;
    HousekeepingJobRunning = "housekeeping_job_running", 409;
    IdReused = "id_reused", 409;
    IdempotencyKeyInFlight = "idempotency_key_in_flight", 409;
    InstanceChanged = "instance_changed", 409;
    ItemExists = "item_exists", 409;
    LinkTaken = "link_taken", 409;
    OwnerExists = "owner_exists", 409;
    ReachChanged = "reach_changed", 409;
    SourceIdConflict = "source_id_conflict", 409;
    TrashPlanChanged = "trash_plan_changed", 409;
    TypeAlreadyExists = "type_already_exists", 409;
    TypeChainUnresolvable = "type_chain_unresolvable", 409;
    TypeHasSubtypes = "type_has_subtypes", 409;
    TypeInUse = "type_in_use", 409;
    TypeMismatch = "type_mismatch", 409;
    TypeMoveBlocked = "type_move_blocked", 409;
    VersionConflict = "version_conflict", 409;
    RequestTooLarge = "request_too_large", 413;
    RangeNotSatisfiable = "range_not_satisfiable", 416;
    CompatibleWithViolation = "compatible_with_violation", 422;
    IdempotencyKeyReused = "idempotency_key_reused", 422;
    IdempotencyResultNotRetained = "idempotency_result_not_retained", 422;
    RateLimited = "rate_limited", 429;
    InternalError = "internal_error", 500;
    BlobStoreUnavailable = "blob_store_unavailable", 503;
    ExportUnrestorable = "export_unrestorable", 503;
    InboundUnavailable = "inbound_unavailable", 503;
    StreamCapacityExhausted = "stream_capacity_exhausted", 503;
    WriteContention = "write_contention", 503;
    InsufficientStorage = "insufficient_storage", 507;
}

const INTERNAL_MESSAGE: &str = "Internal server error";

#[derive(Clone, Debug, thiserror::Error)]
#[error("{}: {message}", code.wire())]
pub struct Refusal {
    pub code: Code,
    pub message: Cow<'static, str>,
    pub details: Option<Box<Map<String, Value>>>,
    /// What an answer carries beside `error`: the item states a conflict
    /// names, for the writer to merge from.
    pub members: Option<Box<Map<String, Value>>>,
    /// The SQLite result code behind a failed statement, for those allowed to
    /// read it. It never reaches the envelope.
    pub cause: Option<&'static str>,
}

impl Refusal {
    pub fn new(code: Code, message: impl Into<Cow<'static, str>>) -> Refusal {
        Refusal {
            code,
            message: message.into(),
            details: None,
            members: None,
            cause: None,
        }
    }

    pub fn validation(message: impl Into<Cow<'static, str>>) -> Refusal {
        Refusal::new(Code::ValidationError, message)
    }

    /// A fault nothing foresaw. `context` goes to the log and nowhere else.
    pub fn internal(context: &str) -> Refusal {
        tracing::error!(context, "Internal error");
        Refusal::new(Code::InternalError, INTERNAL_MESSAGE)
    }

    pub fn with_member(mut self, name: &str, value: impl Into<Value>) -> Refusal {
        self.members
            .get_or_insert_default()
            .insert(name.to_string(), value.into());
        self
    }

    pub fn with_detail(mut self, name: &str, value: impl Into<Value>) -> Refusal {
        self.details
            .get_or_insert_default()
            .insert(name.to_string(), value.into());
        self
    }
}

/// The name of SQLite's primary result code, which is all of a failed
/// statement that is safe to report.
pub fn sqlite_code_name(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::InternalMalfunction => "SQLITE_INTERNAL",
        ErrorCode::PermissionDenied => "SQLITE_PERM",
        ErrorCode::OperationAborted => "SQLITE_ABORT",
        ErrorCode::DatabaseBusy => "SQLITE_BUSY",
        ErrorCode::DatabaseLocked => "SQLITE_LOCKED",
        ErrorCode::OutOfMemory => "SQLITE_NOMEM",
        ErrorCode::ReadOnly => "SQLITE_READONLY",
        ErrorCode::OperationInterrupted => "SQLITE_INTERRUPT",
        ErrorCode::SystemIoFailure => "SQLITE_IOERR",
        ErrorCode::DatabaseCorrupt => "SQLITE_CORRUPT",
        ErrorCode::NotFound => "SQLITE_NOTFOUND",
        ErrorCode::DiskFull => "SQLITE_FULL",
        ErrorCode::CannotOpen => "SQLITE_CANTOPEN",
        ErrorCode::FileLockingProtocolFailed => "SQLITE_PROTOCOL",
        ErrorCode::SchemaChanged => "SQLITE_SCHEMA",
        ErrorCode::TooBig => "SQLITE_TOOBIG",
        ErrorCode::ConstraintViolation => "SQLITE_CONSTRAINT",
        ErrorCode::TypeMismatch => "SQLITE_MISMATCH",
        ErrorCode::ApiMisuse => "SQLITE_MISUSE",
        ErrorCode::NoLargeFileSupport => "SQLITE_NOLFS",
        ErrorCode::AuthorizationForStatementDenied => "SQLITE_AUTH",
        ErrorCode::ParameterOutOfRange => "SQLITE_RANGE",
        ErrorCode::NotADatabase => "SQLITE_NOTADB",
        _ => "SQLITE_ERROR",
    }
}

impl From<rusqlite::Error> for Refusal {
    fn from(error: rusqlite::Error) -> Refusal {
        let code = error.sqlite_error_code();
        match code {
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => {
                Refusal::new(Code::WriteContention, "The database is busy; try again.")
            }
            Some(ErrorCode::DiskFull) => Refusal::new(
                Code::InsufficientStorage,
                "The volume the instance writes to has no room for the request.",
            ),
            _ => {
                let name = code.map_or("SQLITE_ERROR", sqlite_code_name);
                tracing::error!(sqlite_code = name, "Database operation failed");
                let mut refusal = Refusal::new(Code::InternalError, INTERNAL_MESSAGE);
                refusal.cause = Some(name);
                refusal
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_every_code_the_contract_tables_with_its_status() {
        let spec = include_str!("../../../../conformance/spec/errors.md");
        let table = spec
            .split("<!-- errors-table:start -->")
            .nth(1)
            .and_then(|rest| rest.split("<!-- errors-table:end -->").next())
            .expect("errors.md holds the table");
        let mut rows = 0;
        for row in table.lines().filter(|line| line.starts_with("| `")) {
            let mut cells = row.split('|').map(str::trim).skip(1);
            let code = cells.next().unwrap_or_default().trim_matches('`');
            let status = cells.next().unwrap_or_default();
            rows += 1;
            if code == "bulk_atomic_rollback" {
                continue;
            }
            let held = FIXED_STATUS.iter().find(|(wire, _)| *wire == code);
            assert_eq!(
                held.map(|(_, status)| status.to_string()).as_deref(),
                Some(status),
                "{code}"
            );
        }
        assert_eq!(rows, FIXED_STATUS.len() + 1);
    }

    #[test]
    fn a_rollback_answers_the_status_of_the_refusal_inside_it() {
        let code = Code::BulkAtomicRollback { status: 409 };
        assert_eq!((code.wire(), code.status()), ("bulk_atomic_rollback", 409));
    }
}
