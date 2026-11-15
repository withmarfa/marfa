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
    file: "56aac1f96f0ca8886cc433643d6a34a3886d33fa781e988ab5a3c90189d15fc2",
    holds: "bccfcf2a1081613b2c508d9feed709acf6f690a3b4044a4d29c180f79ea325f0",
}];

const BEFORE_AND_FROM_0_1: &str = "Before Marfa 0.1, a database an earlier build wrote is refused \
    anyway: if the change is meant, write the new digests in PINS in the same pull request and \
    say so in its description. From Marfa 0.1, a release's databases must keep opening: put the \
    migration back as it was, and make the change a new numbered migration in MIGRATIONS with an \
    entry of its own in PINS.";

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
             {BEFORE_AND_FROM_0_1}"
        );
        assert!(
            pin.holds == holds,
            "a database made through schema version {version} no longer holds what is pinned, \
             though the migration's SQL did not change: MIGRATIONS changed, or a new SQLite makes \
             the same SQL differently, and the start would refuse a database made before it. It \
             is now {pinned}. {BEFORE_AND_FROM_0_1}"
        );
    }
    assert_eq!(
        PINS.len(),
        MIGRATIONS.len(),
        "PINS holds a version MIGRATIONS lacks"
    );
}
