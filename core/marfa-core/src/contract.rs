// Generated from openapi.json by scripts/generate-core-contract.ts — do not edit.

/// The contract version this core was built for: the document's
/// `info.version`, which every answer names in `X-Marfa-Contract`.
pub const CONTRACT_VERSION: u64 = 0;

/// The operations that take an `Idempotency-Key`, as method and path
/// template: the server answers a write sent again under its key from its
/// record of the first.
pub const KEYED_WRITES: &[(&str, &str)] = &[
    ("POST", "/items"),
    ("PATCH", "/items/{id}"),
    ("DELETE", "/items/{id}"),
    ("POST", "/items/{id}/restore"),
    ("POST", "/items/{id}/purge"),
    ("POST", "/items/{id}/transition"),
    ("POST", "/items/bulk-actions"),
    ("PUT", "/items/{id}/metadata"),
    ("POST", "/items/{id}/tags"),
    ("DELETE", "/items/{id}/tags/{tag}"),
    ("PUT", "/items/{id}/extensions/{namespace}"),
    ("DELETE", "/items/{id}/extensions/{namespace}"),
    ("POST", "/edges"),
    ("PATCH", "/edges/{id}"),
    ("DELETE", "/edges/{id}"),
    ("POST", "/folders"),
    ("PATCH", "/folders/{id}"),
    ("POST", "/folders/{id}/revoke"),
    ("POST", "/views"),
    ("PATCH", "/views/{id}"),
    ("DELETE", "/views/{id}"),
];
