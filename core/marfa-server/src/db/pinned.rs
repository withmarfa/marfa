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
];

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
