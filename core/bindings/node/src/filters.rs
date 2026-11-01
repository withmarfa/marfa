//! The listing grammar's `filter` as values: an app builds a filter, and
//! edits a saved one, without writing the server's grammar by hand. A model
//! crosses as the JSON form `conformance/fixtures/filter-expressions.json`
//! holds.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::failure;

fn not_a_model(error: serde_json::Error) -> Error {
    Error::new(Status::InvalidArg, format!("not a filter model: {error}"))
}

/// The expression's text in the listing grammar, thrown as the server's
/// `validation_error` where the server would refuse it.
#[napi]
pub fn encode_filter(
    env: Env,
    #[napi(
        ts_arg_type = "{ join: \"all\" | \"any\"; conditions: { field: { kind: \"system\"; name: \"state\" | \"type\" | \"source\" | \"occurred_at\" | \"created_at\" | \"updated_at\" | \"tier\" | \"version\" | \"id\" | \"source_id\" } | { kind: \"property\"; name: string } | { kind: \"member\"; field: string; member: string } | { kind: \"tags\" } | { kind: \"status_group\" } | { kind: \"part\" } | { kind: \"edge\"; edge_type: string; direction: \"outbound\" | \"backref\" }; operator: \"eq\" | \"neq\" | \"gt\" | \"gte\" | \"lt\" | \"lte\" | \"contains\" | \"starts_with\" | \"exists\" | \"not_exists\"; value?: string | number | boolean }[] }"
    )]
    expression: serde_json::Value,
) -> Result<String> {
    serde_json::from_value::<marfa_core::FilterExpression>(expression)
        .map_err(not_a_model)?
        .encode()
        .map_err(|error| failure(env, error))
}

/// The expression a text in the listing grammar holds, thrown as the
/// server's `validation_error`, with its message, where the server refuses
/// it.
#[napi(
    ts_return_type = "{ join: \"all\" | \"any\"; conditions: { field: { kind: \"system\"; name: \"state\" | \"type\" | \"source\" | \"occurred_at\" | \"created_at\" | \"updated_at\" | \"tier\" | \"version\" | \"id\" | \"source_id\" } | { kind: \"property\"; name: string } | { kind: \"member\"; field: string; member: string } | { kind: \"tags\" } | { kind: \"status_group\" } | { kind: \"part\" } | { kind: \"edge\"; edge_type: string; direction: \"outbound\" | \"backref\" }; operator: \"eq\" | \"neq\" | \"gt\" | \"gte\" | \"lt\" | \"lte\" | \"contains\" | \"starts_with\" | \"exists\" | \"not_exists\"; value?: string | number | boolean }[] }"
)]
pub fn decode_filter(env: Env, text: String) -> Result<serde_json::Value> {
    let expression =
        marfa_core::FilterExpression::decode(&text).map_err(|error| failure(env, error))?;
    serde_json::to_value(expression).map_err(|error| Error::from_reason(error.to_string()))
}

/// The operators the grammar takes on a field.
#[napi(
    ts_return_type = "(\"eq\" | \"neq\" | \"gt\" | \"gte\" | \"lt\" | \"lte\" | \"contains\" | \"starts_with\" | \"exists\" | \"not_exists\")[]"
)]
pub fn filter_operators(
    #[napi(
        ts_arg_type = "{ kind: \"system\"; name: \"state\" | \"type\" | \"source\" | \"occurred_at\" | \"created_at\" | \"updated_at\" | \"tier\" | \"version\" | \"id\" | \"source_id\" } | { kind: \"property\"; name: string } | { kind: \"member\"; field: string; member: string } | { kind: \"tags\" } | { kind: \"status_group\" } | { kind: \"part\" } | { kind: \"edge\"; edge_type: string; direction: \"outbound\" | \"backref\" }"
    )]
    field: serde_json::Value,
) -> Result<serde_json::Value> {
    let operators = serde_json::from_value::<marfa_core::FilterField>(field)
        .map_err(not_a_model)?
        .operators();
    serde_json::to_value(operators).map_err(|error| Error::from_reason(error.to_string()))
}
