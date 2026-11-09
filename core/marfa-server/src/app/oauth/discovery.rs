use serde_json::{Value, json};

use super::client::GrantType;
use super::issuer;
use super::resource::MCP_PATHS;
use super::scope::{Registries, ScopeSet};
use crate::app::App;

const SCHEMA_SCOPES: [&str; 3] = ["metadata.types:write", "schema.write", "system.view:write"];
const ADMIN_SCOPES: [&str; 5] = [
    "instance.read",
    "connectors.manage",
    "audit.read",
    "keys.mint",
    "webhooks.manage",
];

fn published(app: &App) -> ScopeSet {
    Registries::of(&app.catalog_handle().load()).published()
}

/// RFC 8414.
pub fn authorization_server(app: &App) -> Value {
    let issuer = issuer(app);
    json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth2/authorize"),
        "token_endpoint": format!("{issuer}/oauth2/token"),
        "registration_endpoint": format!("{issuer}/oauth2/register"),
        "revocation_endpoint": format!("{issuer}/oauth2/revoke"),
        "device_authorization_endpoint": format!("{issuer}/device/code"),
        "response_types_supported": ["code"],
        "grant_types_supported": [
            GrantType::AuthorizationCode.word(),
            GrantType::RefreshToken.word(),
            GrantType::DeviceCode.word(),
        ],
        "code_challenge_methods_supported": [super::pkce::METHOD],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": published(app).literals(),
        "client_id_metadata_document_supported": true,
        "authorization_response_iss_parameter_supported": true,
    })
}

/// RFC 9728.
pub fn protected_resource(app: &App, path: &str) -> Option<Value> {
    if !path.is_empty() && !MCP_PATHS.contains(&path) {
        return None;
    }
    let endpoint_scopes: &[&str] = match path {
        "/mcp/schema" => &SCHEMA_SCOPES,
        "/mcp/admin" => &ADMIN_SCOPES,
        _ => &[],
    };
    let mut scopes: Vec<&str> = Vec::new();
    let every = published(app);
    scopes.extend(
        every
            .literals()
            .iter()
            .map(String::as_str)
            .filter(|literal| !SCHEMA_SCOPES.contains(literal) && !ADMIN_SCOPES.contains(literal)),
    );
    scopes.extend(endpoint_scopes);
    scopes.sort_unstable();
    scopes.dedup();
    let origin = app.addresses().sign_in().origin().to_string();
    Some(json!({
        "resource": format!("{origin}{path}"),
        "authorization_servers": [issuer(app)],
        "scopes_supported": scopes,
        "bearer_methods_supported": ["header"],
    }))
}
