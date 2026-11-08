//! Classifies stateless JSON-RPC requests across supported MCP revisions.

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};

pub const MODERN: &str = "2026-07-28";
pub const LEGACY: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_KEY: &str = "io.modelcontextprotocol/clientInfo";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const HEADER_MISMATCH: i64 = -32020;
pub const UNSUPPORTED_VERSION: i64 = -32022;
const NOT_JSON: i64 = -32000;

const BASE64_OPEN: &str = "=?base64?";
const BASE64_CLOSE: &str = "?=";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Era {
    Modern,
    Legacy,
}

pub struct Call {
    pub id: Value,
    pub method: String,
    pub params: Map<String, Value>,
    pub era: Era,
}

pub enum Entry {
    Call(Call),
    /// A notification, which is taken and answered with no body.
    Notification,
    Rejected(Reply),
}

/// An HTTP answer holding one JSON-RPC message.
pub struct Reply {
    pub status: StatusCode,
    pub body: Value,
}

impl Reply {
    pub fn error(
        status: StatusCode,
        id: Value,
        code: i64,
        message: impl Into<String>,
        data: Option<Value>,
    ) -> Reply {
        let mut error = Map::new();
        error.insert("code".into(), code.into());
        error.insert("message".into(), message.into().into());
        if let Some(data) = data {
            error.insert("data".into(), data);
        }
        Reply {
            status,
            body: json!({ "jsonrpc": "2.0", "id": id, "error": error }),
        }
    }

    /// An error the method's own handling gives, which the transport carries as a success.
    pub fn in_band(id: Value, code: i64, message: impl Into<String>) -> Reply {
        Reply::error(StatusCode::OK, id, code, message, None)
    }

    pub fn result(id: Value, result: Value) -> Reply {
        Reply {
            status: StatusCode::OK,
            body: json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        }
    }

    pub fn into_response(self) -> Response {
        let bytes = marfa_rules::js::to_vec(&self.body).unwrap_or_default();
        let mut response = Response::new(Body::from(bytes));
        *response.status_mut() = self.status;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        response
    }
}

pub fn not_json() -> Reply {
    Reply::error(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        Value::Null,
        NOT_JSON,
        "Unsupported Media Type: send the message as application/json.",
        None,
    )
}

fn bad_request(code: i64, message: &str) -> Entry {
    Entry::Rejected(Reply::error(
        StatusCode::BAD_REQUEST,
        Value::Null,
        code,
        message,
        None,
    ))
}

fn mismatch(id: Value, header: &str, body: &str) -> Entry {
    Entry::Rejected(Reply::error(
        StatusCode::BAD_REQUEST,
        id,
        HEADER_MISMATCH,
        format!("Bad Request: the request headers and body disagree: {body}"),
        Some(json!({ "mismatch": { "header": header, "body": body } })),
    ))
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches([' ', '\t']).to_string())
}

fn decoded(value: &str) -> Option<String> {
    let Some(inner) = value
        .strip_prefix(BASE64_OPEN)
        .and_then(|rest| rest.strip_suffix(BASE64_CLOSE))
    else {
        return Some(value.to_string());
    };
    let bytes = STANDARD.decode(inner).ok()?;
    String::from_utf8(bytes).ok()
}

fn is_modern(version: &str) -> bool {
    version >= MODERN
}

fn meta_of(params: &Value) -> Option<&Map<String, Value>> {
    params.get("_meta").and_then(Value::as_object)
}

fn claims(params: &Value) -> bool {
    meta_of(params).is_some_and(|meta| meta.contains_key(VERSION_KEY))
}

fn claimed_version(params: &Value) -> Option<&str> {
    meta_of(params)?.get(VERSION_KEY)?.as_str()
}

/// The first thing wrong with a request's envelope, as `key: problem`.
fn envelope_issue(meta: &Map<String, Value>) -> Option<(String, String)> {
    for key in [VERSION_KEY, CAPABILITIES_KEY] {
        if !meta.contains_key(key) {
            return Some((key.to_string(), "missing".to_string()));
        }
    }
    if !meta[VERSION_KEY].is_string() {
        return Some((VERSION_KEY.to_string(), "expected a string".to_string()));
    }
    if !meta[CAPABILITIES_KEY].is_object() {
        return Some((
            CAPABILITIES_KEY.to_string(),
            "expected an object".to_string(),
        ));
    }
    if let Some(client) = meta.get(CLIENT_KEY) {
        let named = client
            .as_object()
            .is_some_and(|client| client.get("name").is_some_and(Value::is_string));
        if !named {
            return Some((
                CLIENT_KEY.to_string(),
                "expected an object naming the client".to_string(),
            ));
        }
    }
    None
}

fn valid_modern_claim(params: &Value) -> bool {
    claimed_version(params).is_some_and(is_modern)
        && meta_of(params).is_some_and(|meta| envelope_issue(meta).is_none())
}

fn id_of(message: &Map<String, Value>) -> Option<Value> {
    match message.get("id") {
        Some(id @ Value::String(_)) => Some(id.clone()),
        Some(Value::Number(number)) if number.is_i64() || number.is_u64() => {
            message.get("id").cloned()
        }
        _ => None,
    }
}

pub fn classify(headers: &HeaderMap, body: &[u8]) -> Entry {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return bad_request(PARSE_ERROR, "Parse error");
    };
    let Value::Object(message) = value else {
        return bad_request(
            INVALID_REQUEST,
            if value.is_array() {
                "Bad Request: JSON-RPC batches are not supported by this endpoint"
            } else {
                "Bad Request: the request body is not a valid JSON-RPC message"
            },
        );
    };
    let method = message.get("method").and_then(Value::as_str);
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") || method.is_none() {
        let answered = message.contains_key("result") || message.contains_key("error");
        return bad_request(
            INVALID_REQUEST,
            if answered {
                "Bad Request: JSON-RPC responses cannot be posted to this endpoint"
            } else {
                "Bad Request: the request body is not a valid JSON-RPC message"
            },
        );
    }
    let Some(method) = method.map(str::to_string) else {
        return bad_request(INVALID_REQUEST, "Bad Request: the message names no method");
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let version_header = header_text(headers, "mcp-protocol-version");
    let header_names_modern = version_header.as_deref().is_some_and(is_modern);
    let id = id_of(&message);
    if message.contains_key("id") && id.is_none() {
        return bad_request(INVALID_REQUEST, "Bad Request: the request id is not valid");
    }
    let Some(id) = id else {
        return notification(headers, &method, &params, version_header.as_deref());
    };

    let era = if method == "initialize" && !valid_modern_claim(&params) {
        if header_names_modern {
            return mismatch(
                id,
                version_header.as_deref().unwrap_or_default(),
                "an initialize request was sent with a modern MCP-Protocol-Version header",
            );
        }
        Era::Legacy
    } else if claims(&params) {
        if let Some((key, problem)) = meta_of(&params).and_then(envelope_issue) {
            return Entry::Rejected(Reply::error(
                StatusCode::BAD_REQUEST,
                id,
                INVALID_PARAMS,
                format!("Invalid _meta envelope for protocol revision {MODERN}: {key}: {problem}"),
                Some(json!({ "envelope": { "key": key, "problem": problem } })),
            ));
        }
        let version = claimed_version(&params).unwrap_or_default();
        if let Some(sent) = version_header.as_deref()
            && sent != version
        {
            return mismatch(
                id,
                sent,
                &format!(
                    "the body envelope names protocol version {version} but the MCP-Protocol-Version header names {sent}"
                ),
            );
        }
        if let Some(sent) = header_text(headers, "mcp-method")
            && sent != method
        {
            return mismatch(
                id,
                &sent,
                &format!("the body names method {method} but the Mcp-Method header names {sent}"),
            );
        }
        if !is_modern(version) {
            Era::Legacy
        } else if version != MODERN {
            return Entry::Rejected(unsupported(id, Some(version)));
        } else {
            Era::Modern
        }
    } else if header_names_modern {
        let missing = meta_of(&params)
            .and_then(envelope_issue)
            .map_or_else(|| VERSION_KEY.to_string(), |(key, _)| key);
        return Entry::Rejected(Reply::error(
            StatusCode::BAD_REQUEST,
            id,
            INVALID_PARAMS,
            format!(
                "Invalid params: the MCP-Protocol-Version header names protocol revision {}, but the request is missing the required per-request envelope key: {missing}",
                version_header.as_deref().unwrap_or_default()
            ),
            Some(json!({ "envelope": { "missing": [missing] } })),
        ));
    } else {
        Era::Legacy
    };

    if era == Era::Modern
        && let Some(refused) = standard_headers(headers, &id, &method, &params, &version_header)
    {
        return refused;
    }
    Entry::Call(Call {
        id,
        method,
        params: params.as_object().cloned().unwrap_or_default(),
        era,
    })
}

fn unsupported(id: Value, requested: Option<&str>) -> Reply {
    let mut data = Map::new();
    data.insert("supported".into(), json!([MODERN]));
    if let Some(requested) = requested {
        data.insert("requested".into(), requested.into());
    }
    Reply::error(
        StatusCode::BAD_REQUEST,
        id,
        UNSUPPORTED_VERSION,
        "Unsupported protocol version",
        Some(Value::Object(data)),
    )
}

/// Gateway routing headers must agree with the request body.
fn standard_headers(
    headers: &HeaderMap,
    id: &Value,
    method: &str,
    params: &Value,
    version_header: &Option<String>,
) -> Option<Entry> {
    if version_header.is_none() {
        return Some(mismatch(
            id.clone(),
            "(missing)",
            "the body carries a modern per-request envelope but the required MCP-Protocol-Version header is absent",
        ));
    }
    if header_text(headers, "mcp-method").is_none() {
        return Some(mismatch(
            id.clone(),
            "(missing)",
            &format!("the body names method {method} but the required Mcp-Method header is absent"),
        ));
    }
    if method != "tools/call" {
        return None;
    }
    let name = params.get("name").and_then(Value::as_str)?;
    let Some(sent) = header_text(headers, "mcp-name") else {
        return Some(mismatch(
            id.clone(),
            "(missing)",
            &format!(
                "the body carries params.name=\"{name}\" but the required Mcp-Name header is absent"
            ),
        ));
    };
    match decoded(&sent) {
        None => Some(mismatch(
            id.clone(),
            &sent,
            "the Mcp-Name header carries an invalid Base64 sentinel value",
        )),
        Some(text) if text != name => Some(mismatch(
            id.clone(),
            &sent,
            &format!(
                "the body carries params.name=\"{name}\" but the Mcp-Name header names \"{text}\""
            ),
        )),
        Some(_) => None,
    }
}

fn notification(
    headers: &HeaderMap,
    method: &str,
    params: &Value,
    version_header: Option<&str>,
) -> Entry {
    if claims(params) && claimed_version(params).is_none() {
        return bad_request(
            INVALID_PARAMS,
            "Invalid _meta envelope: the protocol version is not a string",
        );
    }
    let modern = claimed_version(params)
        .or(version_header)
        .is_some_and(is_modern);
    if modern
        && let Some(sent) = header_text(headers, "mcp-method")
        && sent != method
    {
        return mismatch(
            Value::Null,
            &sent,
            &format!(
                "the notification body names method {method} but the Mcp-Method header names {sent}"
            ),
        );
    }
    Entry::Notification
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    fn envelope() -> Value {
        json!({
            (VERSION_KEY): MODERN,
            (CAPABILITIES_KEY): {},
            (CLIENT_KEY): { "name": "test", "version": "0" },
        })
    }

    fn body(method: &str, params: Value) -> Vec<u8> {
        serde_json::to_vec(
            &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
        )
        .unwrap()
    }

    fn rejected(entry: Entry) -> (u16, i64) {
        match entry {
            Entry::Rejected(reply) => (
                reply.status.as_u16(),
                reply.body["error"]["code"].as_i64().unwrap_or_default(),
            ),
            _ => panic!("not rejected"),
        }
    }

    #[test]
    fn a_modern_request_is_served_when_its_headers_say_what_its_body_says() {
        let sent = headers(&[
            ("mcp-protocol-version", MODERN),
            ("mcp-method", "tools/list"),
        ]);
        let entry = classify(&sent, &body("tools/list", json!({ "_meta": envelope() })));
        assert!(matches!(
            entry,
            Entry::Call(Call {
                era: Era::Modern,
                ..
            })
        ));
    }

    #[test]
    fn a_header_that_disagrees_with_the_body_is_refused_with_the_mismatch() {
        let sent = headers(&[("mcp-protocol-version", MODERN), ("mcp-method", "ping")]);
        let entry = classify(&sent, &body("tools/list", json!({ "_meta": envelope() })));
        assert_eq!(rejected(entry), (400, HEADER_MISMATCH));
        let missing = headers(&[("mcp-protocol-version", MODERN)]);
        let entry = classify(&missing, &body("ping", json!({ "_meta": envelope() })));
        assert_eq!(rejected(entry), (400, HEADER_MISMATCH));
        let unnamed = headers(&[
            ("mcp-protocol-version", MODERN),
            ("mcp-method", "tools/call"),
        ]);
        let entry = classify(
            &unnamed,
            &body("tools/call", json!({ "name": "x", "_meta": envelope() })),
        );
        assert_eq!(rejected(entry), (400, HEADER_MISMATCH));
    }

    #[test]
    fn a_request_with_no_claim_and_no_header_is_served_as_an_earlier_revision() {
        let entry = classify(&HeaderMap::new(), &body("tools/list", json!({})));
        assert!(matches!(
            entry,
            Entry::Call(Call {
                era: Era::Legacy,
                ..
            })
        ));
        let entry = classify(
            &HeaderMap::new(),
            &body("initialize", json!({ "protocolVersion": "2025-11-25" })),
        );
        assert!(matches!(
            entry,
            Entry::Call(Call {
                era: Era::Legacy,
                ..
            })
        ));
    }

    #[test]
    fn a_modern_header_without_an_envelope_is_invalid_params() {
        let sent = headers(&[("mcp-protocol-version", MODERN)]);
        let entry = classify(&sent, &body("tools/list", json!({})));
        assert_eq!(rejected(entry), (400, INVALID_PARAMS));
    }

    #[test]
    fn what_is_not_one_message_is_refused() {
        assert_eq!(
            rejected(classify(&HeaderMap::new(), b"{")),
            (400, PARSE_ERROR)
        );
        assert_eq!(
            rejected(classify(&HeaderMap::new(), b"[]")),
            (400, INVALID_REQUEST)
        );
        assert_eq!(
            rejected(classify(
                &HeaderMap::new(),
                b"{\"jsonrpc\":\"2.0\",\"id\":1}"
            )),
            (400, INVALID_REQUEST)
        );
        let notification = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert!(matches!(
            classify(&HeaderMap::new(), notification),
            Entry::Notification
        ));
    }

    #[test]
    fn a_name_header_may_carry_the_name_as_base64() {
        assert_eq!(decoded("=?base64?aGk=?=").as_deref(), Some("hi"));
        assert_eq!(decoded("plain").as_deref(), Some("plain"));
        assert!(decoded("=?base64?!!?=").is_none());
    }
}
