//! Each schema version is pinned to what makes it, so a database a release wrote keeps opening.

use sha2::{Digest, Sha256};

use super::migrate::MIGRATIONS;
use super::schema;

struct Pin {
    version: u32,
    /// SHA-256 of the migration's SQL.
    file: &'static str,
    /// SHA-256 of what a database made through this version holds, as the start reads it.
    holds: &'static str,
}

/// One entry for each version in `MIGRATIONS`.
const PINS: &[Pin] = &[Pin {
    version: 1,
    file: "ff2101ea3c2f215996b2da84b4260d6d6c9897ebc2908cec9b6b5da9b0010b58",
    holds: "972085fa36f3694f47545d1ae863bbf81eabe9a105bd290ca30d9e831c15be7c",
}];

const BEFORE_0_1: &str = "Before Marfa 0.1, no release promises that its databases keep opening: \
    if the change is meant, write the new digests in PINS in the same pull request and say so in \
    its description.";

const FROM_0_1_MIGRATION: &str = "From Marfa 0.1, a release's databases must keep opening: put \
    the migration back as it was, and make the change a new numbered migration in MIGRATIONS with \
    an entry of its own in PINS.";

const FROM_0_1_MADE: &str = "From Marfa 0.1, a release's databases must keep opening, and a new \
    migration cannot help, because the start compares a file with its own version, made by this \
    build, before any later migration runs: keep what this build makes from the pinned SQL as it \
    was.";

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
             {BEFORE_0_1} {FROM_0_1_MIGRATION}"
        );
        assert!(
            pin.holds == holds,
            "a database made through schema version {version} no longer holds what is pinned, \
             though no migration's SQL changed: SQLite, or how this build makes a database from \
             its migrations, now makes the same SQL differently, and the start may refuse a \
             database made before. It is now {pinned}. {BEFORE_0_1} {FROM_0_1_MADE}"
        );
    }
    assert_eq!(
        PINS.len(),
        MIGRATIONS.len(),
        "PINS holds a version MIGRATIONS lacks"
    );
}
