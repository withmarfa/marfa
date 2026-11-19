//! Counts of linked items and of table rows.

use crate::guard::guarded;
use crate::{Core, MarfaError};

/// What a count counts for each item.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum Counted {
    /// The active items an edge of the type leaves each item for, such as
    /// the children `parent-of` gives.
    Backref { edge_type: String },
    /// The active items with an edge of the type to each item, such as the
    /// members `in-collection` gives.
    Edge { edge_type: String },
    /// The rows each item holds in the table.
    Table { table: String },
}

/// The counted items in each status group.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Record)]
pub struct StatusGroups {
    pub not_started: i64,
    pub in_progress: i64,
    pub completed: i64,
    pub canceled: i64,
}

/// One item's count.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ItemCount {
    pub id: String,
    pub total: i64,
    /// `nil` for a table's rows. An item with no status, or a status word
    /// its type does not declare, is in `total` and in no group.
    pub status_groups: Option<StatusGroups>,
    /// `true` where the copy answered, `false` where the server did.
    pub held: bool,
}

impl From<Counted> for marfa_core::Counted {
    fn from(counted: Counted) -> Self {
        match counted {
            Counted::Backref { edge_type } => marfa_core::Counted::Backref(edge_type),
            Counted::Edge { edge_type } => marfa_core::Counted::Edge(edge_type),
            Counted::Table { table } => marfa_core::Counted::Table(table),
        }
    }
}

impl From<marfa_core::ItemCount> for ItemCount {
    fn from(count: marfa_core::ItemCount) -> Self {
        ItemCount {
            id: count.id,
            total: count.total,
            status_groups: count.status_groups.map(|groups| StatusGroups {
                not_started: groups.not_started,
                in_progress: groups.in_progress,
                completed: groups.completed,
                canceled: groups.canceled,
            }),
            held: count.held,
        }
    }
}

guarded! {
    #[uniffi::export]
    impl Core {
        /// Counts from the copy where possible. On `NotAnswerable`, call `servedCounts(ids:counted:)`.
        pub fn counts(&self, ids: Vec<String>, counted: Counted) -> Result<Vec<ItemCount>, MarfaError> {
            Ok(self
                .inner
                .counts(&ids, &counted.into())?
                .into_iter()
                .map(Into::into)
                .collect())
        }

        /// Requests every count from the copy's server. Each result has `held` set to false.
        pub fn served_counts(
            &self,
            ids: Vec<String>,
            counted: Counted,
        ) -> Result<Vec<ItemCount>, MarfaError> {
            Ok(self
                .inner
                .served_counts(&ids, &counted.into())?
                .into_iter()
                .map(Into::into)
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Counted, StatusGroups};
    use crate::renewal::{CredentialRenewer, RenewalError};
    use crate::{Core, MarfaError};

    const PARENT: &str = "01a1011a-4902-76cf-a4a9-88e99c038c8d";
    const DONE: &str = "01a1011c-2f86-76b6-9594-050c109f4957";
    const NOTE: &str = "01a1011c-2f86-76b6-9594-050c109f4958";

    fn core(whole: &str) -> (tempfile::TempDir, std::sync::Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.sqlite").display().to_string();
        let core = Core::open(path.clone(), None, None, None).unwrap();
        let db = rusqlite::Connection::open(path).unwrap();
        for (key, value) in [
            ("event_cursor", "10"),
            ("instance_id", "test-instance"),
            ("reach", &"a".repeat(64)),
            ("slice_types", r#"["core.note"]"#),
            ("slice_tier", "all"),
            ("slice_edge_types", whole),
        ] {
            db.execute("INSERT OR REPLACE INTO meta VALUES (?1,?2)", [key, value])
                .unwrap();
        }
        for id in [PARENT, DONE, NOTE] {
            db.execute(
                "INSERT INTO items (id,type,state,tier,version,schema_version,source,occurred_at,created_at,updated_at,properties) VALUES (?1,'core.note','active','library',1,1,'test','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{}')",
                [id],
            )
            .unwrap();
        }
        for (id, to) in [("e1", DONE), ("e2", NOTE)] {
            db.execute(
                "INSERT INTO edges (id,from_id,to_id,edge_type,properties,version,created_at,updated_at) VALUES (?1,?2,?3,'parent-of','{}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [id, PARENT, to],
            )
            .unwrap();
        }
        (dir, core)
    }

    #[test]
    fn a_count_crosses_the_swift_boundary_typed_and_is_refused_where_it_cannot_be_answered() {
        let (_dir, core) = core(r#"["parent-of"]"#);
        let backref = || Counted::Backref {
            edge_type: "parent-of".into(),
        };
        let counts = core
            .counts(vec![DONE.into(), PARENT.into(), DONE.into()], backref())
            .unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts[0].id, DONE);
        assert_eq!(counts[0].total, 0);
        assert_eq!(counts[1].total, 2);
        assert!(counts[1].held);
        // Core's note type has no status field, so both children are in the total only.
        assert_eq!(counts[1].status_groups, Some(StatusGroups::default()));
        let members = core
            .counts(
                vec![DONE.into()],
                Counted::Edge {
                    edge_type: "parent-of".into(),
                },
            )
            .unwrap();
        assert_eq!(members[0].total, 1);

        let (_dir, unheld) = self::core("[]");
        assert!(matches!(
            unheld.counts(vec![PARENT.into()], backref()),
            Err(MarfaError::NotAnswerable { .. })
        ));
    }

    struct Failing(RenewalError);

    impl CredentialRenewer for Failing {
        fn renew(&self, _refused: String) -> Result<String, RenewalError> {
            Err(self.0.clone())
        }
    }

    /// A server that refuses every request's credential.
    fn refusing() -> String {
        answering(
            "401 Unauthorized",
            r#"{"error":{"code":"unauthorized","message":"the token expired"}}"#,
        )
    }

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

    #[test]
    fn a_failed_renewal_asking_the_server_for_rows_is_itself_and_never_not_answerable() {
        let url = refusing();
        let message = || "said".to_string();
        for (failure, expected) in [
            (RenewalError::Failed { message: message() }, "invalid"),
            (RenewalError::Ended { message: message() }, "signed_out"),
            (RenewalError::Unavailable { message: message() }, "network"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("copy.sqlite").display().to_string();
            let core = Core::open(
                path,
                Some(url.clone()),
                Some("stale".into()),
                Some(std::sync::Arc::new(Failing(failure))),
            )
            .unwrap();
            let refusal = core
                .counts(
                    vec![PARENT.into()],
                    Counted::Table {
                        table: "lines".into(),
                    },
                )
                .unwrap_err();
            assert_eq!(refusal.code(), expected, "{refusal:?}");
        }
    }

    #[test]
    fn served_counts_cross_the_swift_boundary_typed_and_refuse_an_answer_without_groups() {
        let open = |url: String| {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("copy.sqlite").display().to_string();
            let core = Core::open(path, Some(url), Some("key".into()), None).unwrap();
            (dir, core)
        };
        let backref = || Counted::Backref {
            edge_type: "parent-of".into(),
        };
        let (_dir, core) = open(answering(
            "200 OK",
            r#"{"counts":[{"id":"01a1011a-4902-76cf-a4a9-88e99c038c8d","total":3,"status_groups":{"not_started":1,"in_progress":1,"completed":1,"canceled":0}}]}"#,
        ));
        let served = core
            .served_counts(vec![PARENT.into(), PARENT.into()], backref())
            .unwrap();
        assert_eq!(served.len(), 1);
        assert_eq!(served[0].total, 3);
        assert!(!served[0].held);
        assert_eq!(
            served[0].status_groups,
            Some(StatusGroups {
                not_started: 1,
                in_progress: 1,
                completed: 1,
                canceled: 0
            })
        );
        let (_dir, core) = open(answering(
            "200 OK",
            r#"{"counts":[{"id":"01a1011a-4902-76cf-a4a9-88e99c038c8d","total":3}]}"#,
        ));
        let refusal = core
            .served_counts(vec![PARENT.into()], backref())
            .unwrap_err();
        assert_eq!(refusal.code(), "decoding", "{refusal:?}");
    }
}
