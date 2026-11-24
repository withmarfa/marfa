//! Each schema version is pinned to what makes it, so a database a release wrote keeps opening.

use sha2::{Digest, Sha256};

use super::migrate::{MIGRATIONS, Migration};
use super::schema;

struct Pin {
    version: u32,
    /// SHA-256 of the migration's SQL.
    file: &'static str,
    /// SHA-256 of what a database made through this version holds, as the start reads it.
    holds: &'static str,
}

/// One entry for each version in `MIGRATIONS`.
const PINS: &[Pin] = &[
    Pin {
        version: 1,
        file: "ccb0fa48ba010eb983eb84c15b5912ddde4bb173640de4b5f9435408b7a0725d",
        holds: "003e4d5a82a7bdce4bc2f82fc044570bc3747f6cb0174e182be32cc55c73a269",
    },
    Pin {
        version: 2,
        file: "fc117262017aafca8526bd1086ce93d94b12d446b2cc20cb650a382380137190",
        holds: "a8a75a6dfde6f987e5eed80f2f78b3b5f1ae686c5dadd647c4dd5ea53d1ddcbf",
    },
    Pin {
        version: 3,
        file: "7ec5aa22ea05121ad818dbbbcc118382f255c6f3d3f4a16aa2d6eea3da1738e7",
        holds: "8853d1530579ab4f05049e436da2fd5dc4adec057b39f995830f18b45d6e4117",
    },
    Pin {
        version: 4,
        file: "2fe7f6ae043cb6472d2c8e23578252719cdabe9091e0c718b0d6dfd329a9eb72",
        holds: "707eb5de769b9af0dae84fb38470844f5776ebdda3fd78d537834015857cd334",
    },
    Pin {
        version: 5,
        file: "0388d422fd71468a9a0871233c9d9d9e2e276f61e3abf7b89b10512d970c3b28",
        holds: "1f2509b7a45e66505c567debc64a669acd7bc509e1f921e6c4655d98115ebfb7",
    },
    Pin {
        version: 6,
        file: "9902e53a7ccc0b6be1278b31799663d641ec746545555c7f8f427cb70445e2ee",
        holds: "87fd589e8b8d80e59250b7e4fad39185f813f2ae3e65e805db3d4646f410ab6c",
    },
    Pin {
        version: 7,
        file: "f5d8d29392595c61f80a1ea2a0aaa123f2b1695995d72f965a32e147d239f77a",
        holds: "ad1aa12b3bf82a2d43d13d438e1fea23587b22a8ff585381a626b39058413536",
    },
    Pin {
        version: 8,
        file: "c7865418c4d57e5d02dd9a3ad29c07bd172ed6e3dff367d822de47ed39a52ef0",
        holds: "6b1dd0db0eefea033dc2f184d48bc3ecd55aa350e61d68468cbb1cc8f87aab86",
    },
    Pin {
        version: 9,
        file: "ac82d37e1258dcb2823a437611dfd7a33fdf218636871246e6325478d1d8fc74",
        holds: "866fa9fd3357486572e208bcdb478c57fa01dc933dca6cff7ec81eb02db556d9",
    },
    Pin {
        version: 10,
        file: "14051798eae9045b1535795734dda591d9ff7114f82e6ee3a3f3913f84b1a944",
        holds: "91e581a491a85d864b2014ce6da76d864ab1294659fd18cfcc12193c1c63505f",
    },
    Pin {
        version: 11,
        file: "ea0f1ed8f2960af84d2c7d9f87a2025d0966df324f44092415e63eb434385dde",
        holds: "9eda77607465c60f91df59e9fdb085b77969f1e953a0e5c1084cc59913174483",
    },
    Pin {
        version: 12,
        file: "5879bcd2b22952149df1001acd92966d69651e00d4b0f5ee6bfc6b69f810a5bf",
        holds: "6c59f4ba3feb967f7f8b3eab96025d4dfa0f48a48da3c5826dbfb1d870237e3d",
    },
    Pin {
        version: 13,
        file: "a07f88fa0595c02b4c4a7c1722848d6b99afda7110aa32a92ed3594a5ede7e88",
        holds: "cc2ae5bf2ca43d48dd939e4cf5e9b9ff5364a023168d6d455188428418579ebe",
    },
    Pin {
        version: 14,
        file: "7c5237f346b42cdd3b8a2069419d25227a2b8d6b635cae9e888e3bb3c066c1c6",
        holds: "7cfeb760a8a9e06e2eaf9a306fdef5c4f8b40ca8840e3429d742cf4ae90d138d",
    },
    Pin {
        version: 15,
        file: "76c8b0f6e25c6b8eb96619e16040d4c559d1d57e05af91bf452718b3afc196ce",
        holds: "9891b38cf801f740862098bfb6422b9e231740b5a1126a9fea9f7d27baebd112",
    },
];

const MIGRATION_CHANGED: &str = "A migration that a published release contains is never edited, \
    and CI refuses an edit to one by comparing it with the newest release tag \
    (`ci/released-migrations.test.ts`): put it back as it was, and make the change a new numbered \
    migration in MIGRATIONS with an entry of its own in PINS. A new digest is written only for a \
    migration that no release contains yet.";

const MADE_CHANGED: &str = "No migration's SQL changed, so no new migration can help: the start \
    compares a file with its own version, made by this build, before any later migration runs. \
    Keep what this build makes from the pinned SQL as it was. A new digest is written only while \
    no release has written a database at this version.";

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[test]
fn every_schema_version_makes_the_database_pinned_for_it() {
    let versions: Vec<u32> = MIGRATIONS.iter().map(|m| m.version).collect();
    let counted: Vec<u32> = (1..=MIGRATIONS.len() as u32).collect();
    assert_eq!(versions, counted, "schema versions run 1, 2, 3 and so on");
    for (at, migration) in MIGRATIONS.iter().enumerate() {
        let version = migration.version;
        let file = sha256(migration.sql.as_bytes());
        let through = MIGRATIONS.get(..=at).unwrap_or_default();
        let made = schema::declared(through).unwrap();
        let holds =
            sha256(format!("version {version}\n{}", schema::held(&made).unwrap()).as_bytes());
        let pinned = format!("Pin {{ version: {version}, file: \"{file}\", holds: \"{holds}\" }}");
        let Some(pin) = PINS.iter().find(|pin| pin.version == version) else {
            panic!("schema version {version} has no entry in PINS: add {pinned}");
        };
        assert!(
            pin.file == file,
            "the migration for schema version {version} changed, and is now {pinned}. \
             {MIGRATION_CHANGED}"
        );
        assert!(
            pin.holds == holds,
            "a database made through schema version {version} no longer holds what is pinned, \
             though no migration's SQL changed: SQLite, or how this build makes a database from \
             its migrations, now makes the same SQL differently, and the start may refuse a \
             database made before. It is now {pinned}. {MADE_CHANGED}"
        );
    }
    assert_eq!(
        PINS.len(),
        MIGRATIONS.len(),
        "PINS holds a version MIGRATIONS lacks"
    );
}

/// The SQL without its comments, on one line, in capitals. A quoted string or
/// name is reduced to its empty quotes, so nothing inside one is read as a
/// comment or a statement.
fn plain(sql: &str) -> String {
    let mut out = String::new();
    let mut rest = sql;
    while let Some(at) = rest.find(['-', '/', '\'', '"']) {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        if let Some(quote) = tail.chars().next().filter(|c| *c == '\'' || *c == '"') {
            let end = tail[1..].find(quote).map_or(tail.len(), |end| end + 2);
            out.push(quote);
            out.push(quote);
            rest = &tail[end..];
            continue;
        }
        if tail.starts_with("--") {
            rest = tail.find('\n').map_or("", |end| &tail[end..]);
        } else if tail.starts_with("/*") {
            rest = tail.find("*/").map_or("", |end| &tail[end + 2..]);
        } else {
            out.push_str(&tail[..1]);
            rest = &tail[1..];
        }
        out.push(' ');
    }
    out.push_str(rest);
    out.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase()
}

/// Whether the SQL holds a statement that fails on a file that already has its changes.
fn cannot_run_twice(sql: &str) -> bool {
    let sql = plain(sql);
    let unguarded = |starts: &[&str], guard: &str| {
        starts.iter().any(|start| {
            sql.match_indices(start)
                .any(|(at, _)| !sql[at + start.len()..].starts_with(guard))
        })
    };
    ["ADD COLUMN", "DROP COLUMN", " RENAME "]
        .iter()
        .any(|part| sql.contains(part))
        || unguarded(
            &[
                "CREATE TABLE ",
                "CREATE INDEX ",
                "CREATE UNIQUE INDEX ",
                "CREATE TRIGGER ",
                "CREATE VIEW ",
            ],
            "IF NOT EXISTS",
        )
        || unguarded(
            &["DROP TABLE ", "DROP INDEX ", "DROP TRIGGER ", "DROP VIEW "],
            "IF EXISTS",
        )
}

/// The versions whose SQL cannot run twice and that name no `done` query.
fn missing_done(migrations: &[Migration]) -> Vec<u32> {
    migrations
        .iter()
        .filter(|m| cannot_run_twice(m.sql) && m.done.is_none())
        .map(|m| m.version)
        .collect()
}

#[test]
fn a_migration_that_cannot_run_twice_says_when_it_is_done() {
    let missing = missing_done(MIGRATIONS);
    assert!(
        missing.is_empty(),
        "migrations {missing:?} hold a statement that fails on a file that already has its \
         changes, so `done` must name a query that finds those changes in an unfinished file"
    );
}

#[test]
fn a_migration_without_done_is_caught_when_it_cannot_run_twice() {
    let added = Migration {
        version: 99,
        sql: "ALTER TABLE a ADD COLUMN b TEXT;",
        done: None,
    };
    let made = Migration {
        version: 98,
        sql: "-- note\nCREATE INDEX a_b ON a (b); /* x */",
        done: None,
    };
    let safe = Migration {
        version: 97,
        sql: "CREATE TABLE IF NOT EXISTS a (b TEXT);\n-- ADD COLUMN in a comment\n\
              /* RENAME\n   DROP COLUMN */\nCREATE  INDEX\n  IF NOT EXISTS c ON a (b);\n\
              DROP INDEX IF EXISTS c;",
        done: None,
    };
    let renamed = Migration {
        version: 96,
        sql: "ALTER TABLE a RENAME TO b;",
        done: None,
    };
    let dropped = Migration {
        version: 95,
        sql: "DROP TRIGGER t;",
        done: None,
    };
    let quoted = Migration {
        version: 94,
        sql: "UPDATE a SET b = 'https://*.example -- x', renamed_at = 1;\nCREATE TABLE c (d TEXT);",
        done: None,
    };
    let named = Migration {
        version: 93,
        sql: "UPDATE a SET renamed_at = '/* ADD COLUMN */';",
        done: None,
    };
    assert_eq!(
        missing_done(&[added, made, safe, renamed, dropped, quoted, named]),
        [99, 98, 96, 95, 94]
    );
}
