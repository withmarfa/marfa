//! `X-Marfa-Instance-Id`: a write that names another instance is refused where it lands.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{MatchedPath, Request, State};
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::Response;
use marfa_rules::validation;

use super::answer::refusal_answer;
use super::caller::identify;
use super::observe::RequestContext;
use crate::app::App;
use crate::app::refusal::{Code, Refusal};
use crate::listener::Transport;

const HEADER: &str = "x-marfa-instance-id";

fn is_write(method: &Method) -> bool {
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

/// What the layer reads: the instance, and the paths whose callers hold no copy of it.
#[derive(Clone)]
pub struct Judging {
    pub app: Arc<App>,
    pub unjudged: Arc<HashSet<&'static str>>,
}

/// Judged once a credential has been found and before the write's own refusals, a body too
/// deep to read among them. A request with no credential that verifies goes on to its door,
/// which answers `401`; a door that takes none judges the header itself. The local command
/// holds no copy and is not judged.
pub async fn judged(State(judging): State<Judging>, request: Request, next: Next) -> Response {
    let on_socket = request
        .extensions()
        .get::<RequestContext>()
        .is_some_and(|context| context.transport == Transport::LocalSocket);
    let exempt = request
        .extensions()
        .get::<MatchedPath>()
        .is_some_and(|path| judging.unjudged.contains(path.as_str()));
    if !is_write(request.method()) || on_socket || exempt {
        return next.run(request).await;
    }
    let (mut parts, body) = request.into_parts();
    if matches!(identify(&mut parts, &judging.app).await, Ok(Some(_)))
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
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use super::*;
    use crate::http::{control, oauth, public, public_doors};
    use crate::settings::{Environment, Settings};

    const OTHER: &str = "019537a0-7b80-7000-8000-0000000000ff";
    /// Doors in `shared` that take no credential.
    const OPEN: [&str; 1] = ["POST /owner"];

    struct Instance {
        _dir: TempDir,
        app: Arc<App>,
        public: Router,
        key: String,
    }

    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let (database, blobs) = (dir.path().join("marfa.db"), dir.path().join("blobs"));
        let socket = dir.path().join("s.sock");
        let settings = Settings::read(Environment::from_pairs(&[
            ("SQLITE_PATH", database.to_str().unwrap()),
            ("BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("RATE_LIMIT_ENABLED", "false"),
        ]))
        .unwrap();
        let app = App::start(settings).await.unwrap();
        let minted = control(app.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/keys")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"label": "bare", "source": "bare", "permissions": []}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = to_bytes(minted.into_body(), usize::MAX).await.unwrap();
        let key = serde_json::from_slice::<Value>(&bytes).unwrap()["key"]
            .as_str()
            .unwrap()
            .to_owned();
        Instance {
            _dir: dir,
            public: public(app.clone()),
            app,
            key,
        }
    }

    impl Instance {
        async fn send(&self, route: &str, key: bool, named: &[&str]) -> (StatusCode, String) {
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
            let answer = self
                .public
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

    /// The public listener's write doors, split into those judged and those not.
    fn split(app: &Arc<App>) -> (BTreeSet<String>, BTreeSet<String>) {
        let doors = public_doors(app.clone());
        let unjudged = doors.unjudged_paths();
        writes(&doors).into_iter().partition(|route| {
            !unjudged.contains(route.split_once(' ').map_or("", |(_, path)| path))
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
        let (covered, _) = split(&instance.app);
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
    async fn the_exempt_groups_are_the_sign_in_grant_and_oauth_doors_and_judge_no_header() {
        let instance = start().await;
        let (_, exempt) = split(&instance.app);
        let groups = writes(&oauth::grant_doors())
            .into_iter()
            .chain(writes(&crate::http::auth::doors()))
            .chain(writes(&oauth::doors()))
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
        let (covered, _) = split(&instance.app);
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
