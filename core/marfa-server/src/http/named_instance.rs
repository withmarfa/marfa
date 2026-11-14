//! `X-Marfa-Instance-Id`: a write that names another instance is refused where it lands.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::Response;
use marfa_rules::validation;

use super::admission::{Admission, on_socket};
use super::answer::refusal_answer;
use super::caller::identify;
use crate::app::App;
use crate::app::refusal::{Code, Refusal};

const HEADER: &str = "x-marfa-instance-id";

pub(super) fn is_write(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// The instance a request names, `None` when it names none.
fn named(headers: &HeaderMap) -> Result<Option<&str>, Refusal> {
    let mut values = headers.get_all(HEADER).iter();
    match (values.next(), values.next()) {
        (None, _) => Ok(None),
        (Some(value), None) => match value.to_str() {
            Ok(text) if validation::id("instance", text).is_ok() => Ok(Some(text)),
            _ => Err(malformed()),
        },
        (Some(_), Some(_)) => Err(malformed()),
    }
}

fn malformed() -> Refusal {
    Refusal::validation("X-Marfa-Instance-Id must be one lowercase UUIDv7.")
}

/// Refuses a write that names an instance other than this one, or names it badly.
pub(super) fn judge(app: &App, headers: &HeaderMap) -> Result<(), Refusal> {
    match named(headers)? {
        Some(id) if id != app.instance_id => Err(Refusal::new(
            Code::InstanceChanged,
            "X-Marfa-Instance-Id names another instance. Nothing was written.",
        )),
        _ => Ok(()),
    }
}

#[derive(Clone)]
pub struct Judging {
    pub app: Arc<App>,
    pub writes: Arc<HashMap<&'static str, Vec<(Method, Admission)>>>,
}

/// A door that takes no credential judges the header itself.
pub async fn judged(State(judging): State<Judging>, request: Request, next: Next) -> Response {
    let rule = request
        .extensions()
        .get::<MatchedPath>()
        .and_then(|path| judging.writes.get(path.as_str()))
        .and_then(|doors| doors.iter().find(|(method, _)| method == request.method()))
        .map(|(_, rule)| *rule);
    let Some(rule) = rule else {
        return next.run(request).await;
    };
    let (mut parts, body) = request.into_parts();
    if let Ok(Some(caller)) = identify(&mut parts, &judging.app).await
        && rule.admits(Some(&caller), &parts.headers, on_socket(&parts.extensions))
        && let Err(refusal) = judge(&judging.app, &parts.headers)
    {
        return refusal_answer(&refusal);
    }
    next.run(Request::from_parts(parts, body)).await
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use axum::Router;
    use axum::body::{Body, to_bytes};
    use axum::http::{HeaderValue, StatusCode, header};
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;
    use crate::http::doors::Doors;
    use crate::http::test_instance::{Instance, start};
    use crate::http::{control_doors, oauth, public_doors};

    const OTHER: &str = "019537a0-7b80-7000-8000-0000000000ff";
    /// Doors in `shared` that take no credential.
    const OPEN: [&str; 1] = ["POST /owner"];

    impl Instance {
        async fn send(&self, route: &str, key: bool, named: &[&str]) -> (StatusCode, String) {
            self.send_on(&self.public, route, key, named).await
        }

        async fn send_on(
            &self,
            router: &Router,
            route: &str,
            key: bool,
            named: &[&str],
        ) -> (StatusCode, String) {
            let (method, path) = route.split_once(' ').unwrap();
            let mut at = path.to_owned();
            while let Some(open) = at.find('{') {
                let close = at[open..].find('}').unwrap() + open;
                at.replace_range(open..=close, OTHER);
            }
            let mut request = Request::builder()
                .method(method)
                .uri(at)
                .header(header::CONTENT_TYPE, "application/json");
            if key {
                request = request.header(header::AUTHORIZATION, format!("Bearer {}", self.key));
            }
            for value in named {
                request = request.header(HEADER, *value);
            }
            let answer = router
                .clone()
                .oneshot(request.body(Body::from("{}")).unwrap())
                .await
                .unwrap();
            let status = answer.status();
            let bytes = to_bytes(answer.into_body(), usize::MAX).await.unwrap();
            let code = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|body| body["error"]["code"].as_str().map(str::to_owned))
                .unwrap_or_default();
            (status, code)
        }
    }

    fn writes(doors: &crate::http::doors::Doors) -> BTreeSet<String> {
        doors
            .served()
            .into_iter()
            .filter(|door| is_write(&door.method))
            .map(|door| format!("{} {}", door.method, door.path))
            .collect()
    }

    /// A listener's write doors, split into those judged and those not.
    fn split(doors: &Doors) -> (BTreeSet<String>, BTreeSet<String>) {
        let judged = doors.judged_writes();
        writes(doors).into_iter().partition(|route| {
            let (method, path) = route.split_once(' ').unwrap();
            judged
                .get(path)
                .is_some_and(|doors| doors.iter().any(|(served, _)| served.as_str() == method))
        })
    }

    #[test]
    fn a_header_is_one_lowercase_uuid_v7_or_it_is_refused() {
        let with = |values: &[&str]| {
            let mut headers = HeaderMap::new();
            for value in values {
                headers.append(HEADER, HeaderValue::from_str(value).unwrap());
            }
            named(&headers).map(|id| id.map(str::to_owned))
        };
        assert_eq!(with(&[]).unwrap(), None);
        assert_eq!(with(&[OTHER]).unwrap().as_deref(), Some(OTHER));
        let v4 = "3f8d9c1e-7a2b-4c5d-8e6f-0123456789ab";
        let upper = OTHER.to_uppercase();
        let list = format!("{OTHER}, {OTHER}");
        for refused in [
            vec![""],
            vec![v4],
            vec![upper.as_str()],
            vec![list.as_str()],
            vec![OTHER, OTHER],
            vec!["not-an-instance"],
        ] {
            assert!(with(&refused).is_err(), "{refused:?}");
        }
    }

    #[tokio::test]
    async fn every_write_door_but_the_exempt_groups_refuses_another_instance() {
        let instance = start().await;
        let (covered, _) = split(&public_doors(instance.app.clone()));
        assert!(
            covered.len() > 40,
            "the witness: the walk found {covered:?}"
        );
        let mut missed = Vec::new();
        for route in &covered {
            let (status, code) = instance.send(route, true, &[OTHER]).await;
            if (status, code.as_str()) != (StatusCode::CONFLICT, "instance_changed") {
                missed.push(format!("{route} answered {status} {code}"));
            }
        }
        assert_eq!(missed, Vec::<String>::new());
        let (status, _) = instance.send("POST /keys", true, &[]).await;
        assert_ne!(status, StatusCode::CONFLICT, "the witness: naming none");
    }

    #[tokio::test]
    async fn the_private_socket_refuses_another_instance_at_every_write_door_but_the_grant_doors() {
        let instance = start().await;
        let (covered, exempt) = split(&control_doors(&instance.app));
        assert!(covered.len() > 40, "the witness: {covered:?}");
        assert_eq!(exempt, writes(&oauth::grant_doors()));
        let mut missed = Vec::new();
        for route in &covered {
            let (status, code) = instance
                .send_on(&instance.control, route, true, &[OTHER])
                .await;
            if (status, code.as_str()) != (StatusCode::CONFLICT, "instance_changed") {
                missed.push(format!("{route} answered {status} {code}"));
            }
        }
        assert_eq!(missed, Vec::<String>::new());
    }

    #[tokio::test]
    async fn the_exempt_groups_are_the_sign_in_grant_oauth_and_sender_doors_and_judge_no_header() {
        let instance = start().await;
        let (_, exempt) = split(&public_doors(instance.app.clone()));
        let groups = writes(&oauth::grant_doors())
            .into_iter()
            .chain(writes(&crate::http::auth::doors()))
            .chain(writes(&oauth::doors()))
            .chain(writes(&crate::http::sender_doors()))
            // Served only to answer 405, so the method is refused before any header.
            .chain(["/mcp", "/mcp/schema", "/mcp/admin"].map(|path| format!("DELETE {path}")))
            .collect::<BTreeSet<_>>();
        assert!(groups.len() > 5, "the witness: {groups:?}");
        assert_eq!(exempt, groups);
        for route in &exempt {
            let (_, code) = instance.send(route, true, &[OTHER]).await;
            assert_ne!(code, "instance_changed", "{route}");
        }
    }

    #[tokio::test]
    async fn a_write_with_no_credential_is_unauthorized_before_its_header_is_judged() {
        let instance = start().await;
        let mut open = Vec::new();
        let (covered, _) = split(&public_doors(instance.app.clone()));
        for route in covered {
            let (status, _) = instance.send(&route, false, &[OTHER]).await;
            if status != StatusCode::UNAUTHORIZED {
                open.push(route);
            }
        }
        assert_eq!(
            open, OPEN,
            "a door that takes no credential judges the header itself"
        );
        for route in OPEN {
            let (status, code) = instance.send(route, false, &[OTHER]).await;
            assert_eq!(
                (status, code.as_str()),
                (StatusCode::CONFLICT, "instance_changed")
            );
            let (status, code) = instance.send(route, false, &["x"]).await;
            assert_eq!(
                (status, code.as_str()),
                (StatusCode::BAD_REQUEST, "validation_error")
            );
        }
    }
}
