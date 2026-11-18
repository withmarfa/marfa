//! Previewing and trashing several items at once.

use crate::{Core, MarfaError};

/// What trashing items would take, as the server read it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TrashPreview {
    /// Each named item once, in the order named.
    pub items: Vec<TrashPreviewItem>,
    /// Every item the key may read that the trash would take, each once.
    pub count: u64,
    /// Passed back unchanged to `trash` so the trash covers only this.
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
    /// What trashing `ids` would take, read from the server and held nowhere
    /// in the copy. An id named twice counts once. Throws `Validation` for no
    /// id or more than 20 distinct ones, `NoServer` for a copy with none, and
    /// `Network` offline. Any other copy than the one the server holds throws
    /// `CopyExpired`.
    pub fn preview_trash(&self, ids: Vec<String>) -> Result<TrashPreview, MarfaError> {
        Ok(self.inner.preview_trash(&ids)?.into())
    }

    /// Moves what `preview` names, and what it says the trash takes, to the
    /// bin on the server at once, all or none. Never queued: the preview's
    /// digest binds it to the server's state when it was read, so an app
    /// offline queues `deleteItem` for each item instead. Throws `Invalid`
    /// naming how to clear each write, before anything is sent, while a write
    /// waits for a named item or one the preview lists under `takes` (for a
    /// truncated preview, for any item), `NoServer`, `CopyExpired` for another
    /// instance at the origin, and the server's refusal (`Server` with the
    /// status 409 and `trash_plan_changed` for a digest that no longer
    /// matches, `Server` with 400 and `edge_constraint_violation`,
    /// `Forbidden`) with the copy and the queue as they were. `Network`
    /// after the request went out may follow a trash the server made, which
    /// the item events then show. Once it succeeds, every item the copy holds
    /// among them is in the bin in the copy.
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
