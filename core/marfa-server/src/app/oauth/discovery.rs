use serde_json::{Value, json};

use super::client::GrantType;
use super::issuer;
use super::resource::MCP_PATHS;
use super::scope::{Registries, ScopeSet, data_alone};
use crate::app::App;
use crate::app::access::AdminTask;

const SCHEMA_SCOPES: [&str; 3] = ["metadata.types:write", "schema.write", "system.view:write"];

fn admin_scopes() -> Vec<&'static str> {
    AdminTask::permissions()
        .into_iter()
        .map(|permission| permission.word())
        .collect()
}

fn published(app: &App) -> ScopeSet {
    Registries::of(&app.catalog_handle().load()).published()
}

/// RFC 8414.
pub fn authorization_server(app: &App) -> Value {
    let issuer = issuer(app);
    json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth/authorize"),
        "token_endpoint": format!("{issuer}/oauth/token"),
        "registration_endpoint": format!("{issuer}/oauth/register"),
        "revocation_endpoint": format!("{issuer}/oauth/revoke"),
        "device_authorization_endpoint": format!("{issuer}/oauth/device-authorization"),
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
        "prompt_values_supported": ["none", "login", "consent"],
        "authorization_response_iss_parameter_supported": true,
    })
}

/// RFC 9728.
pub fn protected_resource(app: &App, path: &str) -> Option<Value> {
    if !path.is_empty() && !MCP_PATHS.contains(&path) {
        return None;
    }
    let endpoint_scopes: Vec<&str> = match path {
        "/mcp/schema" => SCHEMA_SCOPES.to_vec(),
        "/mcp/admin" => admin_scopes(),
        _ => Vec::new(),
    };
    let default = data_alone(true);
    let mut scopes: Vec<&str> = default.literals().iter().map(String::as_str).collect();
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
