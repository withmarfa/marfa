//! Client metadata (RFC 7591) read into a typed registration or error. A client ID metadata
//! document is read the same way, by [`Source::Document`].

use serde_json::{Map, Value, json};
use url::Url;

use super::redirect::{self, AppKind};
use super::scope::{EMAIL_WRITE_REFUSED, OFFLINE_ACCESS, ScopeSet};

pub const MAX_REDIRECT_URIS: usize = 10;

const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthMethod {
    None,
}

impl AuthMethod {
    pub const fn word(self) -> &'static str {
        match self {
            AuthMethod::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GrantType {
    AuthorizationCode,
    RefreshToken,
    DeviceCode,
}

impl GrantType {
    pub const fn word(self) -> &'static str {
        match self {
            GrantType::AuthorizationCode => "authorization_code",
            GrantType::RefreshToken => "refresh_token",
            GrantType::DeviceCode => DEVICE_CODE_GRANT,
        }
    }

    pub fn from_word(word: &str) -> Option<GrantType> {
        [
            GrantType::AuthorizationCode,
            GrantType::RefreshToken,
            GrantType::DeviceCode,
        ]
        .into_iter()
        .find(|grant| grant.word() == word)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseType {
    Code,
}

impl ResponseType {
    pub const fn word(self) -> &'static str {
        match self {
            ResponseType::Code => "code",
        }
    }

    pub fn from_word(word: &str) -> Option<ResponseType> {
        (word == "code").then_some(ResponseType::Code)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Registration {
    pub application_type: AppKind,
    pub token_endpoint_auth_method: AuthMethod,
    pub grant_types: Vec<GrantType>,
    pub response_types: Vec<ResponseType>,
    pub redirect_uris: Vec<String>,
    pub scope: ScopeSet,
    pub client_name: Option<String>,
    pub client_uri: Option<String>,
    pub logo_uri: Option<String>,
    pub tos_uri: Option<String>,
    pub policy_uri: Option<String>,
    pub contacts: Vec<String>,
    pub software_id: Option<String>,
    pub software_version: Option<String>,
}

impl Registration {
    pub fn can_refresh(&self) -> bool {
        can_refresh(&self.grant_types)
    }

    pub fn names_grant(&self, grant: GrantType) -> bool {
        match grant {
            GrantType::RefreshToken => self.can_refresh(),
            other => self.grant_types.contains(&other),
        }
    }

    pub fn to_json(&self) -> Map<String, Value> {
        let words = |list: Vec<&'static str>| json!(list);
        let mut out = Map::new();
        out.insert(
            "application_type".to_string(),
            json!(self.application_type.word()),
        );
        out.insert(
            "token_endpoint_auth_method".to_string(),
            json!(self.token_endpoint_auth_method.word()),
        );
        out.insert(
            "grant_types".to_string(),
            words(self.grant_types.iter().map(|grant| grant.word()).collect()),
        );
        out.insert(
            "response_types".to_string(),
            words(self.response_types.iter().map(|kind| kind.word()).collect()),
        );
        out.insert("redirect_uris".to_string(), json!(self.redirect_uris));
        out.insert("scope".to_string(), json!(self.scope.to_text()));
        if !self.contacts.is_empty() {
            out.insert("contacts".to_string(), json!(self.contacts));
        }
        for (name, value) in [
            ("client_name", &self.client_name),
            ("client_uri", &self.client_uri),
            ("logo_uri", &self.logo_uri),
            ("tos_uri", &self.tos_uri),
            ("policy_uri", &self.policy_uri),
            ("software_id", &self.software_id),
            ("software_version", &self.software_version),
        ] {
            if let Some(value) = value {
                out.insert(name.to_string(), json!(value));
            }
        }
        out
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    InvalidClientMetadata,
    InvalidRedirectUri,
    InvalidScope,
    InvalidTarget,
    InvalidToken,
}

impl ErrorCode {
    pub const fn word(self) -> &'static str {
        match self {
            ErrorCode::InvalidClientMetadata => "invalid_client_metadata",
            ErrorCode::InvalidRedirectUri => "invalid_redirect_uri",
            ErrorCode::InvalidScope => "invalid_scope",
            ErrorCode::InvalidTarget => "invalid_target",
            ErrorCode::InvalidToken => "invalid_token",
        }
    }
}

/// RFC 7591 section 3.2.2.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{}: {description}", .error.word())]
pub struct RegistrationError {
    pub error: ErrorCode,
    pub description: String,
}

impl RegistrationError {
    pub(super) fn metadata(description: impl Into<String>) -> RegistrationError {
        RegistrationError {
            error: ErrorCode::InvalidClientMetadata,
            description: description.into(),
        }
    }

    fn redirect(description: impl Into<String>) -> RegistrationError {
        RegistrationError {
            error: ErrorCode::InvalidRedirectUri,
            description: description.into(),
        }
    }

    /// Registration reads a bearer as an initial access token; this server issues none.
    pub(super) fn bearer() -> RegistrationError {
        RegistrationError {
            error: ErrorCode::InvalidToken,
            description: "Registration takes no token.".to_string(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "error": self.error.word(), "error_description": self.description })
    }
}

type Reading<T> = Result<T, RegistrationError>;

/// A document is published for every server, so it may name grants this one lacks, and it does
/// not state its kind as a registration must.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Source {
    Registration,
    Document,
}

fn can_refresh(grants: &[GrantType]) -> bool {
    grants.contains(&GrantType::RefreshToken) || grants.contains(&GrantType::AuthorizationCode)
}

/// A field left out and one sent as `null` are the same.
fn field<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    object.get(name).filter(|value| !value.is_null())
}

fn text<'a>(object: &'a Map<String, Value>, name: &str) -> Reading<Option<&'a str>> {
    field(object, name)
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| RegistrationError::metadata(format!("{name} must be a string.")))
        })
        .transpose()
}

fn texts<'a>(object: &'a Map<String, Value>, name: &str) -> Reading<Option<Vec<&'a str>>> {
    let not_a_list = || RegistrationError::metadata(format!("{name} must be a list of strings."));
    field(object, name)
        .map(|value| {
            value
                .as_array()
                .ok_or_else(not_a_list)?
                .iter()
                .map(|entry| entry.as_str().ok_or_else(not_a_list))
                .collect()
        })
        .transpose()
}

fn auth_method(object: &Map<String, Value>) -> Reading<AuthMethod> {
    match text(object, "token_endpoint_auth_method")? {
        None | Some("none") => Ok(AuthMethod::None),
        Some(method) => Err(RegistrationError::metadata(format!(
            "token_endpoint_auth_method {method} is not available: this server registers public \
             clients only, with none."
        ))),
    }
}

fn grant_types(object: &Map<String, Value>, source: Source) -> Reading<Vec<GrantType>> {
    let Some(named) = texts(object, "grant_types")? else {
        return Ok(vec![GrantType::AuthorizationCode]);
    };
    let mut grants = Vec::new();
    for word in named {
        match (GrantType::from_word(word), source) {
            (Some(grant), _) if !grants.contains(&grant) => grants.push(grant),
            (Some(_), _) | (None, Source::Document) => {}
            (None, Source::Registration) => {
                return Err(RegistrationError::metadata(
                    "grant_types names a grant this server does not support.",
                ));
            }
        }
    }
    if grants.is_empty() {
        return Err(RegistrationError::metadata(
            "grant_types names no grant this server supports.",
        ));
    }
    Ok(grants)
}

/// `response_types: []` is a real answer: a device-grant client sends it.
fn response_types(
    object: &Map<String, Value>,
    source: Source,
    grants: &[GrantType],
) -> Reading<Vec<ResponseType>> {
    let by_code = grants.contains(&GrantType::AuthorizationCode);
    let Some(named) = texts(object, "response_types")? else {
        return Ok(if by_code {
            vec![ResponseType::Code]
        } else {
            Vec::new()
        });
    };
    let mut kinds = Vec::new();
    for word in &named {
        match (ResponseType::from_word(word), source) {
            (Some(kind), _) if !kinds.contains(&kind) => kinds.push(kind),
            (Some(_), _) | (None, Source::Document) => {}
            (None, Source::Registration) => {
                return Err(RegistrationError::metadata(
                    "response_types names a type this server does not support.",
                ));
            }
        }
    }
    if by_code && kinds.is_empty() {
        return Err(RegistrationError::metadata(
            "The authorization_code grant needs the code response type.",
        ));
    }
    if !named.is_empty() && kinds.is_empty() {
        return Err(RegistrationError::metadata(
            "response_types names no type this server supports.",
        ));
    }
    Ok(kinds)
}

fn application_type(
    object: &Map<String, Value>,
    source: Source,
    uris: &[&str],
) -> Reading<AppKind> {
    match (text(object, "application_type")?, source) {
        (Some("web"), _) => Ok(AppKind::Web),
        (Some("native"), _) => Ok(AppKind::Native),
        (Some(_), _) => Err(RegistrationError::metadata(
            "application_type must be web or native.",
        )),
        (None, Source::Registration) => Ok(AppKind::Web),
        (None, Source::Document) => {
            if uris.iter().any(|uri| redirect::only_native_receives(uri)) {
                Ok(AppKind::Native)
            } else {
                Ok(AppKind::Web)
            }
        }
    }
}

fn redirect_uris(object: &Map<String, Value>) -> Reading<Vec<&str>> {
    let not_a_list = || RegistrationError::redirect("redirect_uris must be a list of strings.");
    let Some(value) = field(object, "redirect_uris") else {
        return Ok(Vec::new());
    };
    let list = value.as_array().ok_or_else(not_a_list)?;
    if list.len() > MAX_REDIRECT_URIS {
        return Err(RegistrationError::redirect(format!(
            "A client may register at most {MAX_REDIRECT_URIS} redirect URIs."
        )));
    }
    list.iter()
        .map(|entry| entry.as_str().ok_or_else(not_a_list))
        .collect()
}

/// RFC 6749 section 3.3.
fn is_scope_token(token: &str) -> bool {
    token
        .bytes()
        .all(|byte| matches!(byte, 0x21 | 0x23..=0x5b | 0x5d..=0x7e))
}

/// An unoffered scope still registers: it is narrowed away at authorization, and a type
/// registered later may make it grantable.
fn scope(
    object: &Map<String, Value>,
    grants: &[GrantType],
    allowed: &ScopeSet,
) -> Reading<ScopeSet> {
    let named = text(object, "scope")?.unwrap_or_default();
    if !named.split(' ').all(is_scope_token) {
        return Err(RegistrationError::metadata(
            "scope holds a character a scope cannot.",
        ));
    }
    let named = ScopeSet::parse(named);
    if named.writes_email() {
        return Err(RegistrationError {
            error: ErrorCode::InvalidScope,
            description: EMAIL_WRITE_REFUSED.to_string(),
        });
    }
    if named.is_empty() {
        return Ok(if can_refresh(grants) {
            allowed.clone()
        } else {
            allowed.without(OFFLINE_ACCESS)
        });
    }
    if named.contains(OFFLINE_ACCESS) && !can_refresh(grants) {
        return Err(RegistrationError::metadata(
            "offline_access needs a client registered for refresh_token.",
        ));
    }
    Ok(named)
}

/// These URIs reach the approval page as links, so `javascript:` and the like
/// never register.
fn web_uri(object: &Map<String, Value>, name: &str) -> Reading<Option<String>> {
    let Some(uri) = text(object, name)? else {
        return Ok(None);
    };
    let good = redirect::is_plain(uri)
        && Url::parse(uri).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        });
    if !good {
        return Err(RegistrationError::metadata(format!(
            "{name} must be an http or https URL."
        )));
    }
    Ok(Some(uri.to_string()))
}

/// RFC 8707 resources are validated here; each token request sets its own audience.
fn check_resources(object: &Map<String, Value>) -> Reading<()> {
    for resource in texts(object, "resources")?.unwrap_or_default() {
        let absolute = redirect::is_plain(resource)
            && Url::parse(resource).is_ok_and(|url| url.fragment().is_none());
        if !absolute {
            return Err(RegistrationError {
                error: ErrorCode::InvalidTarget,
                description: "Each resource must be an absolute URI without a fragment."
                    .to_string(),
            });
        }
    }
    Ok(())
}

/// RFC 7591 section 2 requires ignoring unsupported metadata.
pub(super) fn read(
    object: &Map<String, Value>,
    source: Source,
    allowed: &ScopeSet,
) -> Reading<Registration> {
    let token_endpoint_auth_method = auth_method(object)?;
    if source == Source::Registration {
        check_resources(object)?;
    }
    let grants = grant_types(object, source)?;
    let response_types = response_types(object, source, &grants)?;
    let uris = redirect_uris(object)?;
    let kind = application_type(object, source, &uris)?;
    if uris.is_empty() && grants.contains(&GrantType::AuthorizationCode) {
        return Err(RegistrationError::redirect(
            "The authorization_code grant needs at least one redirect URI.",
        ));
    }
    for uri in &uris {
        redirect::check_registered(kind, uri)
            .map_err(|refused| RegistrationError::redirect(refused.to_string()))?;
    }
    Ok(Registration {
        application_type: kind,
        token_endpoint_auth_method,
        scope: scope(object, &grants, allowed)?,
        grant_types: grants,
        response_types,
        redirect_uris: uris.into_iter().map(str::to_string).collect(),
        client_name: text(object, "client_name")?.map(str::to_string),
        client_uri: web_uri(object, "client_uri")?,
        logo_uri: web_uri(object, "logo_uri")?,
        tos_uri: web_uri(object, "tos_uri")?,
        policy_uri: web_uri(object, "policy_uri")?,
        contacts: texts(object, "contacts")?
            .unwrap_or_default()
            .into_iter()
            .map(str::to_string)
            .collect(),
        software_id: text(object, "software_id")?.map(str::to_string),
        software_version: text(object, "software_version")?.map(str::to_string),
    })
}

/// `allowed` is the default scope of a client that names none. The door caps the body's size
/// before this.
pub fn parse_registration(body: &[u8], allowed: &ScopeSet) -> Reading<Registration> {
    let value: Value = serde_json::from_slice(body)
        .map_err(|_| RegistrationError::metadata("The body is not valid JSON."))?;
    let object = value
        .as_object()
        .ok_or_else(|| RegistrationError::metadata("The body must be a JSON object."))?;
    read(object, Source::Registration, allowed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn allowed() -> ScopeSet {
        ScopeSet::parse("core.note:read core.note:write offline_access")
    }

    fn register(body: Value) -> Reading<Registration> {
        parse_registration(body.to_string().as_bytes(), &allowed())
    }

    fn refused(body: Value) -> RegistrationError {
        register(body).expect_err("refused")
    }

    fn web() -> Value {
        json!({ "redirect_uris": ["https://app.example/callback"] })
    }

    fn device() -> Value {
        json!({
            "application_type": "native",
            "grant_types": [DEVICE_CODE_GRANT],
            "response_types": [],
        })
    }

    fn with(mut base: Value, name: &str, value: Value) -> Value {
        base[name] = value;
        base
    }

    #[test]
    fn a_web_client_is_the_default_with_the_authorization_code_grant() {
        let registered = register(web()).expect("registered");
        assert_eq!(registered.application_type, AppKind::Web);
        assert_eq!(registered.token_endpoint_auth_method, AuthMethod::None);
        assert_eq!(registered.grant_types, [GrantType::AuthorizationCode]);
        assert_eq!(registered.response_types, [ResponseType::Code]);
        assert_eq!(registered.scope, allowed());
    }

    #[test]
    fn the_command_line_registers_as_it_does_today() {
        let registered = register(json!({
            "client_name": "marfa",
            "application_type": "native",
            "software_id": "so.marfa.cli",
            "grant_types": [DEVICE_CODE_GRANT, "refresh_token"],
            "response_types": [],
            "token_endpoint_auth_method": "none",
        }))
        .expect("registered");
        assert_eq!(
            registered.grant_types,
            [GrantType::DeviceCode, GrantType::RefreshToken]
        );
        assert!(registered.response_types.is_empty());
        assert!(registered.redirect_uris.is_empty());
        assert_eq!(registered.software_id.as_deref(), Some("so.marfa.cli"));
        assert!(registered.scope.contains(OFFLINE_ACCESS));
    }

    #[test]
    fn an_auth_method_is_none_or_refused() {
        for method in [json!(null), json!("none")] {
            let registered = register(with(web(), "token_endpoint_auth_method", method));
            assert_eq!(
                registered.expect("registered").token_endpoint_auth_method,
                AuthMethod::None
            );
        }
        for (method, named) in [
            ("client_secret_basic", "client_secret_basic"),
            ("client_secret_post", "client_secret_post"),
            ("private_key_jwt", "private_key_jwt"),
            (" private_key_jwt ", "private_key_jwt"),
            ("client_secret_jwt", "token_endpoint_auth_method"),
            ("NONE", "token_endpoint_auth_method"),
        ] {
            let error = refused(with(web(), "token_endpoint_auth_method", json!(method)));
            assert_eq!(error.error, ErrorCode::InvalidClientMetadata, "{method}");
            assert!(error.description.contains(named), "{method}");
        }
    }

    #[test]
    fn unsupported_metadata_registers_and_is_not_answered() {
        let mut body = device();
        for (name, value) in [
            ("dpop_bound_access_tokens", json!(true)),
            ("subject_type", json!("pairwise")),
            ("software_statement", json!("a.b.c")),
            ("resources", json!(["https://resource.example/"])),
        ] {
            body = with(body, name, value);
        }
        let answer = register(body).expect("registered").to_json();
        for name in [
            "dpop_bound_access_tokens",
            "subject_type",
            "software_statement",
            "resources",
        ] {
            assert!(!answer.contains_key(name), "{name}");
        }
    }

    #[test]
    fn a_resource_is_an_absolute_uri_without_a_fragment() {
        for resource in [
            "not-a-uri",
            "/relative",
            "https://a.example/#part",
            " https://a.example/",
            "",
        ] {
            let error = refused(with(device(), "resources", json!([resource])));
            assert_eq!(error.error, ErrorCode::InvalidTarget, "{resource:?}");
        }
        let error = refused(with(device(), "resources", json!("https://a.example/")));
        assert_eq!(error.error, ErrorCode::InvalidClientMetadata);
    }

    #[test]
    fn a_body_that_is_not_an_object_is_an_rfc_error() {
        for body in [&b"not json"[..], b"", b"[]", b"1", b"null", &[0xff, 0xfe]] {
            let error = parse_registration(body, &allowed()).expect_err("refused");
            assert_eq!(error.error, ErrorCode::InvalidClientMetadata);
            assert_eq!(error.to_json()["error"], "invalid_client_metadata");
            assert!(error.to_json()["error_description"].is_string());
        }
    }

    #[test]
    fn a_field_of_the_wrong_type_is_refused_and_null_is_absent() {
        for name in [
            "client_name",
            "application_type",
            "scope",
            "client_uri",
            "software_id",
            "token_endpoint_auth_method",
        ] {
            assert_eq!(
                refused(with(web(), name, json!(1))).error,
                ErrorCode::InvalidClientMetadata,
                "{name}"
            );
            assert!(register(with(web(), name, json!(null))).is_ok(), "{name}");
        }
        for name in ["grant_types", "response_types", "contacts"] {
            for value in [json!("code"), json!([1])] {
                assert_eq!(
                    refused(with(web(), name, value)).error,
                    ErrorCode::InvalidClientMetadata,
                    "{name}"
                );
            }
        }
        for value in [json!("https://app.example/cb"), json!([1])] {
            assert_eq!(
                refused(with(web(), "redirect_uris", value)).error,
                ErrorCode::InvalidRedirectUri
            );
        }
    }

    #[test]
    fn a_grant_or_response_type_this_server_lacks_is_refused() {
        for (name, value) in [
            ("grant_types", json!(["implicit"])),
            ("grant_types", json!(["authorization_code", "password"])),
            ("grant_types", json!(["client_credentials"])),
            ("grant_types", json!([])),
            ("response_types", json!(["token"])),
            ("response_types", json!(["code", "id_token"])),
            ("response_types", json!([])),
        ] {
            assert_eq!(
                refused(with(web(), name, value.clone())).error,
                ErrorCode::InvalidClientMetadata,
                "{name} {value}"
            );
        }
        let once = with(
            web(),
            "grant_types",
            json!(["refresh_token", "refresh_token"]),
        );
        assert_eq!(
            register(once).expect("registered").grant_types,
            [GrantType::RefreshToken]
        );
    }

    #[test]
    fn a_client_of_the_code_grant_needs_a_redirect_uri_and_a_device_client_does_not() {
        for body in [json!({}), json!({ "redirect_uris": [] })] {
            assert_eq!(refused(body).error, ErrorCode::InvalidRedirectUri);
        }
        assert!(register(device()).is_ok());
    }

    #[test]
    fn at_most_ten_redirect_uris_register() {
        let uris = |count: usize| {
            let list: Vec<String> = (0..count)
                .map(|at| format!("https://app.example/{at}"))
                .collect();
            json!({ "redirect_uris": list })
        };
        assert_eq!(
            register(uris(10)).expect("registered").redirect_uris.len(),
            10
        );
        let error = refused(uris(11));
        assert_eq!(error.error, ErrorCode::InvalidRedirectUri);
        assert!(error.description.contains("10"));
    }

    #[test]
    fn one_bad_redirect_uri_refuses_the_registration() {
        let body = json!({
            "redirect_uris": ["https://app.example/a", "http://app.example/b"],
        });
        assert_eq!(refused(body).error, ErrorCode::InvalidRedirectUri);
        let body = json!({ "application_type": "web", "redirect_uris": ["http://127.0.0.1/cb"] });
        assert_eq!(refused(body).error, ErrorCode::InvalidRedirectUri);
        let body = json!({ "redirect_uris": ["http://127.0.0.1/cb"] });
        assert_eq!(refused(body).error, ErrorCode::InvalidRedirectUri);
        let body =
            json!({ "application_type": "native", "redirect_uris": ["http://127.0.0.1/cb"] });
        assert!(register(body).is_ok());
    }

    #[test]
    fn an_unknown_application_type_is_refused() {
        for kind in ["desktop", "WEB", ""] {
            assert_eq!(
                refused(with(web(), "application_type", json!(kind))).error,
                ErrorCode::InvalidClientMetadata,
                "{kind}"
            );
        }
    }

    #[test]
    fn a_named_scope_registers_as_named_once_each_in_first_named_order() {
        let body = with(
            web(),
            "scope",
            json!("core.note:write core.note:read core.note:write  notes"),
        );
        assert_eq!(
            register(body).expect("registered").scope.to_text(),
            "core.note:write core.note:read notes"
        );
    }

    #[test]
    fn a_scope_of_nothing_is_no_scope_named() {
        for scope in [json!(""), json!("   "), json!(null)] {
            let body = with(web(), "scope", scope);
            assert_eq!(register(body).expect("registered").scope, allowed());
        }
    }

    #[test]
    fn a_scope_with_a_character_no_scope_holds_is_refused() {
        for scope in ["a\tb", "a\nb", "a\"b", "a\\b", "caf\u{e9}"] {
            assert_eq!(
                refused(with(web(), "scope", json!(scope))).error,
                ErrorCode::InvalidClientMetadata,
                "{scope:?}"
            );
        }
    }

    #[test]
    fn a_client_that_cannot_refresh_has_no_offline_access() {
        let error = refused(with(device(), "scope", json!("offline_access")));
        assert_eq!(error.error, ErrorCode::InvalidClientMetadata);
        assert!(error.description.contains("refresh_token"));

        let default = register(device()).expect("registered").scope;
        assert!(!default.contains(OFFLINE_ACCESS));
        assert!(default.contains("core.note:read"));

        let refreshing = with(
            device(),
            "grant_types",
            json!([DEVICE_CODE_GRANT, "refresh_token"]),
        );
        let named = with(refreshing, "scope", json!("offline_access"));
        assert!(register(named).is_ok());
        assert!(register(with(web(), "scope", json!("offline_access"))).is_ok());
    }

    #[test]
    fn what_is_not_read_is_neither_kept_nor_answered() {
        let body = with(
            with(
                web(),
                "backchannel_logout_uri",
                json!("https://app.example/x"),
            ),
            "bogus",
            json!(1),
        );
        let answered = register(body).expect("registered").to_json();
        assert!(answered.contains_key("redirect_uris"));
        assert!(!answered.contains_key("backchannel_logout_uri"));
        assert!(!answered.contains_key("bogus"));
    }

    #[test]
    fn the_answer_holds_what_was_registered() {
        let body = json!({
            "client_name": "An app",
            "client_uri": "https://app.example/",
            "logo_uri": "https://app.example/logo.png",
            "tos_uri": "https://app.example/tos",
            "policy_uri": "https://app.example/policy",
            "contacts": ["support@app.example"],
            "software_id": "an-app",
            "software_version": "1",
            "redirect_uris": ["https://app.example/callback"],
            "scope": "core.note:read",
        });
        let answered = Value::Object(register(body.clone()).expect("registered").to_json());
        for (name, value) in body.as_object().expect("an object") {
            assert_eq!(&answered[name], value, "{name}");
        }
        assert_eq!(answered["application_type"], "web");
        assert_eq!(answered["token_endpoint_auth_method"], "none");
        assert_eq!(answered["grant_types"], json!(["authorization_code"]));
        assert_eq!(answered["response_types"], json!(["code"]));
    }

    #[test]
    fn a_link_shown_on_the_approval_page_is_a_web_address() {
        for name in ["client_uri", "logo_uri", "tos_uri", "policy_uri"] {
            for uri in [
                "javascript:alert(1)",
                "data:text/html,x",
                "not a url",
                "https://user:pw@app.example/",
                "https://app.example\\@evil.example/",
                " https://app.example/",
            ] {
                assert_eq!(
                    refused(with(web(), name, json!(uri))).error,
                    ErrorCode::InvalidClientMetadata,
                    "{name} {uri}"
                );
            }
            assert!(register(with(web(), name, json!("http://app.example/"))).is_ok());
        }
    }

    fn json_value() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i32>().prop_map(|number| json!(number)),
            any::<String>().prop_map(Value::String),
            prop_oneof![
                Just("native"),
                Just("web"),
                Just("none"),
                Just("offline_access"),
                Just("refresh_token"),
                Just("authorization_code"),
                Just("code"),
                Just("https://app.example/cb"),
                Just("http://127.0.0.1/cb"),
                Just("com.example.app:/cb"),
            ]
            .prop_map(|word| json!(word)),
        ];
        leaf.prop_recursive(2, 12, 4, |inner| {
            proptest::collection::vec(inner, 0..4).prop_map(Value::Array)
        })
    }

    fn metadata_body() -> impl Strategy<Value = Value> {
        let name = prop_oneof![
            Just("application_type"),
            Just("token_endpoint_auth_method"),
            Just("grant_types"),
            Just("response_types"),
            Just("redirect_uris"),
            Just("scope"),
            Just("client_uri"),
            Just("contacts"),
            Just("bogus"),
        ];
        proptest::collection::vec((name, json_value()), 0..8).prop_map(|fields| {
            let object: Map<String, Value> = fields
                .into_iter()
                .map(|(name, value)| (name.to_string(), value))
                .collect();
            Value::Object(object)
        })
    }

    proptest! {
        #[test]
        fn nothing_panics_on_any_bytes(body in proptest::collection::vec(any::<u8>(), 0..64)) {
            let _ = parse_registration(&body, &allowed());
        }

        #[test]
        fn what_registers_keeps_every_rule(body in metadata_body()) {
            if let Ok(registered) = register(body) {
                prop_assert_eq!(registered.token_endpoint_auth_method, AuthMethod::None);
                prop_assert!(registered.redirect_uris.len() <= MAX_REDIRECT_URIS);
                for uri in &registered.redirect_uris {
                    prop_assert_eq!(
                        redirect::check_registered(registered.application_type, uri),
                        Ok(())
                    );
                }
                if !registered.can_refresh() {
                    prop_assert!(!registered.scope.contains(OFFLINE_ACCESS));
                }
                if registered.names_grant(GrantType::AuthorizationCode) {
                    prop_assert!(!registered.redirect_uris.is_empty());
                    prop_assert!(registered.response_types.contains(&ResponseType::Code));
                }
            }
        }

        #[test]
        fn a_secret_method_stays_refused_in_any_case(
            method in prop_oneof![
                Just("client_secret_basic"),
                Just("client_secret_post"),
                Just("private_key_jwt"),
            ],
            upper in proptest::collection::vec(any::<bool>(), 20),
        ) {
            let dressed: String = method
                .chars()
                .zip(upper.iter().cycle())
                .map(|(c, up)| if *up { c.to_ascii_uppercase() } else { c })
                .collect();
            let error = refused(with(web(), "token_endpoint_auth_method", json!(dressed)));
            prop_assert_eq!(error.error, ErrorCode::InvalidClientMetadata);
        }

        #[test]
        fn a_refused_redirect_uri_refuses_whatever_stands_beside_it(
            at in 0usize..4,
            trick in prop_oneof![
                Just("https://user@app.example/cb"),
                Just("https://app.example/cb#x"),
                Just("https://app.example\\cb"),
                Just("https://LOCALHOST./cb"),
                Just("https://[::ffff:7f00:1]/cb"),
                Just("https://%6c%6f%63%61%6c%68%6f%73%74/cb"),
                Just("http://app.example/cb"),
            ],
        ) {
            let mut uris: Vec<&str> = vec!["https://app.example/a"; 3];
            uris.insert(at, trick);
            let error = refused(json!({ "redirect_uris": uris }));
            prop_assert_eq!(error.error, ErrorCode::InvalidRedirectUri);
        }
    }
}
