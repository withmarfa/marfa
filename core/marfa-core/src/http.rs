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
    authorization: String,
}

pub struct ItemsQuery<'a> {
    pub r#type: &'a str,
    pub tier: Tier,
    pub cursor: Option<&'a str>,
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
            authorization: format!("Bearer {key}"),
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
            .header("Authorization", &self.authorization)
            .header("Accept", "text/event-stream")
            .config()
            .timeout_recv_body(Some(body_timeout))
            .build();
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
        let response = self
            .agent
            .get(url.as_str())
            .header("Authorization", &self.authorization)
            .header("Accept", "application/json")
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

fn retry_after<B>(response: &ureq::http::Response<B>) -> Option<u64> {
    response
        .headers()
        .get("Retry-After")?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()
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
