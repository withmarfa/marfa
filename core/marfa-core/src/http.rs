use std::io::Read;
use std::time::Duration;

use serde::de::DeserializeOwned;
use ureq::Agent;
use url::Url;

use crate::error::CoreError;
use crate::model::Tier;
use crate::wire::{WireEdge, WireErrorEnvelope, WireItemWithMetadata, WirePage, WireType};

pub const PAGE_LIMIT: u32 = 200;

pub struct Http {
    agent: Agent,
    base: Url,
    /// Absent for a transport that carries no credential: the root document,
    /// the health door and the sign-in doors answer without one, and a
    /// device's transport always holds one.
    authorization: Option<String>,
}

pub struct ItemsQuery<'a> {
    pub r#type: &'a str,
    pub tier: Tier,
    pub cursor: Option<&'a str>,
}

/// What a call is, on the wire. A queued write is never a `Get`; the
/// direct surface's reads are.
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

/// One queued write, addressed.
pub struct Outgoing<'a> {
    pub method: Method,
    pub segments: Vec<String>,
    pub params: Vec<(String, String)>,
    pub body: &'a str,
    /// Minted when the row was queued and never changed
    /// (`queue-and-verdicts.md` 3), so a retry is answered from the server's
    /// record rather than written a second time.
    pub idempotency_key: &'a str,
}

/// What came back, kept whole and unclassified.
///
/// The status and the code both, because neither decides alone: three
/// different 409s take three different verdicts, and a 422 is a block or a
/// refusal depending on its code.
#[derive(Debug, Clone)]
pub struct Answer {
    pub status: u16,
    /// The server's error code, or empty on a success. Parsed out because
    /// the classification turns on it; the message beside it is not, because
    /// `body` already carries the envelope whole and a second copy of the
    /// same value is a second thing to keep in step.
    pub code: String,
    /// The response body verbatim. A device reports what it was told
    /// (`queue-and-verdicts.md` 15), so this is not parsed away.
    pub body: String,
    pub retry_after_seconds: Option<u64>,
    /// The server answered from its idempotency record rather than writing.
    pub replayed: bool,
}

impl Answer {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// What a call from the direct surface sends.
///
/// A body is JSON text, sized text under a type the headers name (a form),
/// or a reader the request streams from, because a blob upload must not
/// buffer the file: the cap on a blob is the server's to set and a binary
/// that read the whole file first would have a cap of its own that nothing
/// documents.
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
    /// Extra headers, such as a `Content-Type` for a streamed body or a
    /// `Last-Event-ID` for the stream.
    pub headers: &'a [(&'a str, &'a str)],
    pub body: CallBody<'a>,
    /// Whether the credential rides. A door that answers without one is
    /// called without one even when one is held, so a public read cannot be
    /// refused for a credential it never needed.
    pub credential: bool,
    /// Read the whole body as text (the JSON doors) or hand the reader back
    /// (the stream, an export, a blob's bytes).
    pub stream: bool,
}

/// What a call got back. **The only `Err` is a transport failure**: every
/// status the server can answer with is a `Reply`, because the direct
/// surface classifies on the status and the envelope together, exactly as
/// the drain does with an `Answer`.
pub struct Reply {
    pub status: u16,
    pub content_type: String,
    pub retry_after_seconds: Option<u64>,
    pub body: ReplyBody,
}

pub enum ReplyBody {
    Text(String),
    Stream(Box<dyn Read + Send>),
}

impl Http {
    pub fn new(url: &str, key: Option<&str>) -> Result<Http, CoreError> {
        let mut base = Url::parse(url)?;
        if base.cannot_be_a_base() {
            return Err(CoreError::Invalid(format!("not a server url: {url}")));
        }
        let path = base.path().trim_end_matches('/').to_string();
        base.set_path(&path);
        base.set_query(None);
        base.set_fragment(None);
        let agent: Agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_recv_response(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .build()
            .into();
        Ok(Http {
            agent,
            base,
            authorization: key.map(|key| format!("Bearer {key}")),
        })
    }

    /// Scheme, host, port and path prefix: what identifies a server without
    /// identifying a key.
    pub fn origin(&self) -> String {
        format!(
            "{}{}",
            self.base.origin().ascii_serialization(),
            self.base.path().trim_end_matches('/')
        )
    }

    pub fn types(&self) -> Result<Vec<WireType>, CoreError> {
        self.get_json(&["types"], &[])
    }

    pub fn items_page(
        &self,
        query: &ItemsQuery<'_>,
    ) -> Result<WirePage<WireItemWithMetadata>, CoreError> {
        let limit = PAGE_LIMIT.to_string();
        let mut params: Vec<(&str, &str)> = vec![
            ("type", query.r#type),
            ("tier", query.tier.as_str()),
            ("state", "any"),
            ("include", "edges,metadata"),
            ("limit", &limit),
        ];
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

    /// One item by id, as the server holds it now.
    ///
    /// The read a refused write is reconciled against
    /// (`queue-and-verdicts.md` 12): the working copy holds an edit the
    /// server declined, and nothing else brings it back, because a write the
    /// server refused changed nothing and so produced no event for catch-up
    /// to replay. `Ok(None)` is a 404, which is the server saying it holds
    /// no such row — for a refused create, the honest answer.
    pub fn item(&self, id: &str) -> Result<Option<WireItemWithMetadata>, CoreError> {
        match self.get_json::<WireItemWithMetadata>(&["items", id], &[("include", "metadata")]) {
            Ok(item) => Ok(Some(item)),
            Err(CoreError::NotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Sends one queued write and reads whatever came back.
    ///
    /// **The only `Err` is a transport failure**, and that is the whole point
    /// of this signature. Every status the server can answer with is an
    /// `Answer`, including the refusals, because the classification
    /// (`queue-and-verdicts.md` 17 to 23) turns on the status and the code
    /// together: a 409 is `ancestor_unavailable`, `version_conflict` or
    /// `idempotency_key_in_flight`, and those three take three different
    /// verdicts. `refusal()` below is the read path's convenience and is
    /// lossy about exactly that — it maps a status to a variant and drops
    /// the status — so the drain does not go through it.
    pub fn send(&self, outgoing: &Outgoing<'_>) -> Result<Answer, CoreError> {
        let segments: Vec<&str> = outgoing.segments.iter().map(String::as_str).collect();
        let params: Vec<(&str, &str)> = outgoing
            .params
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        let url = self.url(&segments, &params);
        // Built as one request and run, rather than through the agent's
        // per-method builders: those split at the type level on whether a
        // method carries a body, and the drain's four methods would then be
        // four copies of the same header list with one of them able to drift.
        let mut builder = ureq::http::Request::builder()
            .method(outgoing.method.as_str())
            .uri(url.as_str())
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Idempotency-Key", outgoing.idempotency_key);
        if let Some(authorization) = &self.authorization {
            builder = builder.header("Authorization", authorization);
        }
        let request = builder
            .body(outgoing.body)
            .map_err(|error| CoreError::Invalid(format!("this write cannot be sent: {error}")))?;
        let response = self
            .agent
            .run(request)
            .map_err(|error| CoreError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        let retry_after_seconds = retry_after(&response);
        let replayed = response
            .headers()
            .get("Idempotency-Replayed")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        // A body that will not read is a transport failure and not an
        // answer: the status arrived and the rest of the response did not,
        // so there is nothing here to classify.
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
        })
    }

    /// The raw event stream, left open for `body_timeout` at most.
    pub fn open_events(
        &self,
        last_event_id: Option<&str>,
        types: &[String],
        body_timeout: Duration,
    ) -> Result<Box<dyn Read + Send>, CoreError> {
        let joined = types.join(",");
        let mut params: Vec<(&str, &str)> = vec![("edges", "all")];
        if !types.is_empty() {
            params.push(("type", &joined));
        }
        let url = self.url(&["events"], &params);
        let mut request = self
            .agent
            .get(url.as_str())
            .header("Accept", "text/event-stream")
            .config()
            .timeout_recv_body(Some(body_timeout))
            .build();
        if let Some(authorization) = &self.authorization {
            request = request.header("Authorization", authorization);
        }
        if let Some(cursor) = last_event_id {
            request = request.header("Last-Event-ID", cursor);
        }
        let response = request
            .call()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let retry_after = retry_after(&response);
            let text = response.into_body().read_to_string().unwrap_or_default();
            return Err(refusal(status, &text, retry_after));
        }
        Ok(Box::new(response.into_body().into_reader()))
    }

    pub fn has_credential(&self) -> bool {
        self.authorization.is_some()
    }

    /// Sends one call from the direct surface and reads whatever came back.
    pub fn call(&self, call: Call<'_>) -> Result<Reply, CoreError> {
        let url = self.url(call.segments, call.params);
        let mut builder = ureq::http::Request::builder()
            .method(call.method.as_str())
            .uri(url.as_str())
            .header(
                "Accept",
                if call.stream {
                    "*/*"
                } else {
                    "application/json"
                },
            );
        if call.credential
            && let Some(authorization) = &self.authorization
        {
            builder = builder.header("Authorization", authorization);
        }
        if matches!(call.body, CallBody::Json(_)) {
            builder = builder.header("Content-Type", "application/json");
        }
        for (name, value) in call.headers {
            builder = builder.header(*name, *value);
        }
        let cannot_send = |error: ureq::http::Error| {
            CoreError::Invalid(format!("this call cannot be sent: {error}"))
        };
        // The agent's body budget is a minute, sized for a JSON answer. A
        // streamed body is the event stream, an export or a blob, none of
        // which has a length a budget could be sized for, so a streamed call
        // has none; `events --for` bounds its own reading.
        let response = match call.body {
            CallBody::None => {
                let request = builder.body(()).map_err(cannot_send)?;
                self.run_call(request, call.stream)
            }
            CallBody::Json(text) | CallBody::Text(text) => {
                let request = builder.body(text).map_err(cannot_send)?;
                self.run_call(request, call.stream)
            }
            CallBody::Reader(reader) => {
                let request = builder
                    .body(ureq::SendBody::from_owned_reader(reader))
                    .map_err(cannot_send)?;
                self.run_call(request, call.stream)
            }
        }
        .map_err(|error| CoreError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        let retry_after_seconds = retry_after(&response);
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        // A refusal is read whole even on a streaming call, so the envelope
        // reaches the classification; only a success is handed back as a
        // reader.
        let body = if call.stream && (200..300).contains(&status) {
            ReplyBody::Stream(Box::new(response.into_body().into_reader()))
        } else {
            ReplyBody::Text(
                response
                    .into_body()
                    .read_to_string()
                    .map_err(|error| CoreError::Network(error.to_string()))?,
            )
        };
        Ok(Reply {
            status,
            content_type,
            retry_after_seconds,
            body,
        })
    }

    fn run_call<B: ureq::AsSendBody>(
        &self,
        request: ureq::http::Request<B>,
        stream: bool,
    ) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        if stream {
            let request = self
                .agent
                .configure_request(request)
                .timeout_recv_body(None)
                .build();
            self.agent.run(request)
        } else {
            self.agent.run(request)
        }
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
        let mut request = self
            .agent
            .get(url.as_str())
            .header("Accept", "application/json");
        if let Some(authorization) = &self.authorization {
            request = request.header("Authorization", authorization);
        }
        let response = request
            .call()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        let status = response.status().as_u16();
        let retry_after = retry_after(&response);
        let text = response
            .into_body()
            .read_to_string()
            .map_err(|error| CoreError::Network(error.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(refusal(status, &text, retry_after));
        }
        serde_json::from_str(&text)
            .map_err(|error| CoreError::Decoding(format!("{}: {error}", url.path())))
    }
}

/// How long the server asked the caller to wait.
///
/// RFC 9110 allows a count of seconds or an HTTP-date, and a device that
/// read only the first would drop the instruction whenever a server chose
/// the second — which `DrainReport.retry_after_seconds` exists to stop. The
/// date form is read against the response's own `Date` header where it has
/// one, so a clock that disagrees with the server's does not turn a short
/// wait into a long one.
fn retry_after<B>(response: &ureq::http::Response<B>) -> Option<u64> {
    let raw = response.headers().get("Retry-After")?.to_str().ok()?.trim();
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(seconds);
    }
    let until = http_date(raw)?;
    let from = response
        .headers()
        .get("Date")
        .and_then(|value| value.to_str().ok())
        .and_then(http_date)
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_secs() as i64)
                .unwrap_or(0)
        });
    Some(until.saturating_sub(from).max(0) as u64)
}

/// An IMF-fixdate — `Sun, 06 Nov 1994 08:49:37 GMT` — as seconds since the
/// epoch. The one form RFC 9110 requires a sender to produce; the two
/// obsolete forms it allows a reader to accept are not parsed, and a header
/// this cannot read is treated as absent rather than as zero.
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
    // Howard Hinnant's algorithm, as `store::now_iso` uses in the other
    // direction.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

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
    fn origin_drops_the_key_the_query_and_a_trailing_slash() {
        let http = Http::new("HTTP://Localhost:8600/?x=1#f", Some("marfa_k1_secret")).unwrap();
        assert_eq!(http.origin(), "http://localhost:8600");
        let gateway = Http::new("https://gw.example/TenantA/", Some("k")).unwrap();
        assert_eq!(gateway.origin(), "https://gw.example/TenantA");
        assert_eq!(
            gateway
                .url(&["items", "a b"], &[("type", "core.note")])
                .as_str(),
            "https://gw.example/TenantA/items/a%20b?type=core.note"
        );
    }

    #[test]
    fn a_wait_is_read_in_either_form_the_standard_allows() {
        assert_eq!(
            http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777)
        );
        assert_eq!(http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
        // Not the fixdate form: read as absent rather than as no wait at
        // all, because a wait of zero is a device asking again at once.
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
