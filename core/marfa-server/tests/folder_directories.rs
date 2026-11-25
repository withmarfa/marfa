//! `GET /folders/{id}/directories` counts a folder's placed files by directory, from its `in-folder` edges.

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use marfa_server::app::App;
use marfa_server::http::{control, public};
use marfa_server::settings::{Environment, Settings};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _dir: TempDir,
    public: Router,
    control: Router,
    owner: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn refused(&self, status: StatusCode, code: &str) {
        assert_eq!((self.status, self.code()), (status, code), "{}", self.text);
    }

    fn ok(&self) -> &Value {
        assert_eq!(self.status, StatusCode::OK, "{}", self.text);
        &self.body
    }

    /// Each directory as `(path, direct_files, all_files, has_directories)`.
    fn directories(&self) -> Vec<(String, i64, i64, bool)> {
        self.ok()["directories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["path"].as_str().unwrap().to_string(),
                    entry["direct_files"].as_i64().unwrap(),
                    entry["all_files"].as_i64().unwrap(),
                    entry["has_directories"].as_bool().unwrap(),
                )
            })
            .collect()
    }

    fn numbers(&self) -> (i64, i64) {
        let body = self.ok();
        (
            body["direct_files"].as_i64().unwrap(),
            body["total_files"].as_i64().unwrap(),
        )
    }
}

async fn send(
    router: &Router,
    token: Option<&str>,
    method: Method,
    path: &str,
    body: Value,
) -> Reply {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let request = builder
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Reply {
        status,
        body: serde_json::from_str(&text).unwrap_or(Value::Null),
        text,
    }
}

impl Instance {
    async fn start() -> Instance {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = vec![
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_RATE_LIMIT_ENABLED", "false"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        let app = App::start(settings).await.unwrap();
        let mut instance = Instance {
            public: public(app.clone()),
            control: control(app.clone()),
            _dir: dir,
            owner: String::new(),
        };
        instance.owner = instance
            .mint("owner", "owner", json!({ "*": "write" }), None)
            .await;
        instance
    }

    async fn mint(&self, label: &str, source: &str, types: Value, filter: Option<Value>) -> String {
        let mut body = json!({
            "label": label,
            "source": source,
            "permissions": [],
            "type_permissions": types,
            "edge_permissions": { "*": "write" },
        });
        if let Some(filter) = filter {
            body["enforcement_override"] = json!({ "source_filter": filter });
        }
        let minted = send(&self.control, None, Method::POST, "/keys", body).await;
        assert_eq!(minted.status, StatusCode::CREATED, "{}", minted.text);
        minted.body["key"].as_str().unwrap().to_string()
    }

    async fn call(&self, token: &str, method: Method, path: &str, body: Value) -> Reply {
        send(&self.public, Some(token), method, path, body).await
    }

    async fn owner_call(&self, method: Method, path: &str, body: Value) -> Reply {
        self.call(&self.owner, method, path, body).await
    }

    async fn folder(&self) -> String {
        let made = self
            .owner_call(Method::POST, "/folders", json!({ "title": "Tree" }))
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }

    async fn item(&self, token: &str, type_id: &str) -> String {
        let made = self
            .call(
                token,
                Method::POST,
                "/items",
                json!({ "type": type_id, "properties": { "body": "placed", "title": "placed" } }),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
        made.body["item"]["id"].as_str().unwrap().to_string()
    }

    async fn place_item(&self, item: &str, folder: &str, path: &str) {
        let made = self
            .owner_call(
                Method::POST,
                "/edges",
                json!({
                    "from_id": item,
                    "to_id": folder,
                    "edge_type": "in-folder",
                    "properties": { "path": path },
                }),
            )
            .await;
        assert_eq!(made.status, StatusCode::CREATED, "{}", made.text);
    }

    async fn place(&self, folder: &str, path: &str) -> String {
        let item = self.item(&self.owner, "core.note").await;
        self.place_item(&item, folder, path).await;
        item
    }

    async fn places(&self, folder: &str, paths: &[&str]) {
        for path in paths {
            self.place(folder, path).await;
        }
    }

    async fn transition(&self, item: &str, state: &str) {
        let moved = self
            .owner_call(
                Method::POST,
                &format!("/items/{item}/transition"),
                json!({ "state": state }),
            )
            .await;
        assert_eq!(moved.status, StatusCode::OK, "{}", moved.text);
    }

    async fn tree(&self, folder: &str, query: &str) -> Reply {
        self.owner_call(
            Method::GET,
            &format!("/folders/{folder}/directories{query}"),
            Value::Null,
        )
        .await
    }
}

fn row(path: &str, direct: i64, all: i64, more: bool) -> (String, i64, i64, bool) {
    (path.to_string(), direct, all, more)
}

const SAMPLE: [&str; 8] = [
    "readme.md",
    "notes/one.md",
    "notes/two.md",
    "notes/2026/jan.md",
    "notes/2026/feb/a.md",
    "notes/2026/feb/b.md",
    "projects/plan.md",
    "projects/archive/old/deep/x.md",
];

#[tokio::test]
async fn the_top_level_lists_each_directory_with_its_files_and_the_total() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;

    let top = instance.tree(&folder, "").await;
    assert_eq!(
        top.directories(),
        vec![row("notes", 2, 5, true), row("projects", 1, 2, true)]
    );
    assert_eq!(top.numbers(), (1, 8));
    assert_eq!(top.ok()["folder_id"], folder.as_str());
    assert_eq!(top.ok()["under"], "");
}

#[tokio::test]
async fn under_lists_the_children_of_one_directory_and_its_own_files() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;

    let notes = instance.tree(&folder, "?under=notes").await;
    assert_eq!(notes.directories(), vec![row("notes/2026", 1, 3, true)]);
    assert_eq!(notes.numbers(), (2, 8));
    assert_eq!(notes.ok()["under"], "notes");

    let year = instance.tree(&folder, "?under=notes/2026").await;
    assert_eq!(year.directories(), vec![row("notes/2026/feb", 2, 2, false)]);
    assert_eq!(year.numbers(), (1, 8));

    let leaf = instance.tree(&folder, "?under=notes/2026/feb").await;
    assert_eq!(leaf.directories(), vec![]);
    assert_eq!(leaf.numbers(), (2, 8));

    let projects = instance.tree(&folder, "?under=projects").await;
    assert_eq!(
        projects.directories(),
        vec![row("projects/archive", 0, 1, true)]
    );
    assert_eq!(projects.numbers(), (1, 8));
}

#[tokio::test]
async fn an_empty_folder_answers_zeros_and_no_directories() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let empty = instance.tree(&folder, "").await;
    assert_eq!(empty.directories(), vec![]);
    assert_eq!(empty.numbers(), (0, 0));
}

#[tokio::test]
async fn directories_come_in_byte_order_of_their_paths() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance
        .places(&folder, &["b/x.md", "B/x.md", "a/x.md", "_/x.md", "é/x.md"])
        .await;
    let paths: Vec<String> = instance
        .tree(&folder, "")
        .await
        .directories()
        .into_iter()
        .map(|(path, ..)| path)
        .collect();
    assert_eq!(paths, ["B", "_", "a", "b", "é"]);
}

#[tokio::test]
async fn only_this_folders_in_folder_edges_count() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let other = instance.folder().await;
    instance.places(&folder, &["a/one.md"]).await;
    instance
        .places(&other, &["a/two.md", "a/three.md", "z/four.md"])
        .await;
    let note = instance.item(&instance.owner, "core.note").await;
    let linked = instance
        .owner_call(
            Method::POST,
            "/edges",
            json!({ "from_id": note, "to_id": folder, "edge_type": "references" }),
        )
        .await;
    assert!(linked.status.is_success(), "{}", linked.text);

    let mine = instance.tree(&folder, "").await;
    assert_eq!(mine.directories(), vec![row("a", 1, 1, false)]);
    assert_eq!(mine.numbers(), (0, 1));
    let theirs = instance.tree(&other, "").await;
    assert_eq!(
        theirs.directories(),
        vec![row("a", 2, 2, false), row("z", 1, 1, false)]
    );
    assert_eq!(theirs.numbers(), (0, 3));
}

#[tokio::test]
async fn an_item_in_two_folders_counts_in_each() {
    let instance = Instance::start().await;
    let first = instance.folder().await;
    let second = instance.folder().await;
    let item = instance.place(&first, "docs/shared.md").await;
    instance
        .place_item(&item, &second, "elsewhere/shared.md")
        .await;
    assert_eq!(
        instance.tree(&first, "").await.directories(),
        vec![row("docs", 1, 1, false)]
    );
    assert_eq!(
        instance.tree(&second, "").await.directories(),
        vec![row("elsewhere", 1, 1, false)]
    );
}

#[tokio::test]
async fn under_is_tidied_the_way_a_placement_path_is_read() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    let plain = instance.tree(&folder, "?under=notes").await.ok().clone();
    for spelling in [
        "notes/",
        "notes//",
        "./notes",
        "notes/.",
        "notes/./",
        "%2E/notes",
        "notes%2F",
    ] {
        let read = instance.tree(&folder, &format!("?under={spelling}")).await;
        assert_eq!(read.ok(), &plain, "{spelling}");
    }
    let nested = instance.tree(&folder, "?under=notes%2F2026").await;
    assert_eq!(nested.ok()["under"], "notes/2026");
    let doubled = instance.tree(&folder, "?under=notes//2026//").await;
    assert_eq!(doubled.ok()["under"], "notes/2026");

    let top = instance.tree(&folder, "").await.ok().clone();
    for spelling in ["", ".", "./", "./."] {
        let read = instance.tree(&folder, &format!("?under={spelling}")).await;
        assert_eq!(read.ok(), &top, "{spelling:?}");
    }
}

#[tokio::test]
async fn under_that_leaves_the_folder_or_is_not_a_path_is_refused() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    let long = "a".repeat(1025);
    let spellings = [
        "..".to_string(),
        "notes/..".to_string(),
        "../notes".to_string(),
        "notes/../projects".to_string(),
        "%2E%2E".to_string(),
        "/notes".to_string(),
        "%2Fnotes".to_string(),
        "/".to_string(),
        "//".to_string(),
        "C:/notes".to_string(),
        "c:".to_string(),
        "notes%5Cone".to_string(),
        "notes%00".to_string(),
        long,
    ];
    for spelling in spellings {
        let read = instance.tree(&folder, &format!("?under={spelling}")).await;
        read.refused(StatusCode::BAD_REQUEST, "validation_error");
        assert_eq!(
            read.body["error"]["details"]["field"], "under",
            "{spelling}"
        );
    }
    let longest = "a".repeat(1024);
    instance
        .tree(&folder, &format!("?under={longest}"))
        .await
        .ok();
}

#[tokio::test]
async fn under_named_twice_or_another_parameter_is_refused() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance
        .tree(&folder, "?under=a&under=b")
        .await
        .refused(StatusCode::BAD_REQUEST, "validation_error");
    instance
        .tree(&folder, "?path=a")
        .await
        .refused(StatusCode::BAD_REQUEST, "validation_error");
    instance
        .tree(&folder, "?limit=5")
        .await
        .refused(StatusCode::BAD_REQUEST, "validation_error");
}

#[tokio::test]
async fn a_path_the_folder_holds_no_file_under_answers_empty() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    for missing in [
        "nothing",
        "notes/2025",
        "notes/one.md",
        "readme.md",
        "Notes",
        "note",
    ] {
        let read = instance.tree(&folder, &format!("?under={missing}")).await;
        assert_eq!(read.directories(), vec![], "{missing}");
        assert_eq!(read.numbers(), (0, 8), "{missing}");
        assert_eq!(read.ok()["under"], missing);
    }
}

#[tokio::test]
async fn a_name_is_matched_as_stored_so_unicode_forms_stay_apart() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let composed = "caf\u{e9}";
    let decomposed = "cafe\u{301}";
    instance
        .places(
            &folder,
            &[
                &format!("{composed}/a.md"),
                &format!("{composed}/b.md"),
                &format!("{decomposed}/c.md"),
                "Cafe/d.md",
            ],
        )
        .await;
    let top = instance.tree(&folder, "").await.directories();
    assert_eq!(
        top,
        vec![
            row("Cafe", 1, 1, false),
            row(decomposed, 1, 1, false),
            row(composed, 2, 2, false),
        ]
    );
    let nfc = instance.tree(&folder, "?under=caf%C3%A9").await;
    assert_eq!(nfc.numbers(), (2, 4));
    assert_eq!(nfc.ok()["under"], composed);
    let nfd = instance.tree(&folder, "?under=cafe%CC%81").await;
    assert_eq!(nfd.numbers(), (1, 4));
    assert_eq!(nfd.ok()["under"], decomposed);
    let folded = instance.tree(&folder, "?under=cafe").await;
    assert_eq!(folded.numbers(), (0, 4));
}

#[tokio::test]
async fn a_stored_path_with_empty_or_dot_names_counts_where_a_device_places_it() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance
        .places(
            &folder,
            &[
                "a//b.md",
                "./c.md",
                "a/./b/x.md",
                "d/",
                "e/f/",
                "g/.//h//i.md",
                "a/tidy.md",
                "a/b/y.md",
            ],
        )
        .await;
    let top = instance.tree(&folder, "").await;
    assert_eq!(
        top.directories(),
        vec![
            row("a", 2, 4, true),
            row("e", 1, 1, false),
            row("g", 0, 1, true),
        ]
    );
    assert_eq!(top.numbers(), (2, 8));

    let under_a = instance.tree(&folder, "?under=a").await;
    assert_eq!(under_a.directories(), vec![row("a/b", 2, 2, false)]);
    assert_eq!(under_a.numbers(), (2, 8));

    let under_g = instance.tree(&folder, "?under=g").await;
    assert_eq!(under_g.directories(), vec![row("g/h", 1, 1, false)]);
    assert_eq!(under_g.numbers(), (0, 8));
}

#[tokio::test]
async fn an_archived_item_counts_and_an_item_in_the_bin_does_not() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.place(&folder, "docs/kept.md").await;
    let archived = instance.place(&folder, "docs/archived.md").await;
    let binned = instance.place(&folder, "docs/binned.md").await;
    let top_binned = instance.place(&folder, "binned-top.md").await;
    instance.place(&folder, "docs/sub/active.md").await;
    instance.transition(&archived, "archived").await;
    instance.transition(&binned, "trashed").await;
    instance.transition(&top_binned, "trashed").await;

    let read = instance.tree(&folder, "").await;
    assert_eq!(read.directories(), vec![row("docs", 2, 3, true)]);
    assert_eq!(read.numbers(), (0, 3));

    instance.transition(&binned, "active").await;
    instance.transition(&top_binned, "active").await;
    let restored = instance.tree(&folder, "").await;
    assert_eq!(restored.directories(), vec![row("docs", 3, 4, true)]);
    assert_eq!(restored.numbers(), (1, 5));
}

#[tokio::test]
async fn a_directory_whose_every_file_is_in_the_bin_is_not_listed() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let only = instance.place(&folder, "gone/only.md").await;
    instance.place(&folder, "here/one.md").await;
    instance.transition(&only, "trashed").await;
    let read = instance.tree(&folder, "").await;
    assert_eq!(read.directories(), vec![row("here", 1, 1, false)]);
}

#[tokio::test]
async fn a_revoked_folder_keeps_answering_with_the_edges_it_kept() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    let revoked = instance
        .owner_call(
            Method::POST,
            &format!("/folders/{folder}/revoke"),
            json!({}),
        )
        .await;
    assert!(revoked.status.is_success(), "{}", revoked.text);
    let read = instance.tree(&folder, "").await;
    assert_eq!(
        read.directories(),
        vec![row("notes", 2, 5, true), row("projects", 1, 2, true)]
    );
    assert_eq!(read.numbers(), (1, 8));
}

#[tokio::test]
async fn a_moved_or_removed_placement_is_counted_where_it_stands_now() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let moved = instance.place(&folder, "old/one.md").await;
    let removed = instance.place(&folder, "old/two.md").await;
    let edges = instance
        .owner_call(Method::GET, &format!("/items/{moved}/edges"), Value::Null)
        .await;
    let edge = edges.body["data"][0]["id"].as_str().unwrap().to_string();
    let patched = instance
        .owner_call(
            Method::PATCH,
            &format!("/edges/{edge}"),
            json!({ "version": 1, "properties": { "path": "new/one.md" } }),
        )
        .await;
    assert!(patched.status.is_success(), "{}", patched.text);
    let edges = instance
        .owner_call(Method::GET, &format!("/items/{removed}/edges"), Value::Null)
        .await;
    let edge = edges.body["data"][0]["id"].as_str().unwrap().to_string();
    let deleted = instance
        .owner_call(Method::DELETE, &format!("/edges/{edge}"), Value::Null)
        .await;
    assert!(deleted.status.is_success(), "{}", deleted.text);
    let read = instance.tree(&folder, "").await;
    assert_eq!(read.directories(), vec![row("new", 1, 1, false)]);
    assert_eq!(read.numbers(), (0, 1));
}

#[tokio::test]
async fn an_unauthenticated_request_is_unauthorized() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let path = format!("/folders/{folder}/directories");
    send(&instance.public, None, Method::GET, &path, Value::Null)
        .await
        .refused(StatusCode::UNAUTHORIZED, "unauthorized");
}

#[tokio::test]
async fn a_malformed_id_and_an_id_that_is_no_folder_are_refused_as_status_refuses_them() {
    let instance = Instance::start().await;
    let note = instance.item(&instance.owner, "core.note").await;
    let malformed = instance
        .owner_call(Method::GET, "/folders/not-an-id/directories", Value::Null)
        .await;
    malformed.refused(StatusCode::BAD_REQUEST, "invalid_id");
    let status = instance
        .owner_call(Method::GET, "/folders/not-an-id/status", Value::Null)
        .await;
    assert_eq!(status.code(), malformed.code());

    for id in [note.as_str(), "01920000-0000-7000-8000-000000000000"] {
        let read = instance
            .owner_call(
                Method::GET,
                &format!("/folders/{id}/directories"),
                Value::Null,
            )
            .await;
        read.refused(StatusCode::NOT_FOUND, "item_not_found");
        let status = instance
            .owner_call(Method::GET, &format!("/folders/{id}/status"), Value::Null)
            .await;
        assert_eq!(status.body, read.body);
    }
}

#[tokio::test]
async fn a_credential_that_cannot_read_the_folder_is_answered_as_status_answers_it() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    let blind = instance
        .mint("blind", "blind", json!({ "core.note": "read" }), None)
        .await;
    let nothing = instance.mint("nothing", "nothing", json!({}), None).await;
    let readable = instance
        .mint("reader", "reader", json!({ "system.folder": "read" }), None)
        .await;

    for (token, status, code) in [
        (&blind, StatusCode::NOT_FOUND, "item_not_found"),
        (&nothing, StatusCode::FORBIDDEN, "type_not_permitted"),
    ] {
        let read = instance
            .call(
                token,
                Method::GET,
                &format!("/folders/{folder}/directories"),
                Value::Null,
            )
            .await;
        read.refused(status, code);
        let status = instance
            .call(
                token,
                Method::GET,
                &format!("/folders/{folder}/status"),
                Value::Null,
            )
            .await;
        assert_eq!(status.body, read.body);
        let hidden = instance
            .call(
                token,
                Method::GET,
                "/folders/01920000-0000-7000-8000-000000000000/directories",
                Value::Null,
            )
            .await;
        let missing = instance
            .call(
                token,
                Method::GET,
                "/folders/01920000-0000-7000-8000-000000000000/status",
                Value::Null,
            )
            .await;
        assert_eq!(hidden.body, missing.body);
    }

    let seen = instance
        .call(
            &readable,
            Method::GET,
            &format!("/folders/{folder}/directories"),
            Value::Null,
        )
        .await;
    assert_eq!(
        seen.numbers(),
        (0, 0),
        "a key that reads no note counts none"
    );
}

#[tokio::test]
async fn a_key_that_cannot_read_the_in_folder_edge_type_is_refused() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    let minted = send(
        &instance.control,
        None,
        Method::POST,
        "/keys",
        json!({
            "label": "no-edges",
            "source": "no-edges",
            "permissions": [],
            "type_permissions": { "*": "read" },
            "edge_permissions": { "references": "read" },
        }),
    )
    .await;
    let token = minted.body["key"].as_str().unwrap().to_string();
    let read = instance
        .call(
            &token,
            Method::GET,
            &format!("/folders/{folder}/directories"),
            Value::Null,
        )
        .await;
    read.refused(StatusCode::FORBIDDEN, "edge_type_not_permitted");
    assert_eq!(read.body["error"]["details"]["edge_type"], "in-folder");
    let status = instance
        .call(
            &token,
            Method::GET,
            &format!("/folders/{folder}/status"),
            Value::Null,
        )
        .await;
    assert_eq!(
        status.status,
        StatusCode::OK,
        "status needs no edge permission"
    );
}

#[tokio::test]
async fn a_key_counts_only_the_placed_files_whose_type_it_reads() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance
        .places(&folder, &["a/note.md", "a/b/note.md", "top.md"])
        .await;
    for path in ["a/task.md", "c/task.md"] {
        let task = instance.item(&instance.owner, "core.task").await;
        instance.place_item(&task, &folder, path).await;
    }
    let notes_only = instance
        .mint(
            "notes",
            "notes",
            json!({ "system.folder": "read", "core.note": "read" }),
            None,
        )
        .await;
    let read = instance
        .call(
            &notes_only,
            Method::GET,
            &format!("/folders/{folder}/directories"),
            Value::Null,
        )
        .await;
    assert_eq!(read.directories(), vec![row("a", 1, 2, true)]);
    assert_eq!(read.numbers(), (1, 3));

    let whole = instance.tree(&folder, "").await;
    assert_eq!(
        whole.directories(),
        vec![row("a", 2, 3, true), row("c", 1, 1, false)]
    );
    assert_eq!(whole.numbers(), (1, 5));
}

#[tokio::test]
async fn a_source_filter_leaves_out_the_files_of_the_sources_it_does_not_name() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    let shown = instance
        .mint("shown", "shown", json!({ "*": "write" }), None)
        .await;
    let hidden = instance
        .mint("hidden", "hidden", json!({ "*": "write" }), None)
        .await;
    for (writer, path) in [
        (&shown, "a/shown.md"),
        (&shown, "a/b/shown.md"),
        (&hidden, "a/hidden.md"),
        (&hidden, "h/hidden.md"),
    ] {
        let item = instance.item(writer, "core.note").await;
        instance.place_item(&item, &folder, path).await;
    }
    let filtered = instance
        .mint(
            "filtered",
            "filtered",
            json!({ "*": "read" }),
            Some(json!({ "types": ["core.note"], "sources": ["shown"] })),
        )
        .await;
    let read = instance
        .call(
            &filtered,
            Method::GET,
            &format!("/folders/{folder}/directories"),
            Value::Null,
        )
        .await;
    assert_eq!(read.directories(), vec![row("a", 1, 2, true)]);
    assert_eq!(read.numbers(), (0, 2));

    let whole = instance.tree(&folder, "").await;
    assert_eq!(whole.numbers(), (0, 4));
}

#[tokio::test]
async fn the_private_local_command_reads_the_whole_folder() {
    let instance = Instance::start().await;
    let folder = instance.folder().await;
    instance.places(&folder, &SAMPLE).await;
    let local = send(
        &instance.control,
        None,
        Method::GET,
        &format!("/folders/{folder}/directories?under=notes"),
        Value::Null,
    )
    .await;
    assert_eq!(local.directories(), vec![row("notes/2026", 1, 3, true)]);
    assert_eq!(local.numbers(), (2, 8));
}
