//! A JSON answer to a `GET` that carries `Authorization` is gzipped when the request accepts it.

use axum::Router;
use axum::extract::Request;
use axum::http::{Method, Response, header};
use axum::middleware::{Next, from_fn};
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::Predicate;

#[derive(Clone, Copy)]
struct Credentialed;

#[derive(Clone, Copy)]
struct CredentialedJson;

fn is_json(content_type: &str) -> bool {
    let media = content_type.split(';').next().unwrap_or("").trim();
    media.eq_ignore_ascii_case("application/json")
        || media
            .rsplit_once('+')
            .is_some_and(|(_, suffix)| suffix.eq_ignore_ascii_case("json"))
}

impl Predicate for CredentialedJson {
    fn should_compress<B>(&self, response: &Response<B>) -> bool
    where
        B: http_body::Body,
    {
        response.extensions().get::<Credentialed>().is_some()
            && response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(is_json)
    }
}

async fn mark_credentialed(request: Request, next: Next) -> axum::response::Response {
    let credentialed =
        request.method() == Method::GET && request.headers().contains_key(header::AUTHORIZATION);
    let mut response = next.run(request).await;
    if credentialed {
        response.extensions_mut().insert(Credentialed);
    }
    response
}

/// Outside every other layer, so it compresses the answer a client receives.
pub fn gzip_json(router: Router) -> Router {
    router.layer(from_fn(mark_credentialed)).layer(
        CompressionLayer::new()
            .no_br()
            .no_deflate()
            .no_zstd()
            .compress_when(CredentialedJson),
    )
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use axum::Router;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode, header};
    use axum::response::Response;
    use axum::routing::get;
    use flate2::read::GzDecoder;
    use http_body_util::BodyExt;
    use serde_json::json;
    use tower::ServiceExt;

    use super::gzip_json;
    use crate::app::refusal::{Code, Refusal};
    use crate::http::answer::{json_answer, refusal_answer};

    fn router() -> Router {
        gzip_json(
            Router::new()
                .route(
                    "/page",
                    get(|| async { json_answer(StatusCode::OK, &json!({"a": 1})) }),
                )
                .route(
                    "/refused",
                    get(|| async { refusal_answer(&Refusal::new(Code::NotFound, "Not found")) }),
                )
                .route(
                    "/events",
                    get(|| async {
                        let mut response = Response::new(Body::from("data: x\n\n"));
                        response
                            .headers_mut()
                            .insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
                        response
                    }),
                ),
        )
    }

    async fn ask(method: Method, path: &str, authorization: bool, accepts: &str) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if authorization {
            request = request.header(header::AUTHORIZATION, "Bearer k");
        }
        if !accepts.is_empty() {
            request = request.header(header::ACCEPT_ENCODING, accepts);
        }
        router()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    fn encoding(response: &Response) -> Option<&str> {
        response
            .headers()
            .get(header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
    }

    #[tokio::test]
    async fn gzips_json_for_a_credential_that_accepts_gzip() {
        let response = ask(Method::GET, "/page", true, "gzip").await;
        assert_eq!(encoding(&response), Some("gzip"));
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let mut text = String::new();
        GzDecoder::new(&bytes[..])
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, r#"{"a":1}"#);
    }

    #[tokio::test]
    async fn gzips_a_refusal() {
        let response = ask(Method::GET, "/refused", true, "gzip").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(encoding(&response), Some("gzip"));
    }

    #[tokio::test]
    async fn leaves_a_request_without_a_credential_alone() {
        let response = ask(Method::GET, "/page", false, "gzip").await;
        assert_eq!(encoding(&response), None);
        let response = ask(Method::GET, "/refused", false, "gzip").await;
        assert_eq!(encoding(&response), None);
    }

    #[tokio::test]
    async fn leaves_a_request_that_does_not_accept_gzip_alone() {
        let response = ask(Method::GET, "/page", true, "").await;
        assert_eq!(encoding(&response), None);
        let response = ask(Method::GET, "/page", true, "identity").await;
        assert_eq!(encoding(&response), None);
    }

    #[tokio::test]
    async fn never_compresses_an_event_stream() {
        let response = ask(Method::GET, "/events", true, "gzip").await;
        assert_eq!(encoding(&response), None);
    }

    #[tokio::test]
    async fn compresses_only_a_get() {
        let response = ask(Method::HEAD, "/page", true, "gzip").await;
        assert_eq!(encoding(&response), None);
    }
}
