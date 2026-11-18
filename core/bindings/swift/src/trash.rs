//! Previewing and trashing several items at once.

use crate::{Core, MarfaError};

/// What trashing items would take, as the server read it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrashPreview {
    /// Each named item once, in the order named.
    pub items: Vec<TrashPreviewItem>,
    /// The number of distinct readable items the trash would take.
    pub count: u64,
    /// Pass unchanged to `trash_items` to bind it to this preview.
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrashPreviewItem {
    pub id: String,
    pub r#type: String,
    pub version: i64,
    /// What the trash takes with this item, leaves first, at most 100.
    pub takes: Vec<TrashTaken>,
    pub count: u64,
    /// `takes` was cut at its limit.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrashTaken {
    pub id: String,
    pub r#type: String,
    pub version: i64,
}

impl From<marfa_core::TrashPreview> for TrashPreview {
    fn from(preview: marfa_core::TrashPreview) -> Self {
        TrashPreview {
            items: preview
                .items
                .into_iter()
                .map(|item| TrashPreviewItem {
                    id: item.id,
                    r#type: item.r#type,
                    version: item.version,
                    takes: item
                        .takes
                        .into_iter()
                        .map(|taken| TrashTaken {
                            id: taken.id,
                            r#type: taken.r#type,
                            version: taken.version,
                        })
                        .collect(),
                    count: item.count,
                    truncated: item.truncated,
                })
                .collect(),
            count: preview.count,
            digest: preview.digest,
        }
    }
}

impl From<TrashPreview> for marfa_core::TrashPreview {
    fn from(preview: TrashPreview) -> Self {
        marfa_core::TrashPreview {
            items: preview
                .items
                .into_iter()
                .map(|item| marfa_core::TrashPreviewItem {
                    id: item.id,
                    r#type: item.r#type,
                    version: item.version,
                    takes: item
                        .takes
                        .into_iter()
                        .map(|taken| marfa_core::TrashTaken {
                            id: taken.id,
                            r#type: taken.r#type,
                            version: taken.version,
                        })
                        .collect(),
                    count: item.count,
                    truncated: item.truncated,
                })
                .collect(),
            count: preview.count,
            digest: preview.digest,
        }
    }
}

#[uniffi::export]
impl Core {
    /// Requires a server; duplicate IDs count once toward the 20-item limit.
    pub fn preview_trash(&self, ids: Vec<String>) -> Result<TrashPreview, MarfaError> {
        Ok(self.inner.preview_trash(&ids)?.into())
    }

    /// Never queued: the digest binds the request to the previewed state.
    pub fn trash_items(&self, preview: TrashPreview) -> Result<(), MarfaError> {
        Ok(self.inner.trash_items(&preview.into())?)
    }
}

#[cfg(test)]
mod tests {
    use crate::{Core, MarfaError};

    /// A server that gives every request `status` and `body`.
    fn answering(status: &'static str, body: &'static str) -> String {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let (mut length, mut line) = (0, String::new());
                while reader.read_line(&mut line).unwrap_or(0) > 2 {
                    if let Some((key, value)) = line.split_once(':')
                        && key.eq_ignore_ascii_case("content-length")
                    {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    line.clear();
                }
                let _ = reader.read_exact(&mut vec![0; length]);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Marfa-Contract: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len(),
                        marfa_core::contract::CONTRACT_VERSION
                    )
                    .as_bytes(),
                );
            }
        });
        url
    }

    fn open(url: String) -> (tempfile::TempDir, std::sync::Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.sqlite").display().to_string();
        let core = Core::open(path, Some(url), Some("key".into()), None).unwrap();
        (dir, core)
    }

    #[test]
    fn a_preview_crosses_the_swift_boundary_typed_and_a_refused_trash_throws_the_servers_code() {
        let digest = "d".repeat(64);
        let body: &'static str = Box::leak(
            format!(
                r#"{{"items":[{{"id":"a","type":"core.note","version":3,"takes":[{{"id":"b","type":"core.note","version":1}}],"count":2,"truncated":true}}],"count":2,"digest":"{digest}"}}"#
            )
            .into_boxed_str(),
        );
        let (_dir, core) = open(answering("200 OK", body));
        let preview = core.preview_trash(vec!["a".into(), "a".into()]).unwrap();
        assert_eq!(preview.count, 2);
        assert_eq!(preview.digest, digest);
        assert_eq!(preview.items[0].takes[0].id, "b");
        assert!(preview.items[0].truncated);
        assert!(matches!(
            core.preview_trash(Vec::new()).unwrap_err(),
            MarfaError::Validation { .. }
        ));

        let (_dir, core) = open(answering(
            "409 Conflict",
            r#"{"error":{"code":"trash_plan_changed","message":"changed"}}"#,
        ));
        let refusal = core.trash_items(preview).unwrap_err();
        match refusal {
            MarfaError::Server { status, code, .. } => {
                assert_eq!((status, code.as_str()), (409, "trash_plan_changed"));
            }
            other => panic!("{other:?}"),
        }
    }
}
