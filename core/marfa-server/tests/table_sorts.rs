//! Pages of a large table sorted by a column, read while its keys are registered and kept.

use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::db::Write;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

const ROWS: i64 = 20_000;

struct Instance {
    _dir: TempDir,
    app: Arc<App>,
    public: Router,
    control: Router,
    key: String,
    item: String,
}

async fn send(
    router: &Router,
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => builder
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string())),
        None => builder.body(Body::empty()),
    };
    let response = router.clone().oneshot(request.unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

impl Instance {
    /// A table of `ROWS` rows, each holding `score` as the integer `n % 100` and `n` in `rank`.
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_ALLOW_PRIVATE_ADDRESSES", "true"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            app,
            _dir: dir,
            key: String::new(),
            item: String::new(),
        };
        let grants = json!({
            "label": "writer",
            "source": "writer",
            "type_permissions": { "*": "write" },
        });
        let (status, minted) =
            send(&instance.control, None, Method::POST, "/keys", Some(grants)).await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        instance.key = minted["key"].as_str().unwrap().to_string();
        let lines = json!({ "columns": {
            "rank": { "type": "integer" },
            "score": { "type": "number" },
            "who": { "type": "item" },
        } });
        let definition = json!({
            "id": "user.scored",
            "fields": { "title": { "type": "string" } },
            "tables": { "lines": lines },
        });
        let (status, made) = send(
            &instance.control,
            None,
            Method::POST,
            "/types",
            Some(definition),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{made}");
        let made = instance
            .write(
                Method::POST,
                "/items",
                json!({ "type": "user.scored", "properties": { "title": "Scores" } }),
            )
            .await;
        instance.item = made["item"]["id"].as_str().unwrap().to_string();
        for start in (0..ROWS).step_by(1_000) {
            let operations: Vec<Value> = (start..start + 1_000)
                .map(|n| json!({ "op": "put", "values": { "rank": n, "score": n % 100 } }))
                .collect();
            instance.rows(operations).await;
        }
        instance
    }

    async fn write(&self, method: Method, path: &str, body: Value) -> Value {
        let (status, body) = send(&self.public, Some(&self.key), method, path, Some(body)).await;
        assert!(status.is_success(), "{path}: {body}");
        body
    }

    async fn rows(&self, operations: Vec<Value>) -> Value {
        let path = format!("/items/{}/tables/lines/rows", self.item);
        self.write(Method::POST, &path, json!({ "operations": operations }))
            .await
    }

    async fn page(&self, query: &str) -> (StatusCode, Value) {
        let path = format!("/items/{}/tables/lines/rows?{query}", self.item);
        send(&self.public, Some(&self.key), Method::GET, &path, None).await
    }

    /// Every row's id, walking the listing a page of 1,000 at a time.
    async fn walk(&self, query: &str) -> Vec<String> {
        self.walk_rows(query)
            .await
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    }

    async fn walk_rows(&self, query: &str) -> Vec<Value> {
        let mut seen = Vec::new();
        let mut cursor = String::new();
        loop {
            let (status, page) = self.page(&format!("{query}&limit=1000{cursor}")).await;
            assert_eq!(status, StatusCode::OK, "{page}");
            seen.extend(page["data"].as_array().unwrap().iter().cloned());
            match page["next_cursor"].as_str() {
                Some(next) => cursor = format!("&cursor={next}"),
                None => return seen,
            }
        }
    }

    async fn ready(&self) -> Option<bool> {
        self.app
            .db
            .read(|tx| {
                Ok(tx
                    .query_row(
                        "SELECT ready FROM table_sort_indexes WHERE name = 'score'",
                        [],
                        |row| row.get(0),
                    )
                    .ok())
            })
            .await
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_sorted_page_answers_while_the_writer_is_held_and_registers_after() {
    let instance = Instance::start().await;
    let (holding, held) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let writer = {
        let app = instance.app.clone();
        tokio::spawn(async move {
            app.db
                .write(Write::own(), move |_| {
                    holding.send(()).unwrap();
                    released.recv().ok();
                    Ok(())
                })
                .await
        })
    };
    tokio::task::spawn_blocking(move || held.recv())
        .await
        .unwrap()
        .unwrap();

    let read = tokio::time::timeout(
        Duration::from_secs(2),
        instance.page("sort=values.score&limit=5"),
    )
    .await;
    let (status, page) = read.expect("the page waited for the held writer");
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["data"].as_array().unwrap().len(), 5);
    assert_eq!(instance.ready().await, None);

    release.send(()).unwrap();
    writer.await.unwrap().unwrap();
    for _ in 0..200 {
        if instance.ready().await.is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the sort was never registered");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_patch_to_a_kept_number_that_sqlite_holds_equal_commits_and_sorts_right() {
    let instance = Instance::start().await;
    let (status, page) = instance.page("sort=values.score&limit=1").await;
    assert_eq!(status, StatusCode::OK, "{page}");
    for _ in 0..200 {
        let path = "/housekeeping/table-row-cleanup/run";
        let (status, ran) = send(&instance.control, None, Method::POST, path, None).await;
        assert_eq!(status, StatusCode::OK, "{ran}");
        if instance.ready().await == Some(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(instance.ready().await, Some(true));

    let rows = instance.walk_rows("sort=id").await;
    let ids: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect();
    let mut scores: Vec<f64> = rows
        .iter()
        .map(|row| row["values"]["score"].as_f64().unwrap())
        .collect();
    let at = |score: f64| scores.iter().position(|held| *held == score).unwrap();
    let (one, two) = (at(1.0), at(2.0));
    scores[two] = 0.5;
    let (one, two) = (&ids[one], &ids[two]);
    instance
        .rows(vec![
            json!({ "op": "patch", "id": one, "values": { "score": 1.0, "rank": -1 } }),
            json!({ "op": "patch", "id": two, "values": { "score": 0.5, "rank": -2 } }),
        ])
        .await;
    let (_, row) = send(
        &instance.public,
        Some(&instance.key),
        Method::GET,
        &format!("/items/{}/tables/lines/rows/{one}", instance.item),
        None,
    )
    .await;
    assert_eq!(row["values"]["rank"], -1, "{row}");

    let mut expected: Vec<(f64, &String)> = scores.into_iter().zip(&ids).collect();
    expected.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(b.1)));
    let ascending: Vec<String> = expected.iter().map(|(_, id)| (*id).clone()).collect();
    assert_eq!(instance.walk("sort=values.score").await, ascending);
    expected.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(b.1)));
    let descending: Vec<String> = expected.iter().map(|(_, id)| (*id).clone()).collect();
    assert_eq!(
        instance.walk("sort=values.score&direction=desc").await,
        descending
    );

    for direction in ["asc", "desc"] {
        let by_item = instance
            .walk(&format!("sort=values.who&direction={direction}"))
            .await;
        assert_eq!(by_item, ids, "{direction}");
    }
}
