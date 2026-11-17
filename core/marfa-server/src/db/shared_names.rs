//! Fails when a trigger names what Rust owns or reads a file field Rust does not name.

use std::collections::BTreeSet;

use super::migrate::MIGRATIONS;
use crate::app::config::ENFORCEMENT_ROW;
use crate::app::housekeeping::every_job_name;
use crate::app::items::file_fields;
use crate::settings::registry::ENTRIES;

const PATH_START: &str = "$.";

/// The statements without their comment lines, whose apostrophes would unpair the quotes.
fn code(sql: &str) -> String {
    sql.lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The text of each trigger, from its `CREATE TRIGGER` to its closing `END;` line.
fn triggers(sql: &str) -> Vec<&str> {
    sql.match_indices("CREATE TRIGGER")
        .map(|(start, _)| {
            let rest = &sql[start..];
            let end = rest.find("\nEND;").expect("a trigger ends with END;");
            &rest[..end]
        })
        .collect()
}

/// The text between each pair of single quotes.
fn literals(sql: &str) -> Vec<&str> {
    sql.split('\'').skip(1).step_by(2).collect()
}

/// What in `sql` a rename on the Rust side would silently break, one line each.
fn untied(sql: &str) -> Vec<String> {
    let mut found = Vec::new();
    let owned: BTreeSet<&str> = every_job_name()
        .into_iter()
        .chain(ENTRIES.iter().map(|entry| entry.key))
        .chain([ENFORCEMENT_ROW])
        .collect();
    let code = code(sql);
    let in_triggers: Vec<&str> = triggers(&code).into_iter().flat_map(literals).collect();
    for literal in &in_triggers {
        if owned.contains(literal) {
            found.push(format!("a trigger names {literal}, which Rust owns"));
        }
    }
    let paths: BTreeSet<&str> = in_triggers
        .iter()
        .filter_map(|literal| literal.strip_prefix(PATH_START))
        .filter(|name| !name.is_empty())
        .collect();
    for path in &paths {
        if !file_fields::ALL.contains(path) {
            found.push(format!(
                "a trigger reads {PATH_START}{path}, which no constant names"
            ));
        }
    }
    for name in file_fields::ALL {
        if !paths.contains(name) {
            found.push(format!(
                "no trigger reads {PATH_START}{name}, which Rust names"
            ));
        }
    }
    found
}

#[test]
fn the_baseline_s_triggers_name_nothing_rust_can_rename() {
    let sql = MIGRATIONS[0].sql;
    assert!(
        triggers(&code(sql)).len() > 50,
        "the test reads the baseline's triggers"
    );
    assert_eq!(untied(sql), Vec::<String>::new());
}

#[test]
fn a_name_a_trigger_shares_with_rust_is_found() {
    let sql = MIGRATIONS[0].sql;
    let job = every_job_name()[0];
    let key = ENTRIES[0].key;
    let renamed = file_fields::BLOB_REF;
    let witness = format!(
        "{sql}\nCREATE TRIGGER witness AFTER UPDATE ON items\n\
         WHEN NEW.state = 'active'\nBEGIN\n\
         UPDATE housekeeping_jobs SET wake_requested = 1 WHERE name = '{job}';\n\
         SELECT '{key}', NEW.properties ->> '{PATH_START}{renamed}_2';\n\nEND;\n"
    );
    let found = untied(&witness);
    assert!(found.iter().any(|line| line.contains(job)), "{found:?}");
    assert!(found.iter().any(|line| line.contains(key)), "{found:?}");
    assert!(
        found.iter().any(|line| line.contains("blob_ref_2")),
        "{found:?}"
    );
}

#[test]
fn a_file_field_a_trigger_stops_reading_is_found() {
    let sql = MIGRATIONS[0].sql.replace("'$.duration'", "'$.length'");
    let found = untied(&sql);
    assert!(
        found.iter().any(|line| line.contains("$.length")),
        "{found:?}"
    );
    assert!(
        found.iter().any(|line| line.contains("duration")),
        "{found:?}"
    );
}
