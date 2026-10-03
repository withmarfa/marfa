use std::io::Read;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use serde::de::DeserializeOwned;
use ureq::Agent;
use url::Url;

use crate::contract::CONTRACT_VERSION;
use crate::error::CoreError;
use crate::model::Tier;
use crate::wire::{
    WireCatalog, WireEdge, WireEdgeType, WireErrorEnvelope, WireItemWithMetadata, WirePage,
    WireType,
};

pub const PAGE_LIMIT: u32 = 200;

pub struct Http {
    agent: Agent,
    base: Url,
    authorization: RwLock<String>,
    renew: OnceLock<Renew>,
    /// Held while a renewal runs, so two calls refused at once renew once.
    renewing: Mutex<()>,
}

/// Handed the refused bearer, so a caller that keeps the credential elsewhere
/// can tell whether another process has rotated it already.
pub type Renew = Box<dyn Fn(&str) -> Result<String, CoreError> + Send + Sync>;

type Response = ureq::http::Response<ureq::Body>;

pub struct ItemsQuery<'a> {
    /// `None` lists every type the key reads.
    pub r#type: Option<&'a str>,
    pub tier: Tier,
    pub cursor: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Patch,
    Put,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Patch => "PATCH",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
        }
    }
}

pub struct Outgoing<'a> {
    pub method: Method,
    pub segments: Vec<String>,
    pub params: Vec<(String, String)>,
    pub body: &'a str,
    pub idempotency_key: &'a str,
}

#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    /// The server's error code, or empty on a success.
    pub code: String,
    pub body: String,
    pub retry_after_seconds: Option<u64>,
    /// The server answered from its idempotency record rather than writing.
    pub replayed: bool,
    /// The server names its contract on every answer, so a refusal naming
    /// none came from something in front of it, a proxy or a tunnel.
    pub contract_named: bool,
}

impl Answer {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// A refusal that says nothing of the write: the network's, a rate
    /// limit, a failing server, or one naming no contract (`Http::refused`).
    pub fn is_environmental(&self) -> bool {
        !self.is_success()
            && (!self.contract_named || matches!(self.status, 408 | 425 | 429 | 500..=599))
    }
}

/// A blob upload streams from a `Reader` rather than buffering the file, so
/// the cap on a blob is the server's alone.
pub enum CallBody<'a> {
    None,
    Json(&'a str),
    Text(&'a str),
    Reader(Box<dyn Read + Send + 'static>),
}

pub struct Call<'a> {
    pub method: Method,
    pub segments: &'a [&'a str],
    pub params: &'a [(&'a str, &'a str)],
    pub headers: &'a [(&'a str, &'a str)],
    pub body: CallBody<'a>,
    /// A public door is called without the credential even when one is held,
    /// so it cannot be refused for a credential it never needed.
    pub credential: bool,
    /// Only the binary's transport hands a reader back; the core's own calls
    /// read every answer whole.
    pub stream: bool,
}

/// Every status the server can answer with is a `Reply`; an `Err` is a
/// transport failure, or, from the core's own transport, an answer on
/// another contract.
pub struct Reply<B = ReplyBody> {
    pub status: u16,
    pub content_type: String,
    pub retry_after_seconds: Option<u64>,
    /// The binary's transport hands it to the caller to judge; the core's has
    /// judged it before a `Reply` exists.
    pub contract: Option<String>,
    pub location: Option<String>,
    pub body: B,
}

pub const CONTRACT_HEADER: &str = "X-Marfa-Contract";

/// A refusal naming no contract is readable: a proxy in front of the server
/// answers without one, and its status is still the truth.
pub fn speaks_contract(expected: u64, contract: Option<&str>, status: u16) -> bool {
    match contract {
        Some(served) => served == expected.to_string(),
        None => !(200..300).contains(&status),
    }
}

pub enum ReplyBody {
    Text(String),
    Stream(Box<dyn Read + Send>),
}

impl Http {
    pub fn new(url: &str, key: &str) -> Result<Http, CoreError> {
        let mut base = Url::parse(url)?;
        if base.cannot_be_a_base() {
            return Err(CoreError::Invalid(format!("not a server url: {url}")));
        }
        let path = base.path().trim_end_matches('/').to_string();
        base.set_path(&path);
        base.set_query(None);
        base.set_fragment(None);
        // The platform trust store, as the binary's own client uses, so a
        // server behind a CA the machine trusts is reachable from both.
        let tls = ureq::tls::TlsConfig::builder()
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let agent: Agent = Agent::config_builder()
            .tls_config(tls)
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .build()
            .into();
        Ok(Http {
            agent,
            base,
            authorization: RwLock::new(format!("Bearer {key}")),
            renew: OnceLock::new(),
            renewing: Mutex::new(()),
        })
    }

    /// Set once; a second is ignored.
    pub fn renew_with(&self, renew: Renew) {
        let _ = self.renew.set(renew);
    }

    pub(crate) fn authorization(&self) -> String {
        self.authorization
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Only an attributed credential refusal leaves the original `401` as
    /// the answer. Local credential failures have no server verdict.
    fn renewed(&self, sent: &str) -> Result<Option<String>, CoreError> {
        match self.renewal(sent) {
            Ok(fresh) => Ok(fresh),
            Err(CoreError::Unauthorized { .. }) => Ok(None),
            Err(error) => Err(CoreError::RenewalFailed(Box::new(error))),
        }
    }

    fn renewal(&self, sent: &str) -> Result<Option<String>, CoreError> {
        let Some(renew) = self.renew.get() else {
            return Ok(None);
        };
        let _one = self
            .renewing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = self.authorization();
        if current != sent {
            return Ok(Some(current));
        }
        let header = format!(
            "Bearer {}",
            renew(sent.strip_prefix("Bearer ").unwrap_or(sent))?
        );
        self.authorization
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone_from(&header);
        Ok(Some(header))
    }

    fn authorized(
        &self,
        run: impl Fn(&str) -> Result<Response, CoreError>,
    ) -> Result<Response, CoreError> {
        let sent = self.authorization();
        let response = run(&sent)?;
        if response.status().as_u16() == 401
            && header(&response, CONTRACT_HEADER).as_deref()
                == Some(CONTRACT_VERSION.to_string().as_str())
            && let Some(fresh) = self.renewed(&sent)?
        {
            return run(&fresh);
        }
        Ok(response)
    }

    /// Every refusal the core reads becomes an error here, and the one rule
    /// is that a refusal naming no contract is not the server's: a gateway's
    /// `401` is no word on the key, nor a proxy's `404` on a row.
    pub(crate) fn refused(
        &self,
        status: u16,
        named: bool,
        text: &str,
        retry_after_seconds: Option<u64>,
    ) -> CoreError {
        if named {
            refusal(status, text, retry_after_seconds)
        } else {
            CoreError::Unnamed {
                origin: self.origin(),
                status,
                retry_after_seconds,
            }
        }
    }

    /// Identifies a server without identifying a key.
    pub fn origin(&self) -> String {
        format!(
            "{}{}",
            self.base.origin().ascii_serialization(),
            self.base.path().trim_end_matches('/')
        )
    }

    pub fn types(&self) -> Result<Vec<WireType>, CoreError> {
        let mut types = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params: Vec<(&str, &str)> = cursor
                .as_deref()
                .map(|cursor| vec![("cursor", cursor)])
                .unwrap_or_default();
            let page: WirePage<WireType> = self.get_json(&["types"], &params)?;
            types.extend(page.data);
            match page.next_cursor {
                None => return Ok(types),
                Some(next) if Some(&next) == cursor.as_ref() => {
                    return Err(CoreError::Decoding(
                        "the server kept answering with the same cursor while reporting more types"
                            .into(),
                    ));
                }
                Some(next) => cursor = Some(next),
            }
        }
    }

    pub fn items_page(
        &self,
        query: &ItemsQuery<'_>,
    ) -> Result<WirePage<WireItemWithMetadata>, CoreError> {
        let limit = PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = query
            .r#type
            .map(|declared| ("type", declared))
            .into_iter()
            .collect();
        params.extend([
            ("tier", query.tier.as_str()),
            ("state", "any"),
            ("include", "edges,metadata"),
            ("limit", &limit),
        ]);
        if let Some(cursor) = query.cursor {
            params.push(("cursor", cursor));
        }
        self.get_json(&["items"], &params)
    }

    pub fn item_edges_page(
        &self,
        id: &str,
        edge_type: &str,
        cursor: Option<&str>,
    ) -> Result<WirePage<WireEdge>, CoreError> {
        let limit = PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = vec![("edge_type", edge_type), ("limit", &limit)];
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor));
        }
        self.get_json(&["items", id, "edges"], &params)
    }

    pub fn edges_page(
        &self,
        edge_type: &str,
        cursor: Option<&str>,
    ) -> Result<WirePage<WireEdge>, CoreError> {
        let limit = PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = vec![("edge_type", edge_type), ("limit", &limit)];
        if let Some(cursor) = cursor {
            params.push(("cursor", cursor));
        }
        self.get_json(&["edges"], &params)
    }

    pub fn edge_types(&self) -> Result<Vec<serde_json::Value>, CoreError> {
        let mut rows = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params: Vec<(&str, &str)> = cursor
                .as_deref()
                .map(|cursor| vec![("cursor", cursor)])
                .unwrap_or_default();
            let page: WirePage<serde_json::Value> = self.get_json(&["edge-types"], &params)?;
            for row in page.data {
                serde_json::from_value::<WireEdgeType>(row.clone()).map_err(|error| {
                    CoreError::Decoding(format!("an edge type the server listed: {error}"))
                })?;
                rows.push(row);
            }
            match page.next_cursor {
                None => return Ok(rows),
                Some(next) if Some(&next) == cursor.as_ref() => {
                    return Err(CoreError::Decoding(
                        "the server kept answering with the same cursor while reporting more edge types"
                            .into(),
                    ));
                }
                Some(next) => cursor = Some(next),
            }
        }
    }

    /// The instance the server says it is, which its root answers to anyone.
    pub fn instance_id(&self) -> Result<String, CoreError> {
        #[derive(serde::Deserialize)]
        struct Root {
            instance_id: String,
        }
        Ok(self.get_json::<Root>(&[], &[])?.instance_id)
    }

    pub fn catalog(&self) -> Result<WireCatalog, CoreError> {
        Ok(WireCatalog {
            types: self.types()?,
            edge_types: self.edge_types()?,
        })
    }

    /// The server matches without regard to ASCII case. The flag says
    /// whether `pages` pages left more.
    pub fn items_containing(
        &self,
        field: &str,
        text: &str,
        pages: usize,
    ) -> Result<(Vec<WireItemWithMetadata>, bool), CoreError> {
        // The grammar escapes only a quote, so a closing backslash cannot be
        // written; the caller matches the whole name after.
        let searched = text.trim_end_matches('\\').replace('"', "\\\"");
        let filter = format!("properties.{field} contains \"{searched}\"");
        let limit = PAGE_LIMIT.to_string();
        let mut found = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..pages {
            let mut params: Vec<(&str, &str)> = vec![
                ("filter", &filter),
                ("state", "any"),
                ("include", "metadata"),
                ("limit", &limit),
            ];
            if let Some(cursor) = &cursor {
                params.push(("cursor", cursor));
            }
            let page: WirePage<WireItemWithMetadata> = self.get_json(&["items"], &params)?;
            found.extend(page.data);
            match page.next_cursor {
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                _ => return Ok((found, false)),
            }
        }
        Ok((found, true))
    }

    /// `None` for a credential that is not a key, which that door refuses
    /// `403`.
    pub fn current_key(&self) -> Result<Option<serde_json::Value>, CoreError> {
        match self.get_json::<serde_json::Value>(&["keys", "current"], &[]) {
            Ok(key) => Ok(Some(key)),
            Err(CoreError::Forbidden { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn item_with_edges(&self, id: &str) -> Result<Option<WireItemWithMetadata>, CoreError> {
        match self
            .get_json::<WireItemWithMetadata>(&["items", id], &[("include", "edges,metadata")])
        {
            Ok(item) => Ok(Some(item)),
            Err(CoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn item(&self, id: &str) -> Result<Option<WireItemWithMetadata>, CoreError> {
        match self.get_json::<WireItemWithMetadata>(&["items", id], &[("include", "metadata")]) {
            Ok(item) => Ok(Some(item)),
            Err(CoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Redirects, contract mismatches and transport or renewal failures are
    /// errors. Other responses retain their status and code together for the
    /// drain to classify; `refusal()` drops the status.
    pub fn send(&self, outgoing: &Outgoing<'_>) -> Result<Answer, CoreError> {
        let segments: Vec<&str> = outgoing.segments.iter().map(String::as_str).collect();
        let params: Vec<(&str, &str)> = outgoing
            .params
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let url = self.url(&segments, &params);
        // Not the agent's per-method builders: those split at the type level
        // on whether a method carries a body, which would mean one header
        // list per method.
        let response = self.authorized(|authorization| {
            let request = ureq::http::Request::builder()
                .method(outgoing.method.as_str())
                .uri(url.as_str())
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", outgoing.idempotency_key)
                .header("Authorization", authorization)
                .body(outgoing.body)
                .map_err(|error| {
                    CoreError::Invalid(format!("this write cannot be sent: {error}"))
                })?;
            self.agent
                .run(request)
                .map_err(|error| CoreError::Network(error.to_string()))
        })?;
        let status = response.status().as_u16();
        self.hold(&response, status, true)?;
        let contract_named = header(&response, CONTRACT_HEADER).is_some();
        let retry_after_seconds = retry_after(&response);
        let replayed = response
            .headers()
            .get("Idempotency-Replayed")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        // A body that will not read is a transport failure, not an answer.
        let body = response
            .into_body()
            .read_to_string()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        let code = match serde_json::from_str::<WireErrorEnvelope>(&body) {
            Ok(envelope) => envelope.error.code,
            Err(_) => String::new(),
        };
        Ok(Answer {
            status,
            code,
            body,
            retry_after_seconds,
            replayed,
            contract_named,
        })
    }

    pub fn open_events(
        &self,
        last_event_id: Option<&str>,
        body_timeout: Duration,
    ) -> Result<Box<dyn Read + Send>, CoreError> {
        let url = self.url(&["events"], &[("edges", "all")]);
        let response = self.authorized(|authorization| {
            let mut request = self
                .agent
                .get(url.as_str())
                .header("Accept", "text/event-stream")
                .config()
                .timeout_recv_body(Some(body_timeout))
                .build()
                .header("Authorization", authorization);
            if let Some(cursor) = last_event_id {
                request = request.header("Last-Event-ID", cursor);
            }
            request
                .call()
                .map_err(|error| CoreError::Network(error.to_string()))
        })?;
        let status = response.status().as_u16();
        self.hold(&response, status, false)?;
        if !(200..300).contains(&status) {
            let named = header(&response, CONTRACT_HEADER).is_some();
            let retry_after = retry_after(&response);
            let text = response.into_body().read_to_string().unwrap_or_default();
            return Err(self.refused(status, named, &text, retry_after));
        }
        Ok(Box::new(response.into_body().into_reader()))
    }

    /// A call refused `401` is sent again under a renewed credential, except
    /// one whose body is a reader, which the first send spent: the credential
    /// is renewed for the calls after it, and its caller sends it again.
    pub fn call(&self, call: Call<'_>) -> Result<Reply<String>, CoreError> {
        let url = self.url(call.segments, call.params);
        let json = matches!(call.body, CallBody::Json(_));
        let builder = |authorization: Option<&str>| {
            let mut builder = ureq::http::Request::builder()
                .method(call.method.as_str())
                .uri(url.as_str())
                .header("Accept", "application/json");
            if let Some(authorization) = authorization {
                builder = builder.header("Authorization", authorization);
            }
            if json {
                builder = builder.header("Content-Type", "application/json");
            }
            for (name, value) in call.headers {
                builder = builder.header(*name, *value);
            }
            builder
        };
        let cannot_send = |error: ureq::http::Error| {
            CoreError::Invalid(format!("this call cannot be sent: {error}"))
        };
        let network = |error: ureq::Error| CoreError::Network(error.to_string());
        let send = |authorization: Option<&str>, text: Option<&str>| {
            let builder = builder(authorization);
            match text {
                Some(text) => self.agent.run(builder.body(text).map_err(cannot_send)?),
                None => self.agent.run(builder.body(()).map_err(cannot_send)?),
            }
            .map_err(network)
        };
        let text = match &call.body {
            CallBody::None => None,
            CallBody::Json(text) | CallBody::Text(text) => Some(*text),
            CallBody::Reader(_) => None,
        };
        let response = match call.body {
            CallBody::Reader(reader) => {
                let sent = call.credential.then(|| self.authorization());
                let response = self
                    .agent
                    .run(
                        builder(sent.as_deref())
                            .body(ureq::SendBody::from_owned_reader(reader))
                            .map_err(cannot_send)?,
                    )
                    .map_err(network)?;
                if let Some(sent) = &sent
                    && response.status().as_u16() == 401
                    && header(&response, CONTRACT_HEADER).as_deref()
                        == Some(CONTRACT_VERSION.to_string().as_str())
                {
                    self.renewed(sent)?;
                }
                response
            }
            _ if call.credential => {
                self.authorized(|authorization| send(Some(authorization), text))?
            }
            _ => send(None, text)?,
        };
        let status = response.status().as_u16();
        self.hold(&response, status, call.method != Method::Get)?;
        let retry_after_seconds = retry_after(&response);
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let contract = header(&response, CONTRACT_HEADER);
        let location = header(&response, "Location");
        let body = response
            .into_body()
            .read_to_string()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        Ok(Reply {
            status,
            content_type,
            retry_after_seconds,
            contract,
            location,
            body,
        })
    }

    /// Runs before anything reads the body. A write refused here was sent.
    fn hold<B>(
        &self,
        response: &ureq::http::Response<B>,
        status: u16,
        write_sent: bool,
    ) -> Result<(), CoreError> {
        if (300..400).contains(&status) {
            return Err(CoreError::Redirected {
                origin: self.origin(),
                status,
                location: header(response, "Location"),
            });
        }
        let served = header(response, CONTRACT_HEADER);
        if speaks_contract(CONTRACT_VERSION, served.as_deref(), status) {
            return Ok(());
        }
        Err(CoreError::ContractMismatch {
            origin: self.origin(),
            served,
            expected: CONTRACT_VERSION,
            status: Some(status),
            write_sent,
        })
    }

    fn url(&self, segments: &[&str], params: &[(&str, &str)]) -> Url {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().expect("a server url has a path");
            path.pop_if_empty();
            path.extend(segments);
        }
        if !params.is_empty() {
            let mut query = url.query_pairs_mut();
            for (key, value) in params {
                query.append_pair(key, value);
            }
        }
        url
    }

    fn get_json<T: DeserializeOwned>(
        &self,
        segments: &[&str],
        params: &[(&str, &str)],
    ) -> Result<T, CoreError> {
        let url = self.url(segments, params);
        let response = self.authorized(|authorization| {
            self.agent
                .get(url.as_str())
                .header("Accept", "application/json")
                .header("Authorization", authorization)
                .call()
                .map_err(|error| CoreError::Network(error.to_string()))
        })?;
        let status = response.status().as_u16();
        self.hold(&response, status, false)?;
        let served = header(&response, CONTRACT_HEADER);
        let retry_after = retry_after(&response);
        let text = response
            .into_body()
            .read_to_string()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(self.refused(status, served.is_some(), &text, retry_after));
        }
        serde_json::from_str(&text)
            .map_err(|error| CoreError::Decoding(format!("{}: {error}", url.path())))
    }
}

fn header<B>(response: &ureq::http::Response<B>, name: &str) -> Option<String> {
    header_value(
        response
            .headers()
            .get_all(name)
            .iter()
            .map(|value| value.as_bytes()),
    )
}

/// Lines that disagree are joined, so the value matches none of them: an
/// answer naming its contract as both `1` and `2` speaks neither, and its
/// first line alone is whichever a proxy happened to put first.
pub fn header_value<'a>(lines: impl IntoIterator<Item = &'a [u8]>) -> Option<String> {
    let mut values: Vec<String> = Vec::new();
    for line in lines {
        let value = String::from_utf8_lossy(line).into_owned();
        if !values.contains(&value) {
            values.push(value);
        }
    }
    if values.is_empty() {
        None
    } else {
        Some(values.join(" and "))
    }
}

/// RFC 9110 allows a count of seconds or an HTTP-date. The date form is read
/// against the response's own `Date` header where it has one, so a local
/// clock that disagrees with the server's does not turn a short wait into a
/// long one.
fn retry_after<B>(response: &ureq::http::Response<B>) -> Option<u64> {
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    retry_after_seconds(header("Retry-After"), header("Date"))
}

pub fn retry_after_seconds(retry_after: Option<&str>, date: Option<&str>) -> Option<u64> {
    let raw = retry_after?.trim();
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(seconds);
    }
    let until = http_date(raw)?;
    let from = date.and_then(http_date).unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_secs() as i64)
            .unwrap_or(0)
    });
    Some(until.saturating_sub(from).max(0) as u64)
}

/// Only the IMF-fixdate form RFC 9110 requires a sender to produce; the two
/// obsolete forms are not parsed. An unreadable header is absent rather than
/// zero, because a wait of zero is a device asking again at once.
fn http_date(raw: &str) -> Option<i64> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|name| *name == parts[2])? as i64
        + 1;
    let year: i64 = parts[3].parse().ok()?;
    let clock: Vec<&str> = parts[4].split(':').collect();
    if clock.len() != 3 {
        return None;
    }
    let (hour, minute, second): (i64, i64, i64) = (
        clock[0].parse().ok()?,
        clock[1].parse().ok()?,
        clock[2].parse().ok()?,
    );
    // The days-from-civil algorithm.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Only for an answer naming the server's contract; `Http::refused` decides.
fn refusal(status: u16, text: &str, retry_after_seconds: Option<u64>) -> CoreError {
    let (code, message) = match serde_json::from_str::<WireErrorEnvelope>(text) {
        Ok(envelope) => (
            envelope.error.code,
            envelope.error.message.unwrap_or_default(),
        ),
        Err(_) => ("unknown".to_string(), text.chars().take(200).collect()),
    };
    match status {
        400 if code == "unknown_type" => CoreError::UnknownType { message },
        400 | 422 => CoreError::Validation { code, message },
        401 => CoreError::Unauthorized { code, message },
        403 => CoreError::Forbidden { code, message },
        404 => CoreError::NotFound { code, message },
        429 => CoreError::RateLimited {
            code,
            message,
            retry_after_seconds,
        },
        _ => CoreError::Server {
            status,
            code,
            message,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirects_are_not_followed_and_keep_the_original_response() {
        for status in [301, 302, 303, 307, 308] {
            for location in [Some("/next"), None] {
                let server = crate::scripted::Scripted::start();
                let headers = location
                    .into_iter()
                    .map(|value| ("Location".into(), value.into()))
                    .chain([(CONTRACT_HEADER.into(), (CONTRACT_VERSION + 1).to_string())])
                    .collect();
                let answer = crate::scripted::Answer::Json {
                    status,
                    body: "{}".into(),
                    headers,
                };
                for path in ["/items/x", "/events", "/blobs"] {
                    server.on(path, vec![answer.clone()]);
                }
                let http = Http::new(&server.url(), "k").unwrap();
                let read = http.item("x").unwrap_err();
                let write = http
                    .send(&Outgoing {
                        method: Method::Patch,
                        segments: vec!["items".into(), "x".into()],
                        params: vec![],
                        body: "{}",
                        idempotency_key: "fixture",
                    })
                    .unwrap_err();
                let stream = match http.open_events(None, Duration::from_secs(1)) {
                    Err(error) => error,
                    Ok(_) => panic!("a redirect opened an event stream"),
                };
                let upload = match http.call(Call {
                    method: Method::Post,
                    segments: &["blobs"],
                    params: &[],
                    headers: &[],
                    body: CallBody::Reader(Box::new(std::io::Cursor::new(b"fixture"))),
                    credential: true,
                    stream: false,
                }) {
                    Err(error) => error,
                    Ok(_) => panic!("a redirect accepted an upload"),
                };
                for error in [read, write, stream, upload] {
                    assert_eq!(
                        error,
                        CoreError::Redirected {
                            origin: server.url(),
                            status,
                            location: location.map(str::to_owned),
                        }
                    );
                }
                assert_eq!(server.asked(), 4);
                assert!(server.seen("/next").is_empty());
            }
        }
    }

    #[test]
    fn an_unnamed_or_other_contract_401_cannot_invoke_local_renewal() {
        for other_contract in [false, true] {
            let server = crate::scripted::Scripted::start();
            let mut answer = crate::scripted::unnamed(401, "denied");
            if other_contract && let crate::scripted::Answer::Json { headers, .. } = &mut answer {
                headers.push((CONTRACT_HEADER.into(), (CONTRACT_VERSION + 1).to_string()));
            }
            for path in ["/items/x", "/events", "/blobs"] {
                server.on(path, vec![answer.clone()]);
            }
            let http = Http::new(&server.url(), "k").unwrap();
            http.renew_with(Box::new(|_| panic!("an untrusted refusal invoked renewal")));
            let read = http.item("x").unwrap_err();
            let stream = match http.open_events(Some("1"), Duration::from_secs(1)) {
                Err(error) => error,
                Ok(_) => panic!("a refused stream opened"),
            };
            let upload = http.call(Call {
                method: Method::Post,
                segments: &["blobs"],
                params: &[],
                headers: &[],
                body: CallBody::Reader(Box::new(std::io::Cursor::new(b"fixture"))),
                credential: true,
                stream: false,
            });
            for error in [read, stream] {
                assert!(if other_contract {
                    matches!(
                        error,
                        CoreError::ContractMismatch {
                            status: Some(401),
                            ..
                        }
                    )
                } else {
                    matches!(error, CoreError::Unnamed { status: 401, .. })
                });
            }
            if other_contract {
                assert!(matches!(
                    upload,
                    Err(CoreError::ContractMismatch {
                        status: Some(401),
                        ..
                    })
                ));
            } else {
                let reply = upload.unwrap();
                assert_eq!(reply.status, 401);
                assert_eq!(reply.contract, None);
            }
        }
    }

    #[test]
    fn renewal_preserves_local_failures_and_real_server_refusal() {
        for error in [
            CoreError::SignedOut {
                origin: "https://marfa.example".into(),
            },
            CoreError::NoKeychain("locked".into()),
        ] {
            let server = crate::scripted::Scripted::start();
            server.on(
                "/items/x",
                vec![crate::scripted::refusal(401, "unauthorized")],
            );
            let http = Http::new(&server.url(), "k").unwrap();
            let expected = error.clone();
            http.renew_with(Box::new(move |_| Err(error.clone())));
            assert_eq!(
                http.item("x").unwrap_err(),
                CoreError::RenewalFailed(Box::new(expected))
            );
        }
    }

    #[test]
    fn a_refusal_naming_no_contract_is_the_network_on_every_read() {
        let server = crate::scripted::Scripted::start();
        let http = Http::new(&server.url(), "k").unwrap();
        for (status, code) in [
            (401, "access_denied"),
            (404, "not_found"),
            (403, "forbidden"),
        ] {
            for path in ["/items/x", "/types", "/events"] {
                server.on(path, vec![crate::scripted::unnamed(status, code)]);
            }
            let read = match http.item("x") {
                Ok(found) => panic!("an unnamed {status} read as an answer: {found:?}"),
                Err(error) => error,
            };
            let catalog = http.types().unwrap_err();
            let stream = match http.open_events(Some("1"), std::time::Duration::from_secs(5)) {
                Ok(_) => panic!("an unnamed {status} opened a stream"),
                Err(error) => error,
            };
            for refused in [read, catalog, stream] {
                assert!(
                    matches!(refused, CoreError::Unnamed { status: said, .. } if said == status),
                    "an unnamed {status} was read as the server's word: {refused:?}"
                );
                assert!(refused.is_environmental());
            }
        }
        // The witness: the same refusals naming the contract are the server's.
        server.on(
            "/items/x",
            vec![crate::scripted::refusal(401, "unauthorized")],
        );
        assert!(matches!(
            http.item("x"),
            Err(CoreError::Unauthorized { .. })
        ));
        server.on(
            "/items/x",
            vec![crate::scripted::refusal(404, "item_not_found")],
        );
        assert!(matches!(http.item("x"), Ok(None)));
    }

    #[test]
    fn unnamed_rate_limits_keep_the_wait_without_trusting_the_refusal() {
        let http = Http::new("https://marfa.example", "k").unwrap();
        for (seconds, expected) in [(None, None), (Some(7), Some(7)), (Some(86_400), Some(300))] {
            let error = http.refused(429, false, "slow down", seconds);
            assert!(matches!(error, CoreError::Unnamed { status: 429, .. }));
            assert!(error.is_environmental());
            assert_eq!(error.retry_after().map(|wait| wait.as_secs()), expected);
        }
        assert_eq!(
            http.refused(401, false, "no key", Some(7)).retry_after(),
            None
        );
    }

    #[test]
    fn origin_drops_the_key_the_query_and_a_trailing_slash() {
        let http = Http::new("HTTP://Localhost:8600/?x=1#f", "marfa_k1_secret").unwrap();
        assert_eq!(http.origin(), "http://localhost:8600");
        let gateway = Http::new("https://gw.example/TenantA/", "k").unwrap();
        assert_eq!(gateway.origin(), "https://gw.example/TenantA");
        assert_eq!(
            gateway
                .url(&["items", "a b"], &[("type", "core.note")])
                .as_str(),
            "https://gw.example/TenantA/items/a%20b?type=core.note"
        );
    }

    #[test]
    fn an_answer_is_read_only_on_the_contract_it_names() {
        assert!(speaks_contract(3, Some("3"), 200));
        assert!(speaks_contract(3, Some("3"), 404));
        assert!(!speaks_contract(3, Some("4"), 200));
        assert!(!speaks_contract(3, Some("4"), 404));
        assert!(!speaks_contract(3, None, 200));
        assert!(speaks_contract(3, None, 502));
        assert!(!speaks_contract(3, Some("03"), 200));
        assert!(!speaks_contract(1, Some("10"), 200));
        assert!(!speaks_contract(3, None, 299));
        assert!(speaks_contract(3, None, 300));
    }

    #[test]
    fn a_contract_refusal_names_both_contracts_and_whether_a_write_went() {
        let read = CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: Some("4".into()),
            expected: 3,
            status: Some(200),
            write_sent: false,
        }
        .to_string();
        assert!(read.contains("answered 200 on contract 4"), "{read}");
        assert!(read.contains("speaks contract 3"), "{read}");
        assert!(!read.contains("may have taken effect"), "{read}");
        let write = CoreError::ContractMismatch {
            origin: "https://marfa.example".into(),
            served: None,
            expected: 3,
            status: Some(201),
            write_sent: true,
        }
        .to_string();
        assert!(write.contains("answered 201 naming no contract"), "{write}");
        assert!(write.contains("check the URL"), "{write}");
        assert!(write.contains("may have taken effect"), "{write}");
    }

    #[test]
    fn a_wait_is_read_in_either_form_the_standard_allows() {
        assert_eq!(
            http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777)
        );
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        assert_eq!(http_date("Sunday, 06-Nov-94 08:49:37 GMT"), None);
        assert_eq!(http_date("nonsense"), None);
    }

    #[test]
    fn refusals_keep_the_server_code() {
        let body = r#"{"error":{"code":"unknown_type","message":"no such type"}}"#;
        assert_eq!(
            refusal(400, body, None),
            CoreError::UnknownType {
                message: "no such type".into()
            }
        );
        assert_eq!(
            refusal(
                404,
                r#"{"error":{"code":"item_not_found","message":"gone"}}"#,
                None
            ),
            CoreError::NotFound {
                code: "item_not_found".into(),
                message: "gone".into()
            }
        );
        assert!(matches!(
            refusal(
                429,
                r#"{"error":{"code":"rate_limited","message":"slow"}}"#,
                Some(7)
            ),
            CoreError::RateLimited {
                retry_after_seconds: Some(7),
                ..
            }
        ));
        assert!(matches!(
            refusal(502, "<html>", None),
            CoreError::Server { status: 502, .. }
        ));
    }
}
