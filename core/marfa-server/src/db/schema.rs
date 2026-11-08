//! What a database holds, compared with what this build declares.

use rusqlite::Connection;

use super::migrate::Migration;

#[derive(Debug, PartialEq, Eq)]
struct Object {
    kind: String,
    name: String,
    table: String,
    sql: String,
}

fn objects(conn: &Connection) -> rusqlite::Result<Vec<Object>> {
    conn.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema \
         WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql IS NOT NULL",
    )?
    .query_map([], |row| {
        let sql: String = row.get(3)?;
        Ok(Object {
            kind: row.get(0)?,
            name: row.get(1)?,
            table: row.get(2)?,
            sql: sql.split_whitespace().collect::<Vec<_>>().join(" "),
        })
    })?
    .collect()
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    conn.prepare("SELECT name FROM pragma_table_info(?1)")?
        .query_map([table], |row| row.get(0))?
        .collect()
}

pub fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
}

/// `name` is taken from `sqlite_schema` or a declared list, never from a caller.
pub fn holds_rows(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let quoted = table.replace('"', "\"\"");
    conn.query_row(
        &format!("SELECT EXISTS (SELECT 1 FROM \"{quoted}\")"),
        [],
        |row| row.get(0),
    )
}

/// A table SQLite keeps for a virtual table, which holds rows from the moment
/// the virtual table is made.
pub fn is_shadow(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_list WHERE name = ?1 AND type = 'shadow')",
        [table],
        |row| row.get(0),
    )
}

/// A database built from the migrations alone, which is this build's
/// declaration.
pub fn declared(migrations: &[Migration]) -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    for migration in migrations {
        conn.execute_batch(migration.sql)?;
    }
    Ok(conn)
}

/// How a database stands against the declaration.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Differences {
    /// Declared tables the file does not hold.
    pub missing_tables: Vec<String>,
    /// Every other way the file differs, as a person would say it.
    pub found: Vec<String>,
    /// Declared tables the file holds.
    pub present_tables: Vec<String>,
}

/// A table this build does not declare is someone else's and is ignored,
/// with whatever hangs from it.
pub fn compare(file: &Connection, declared: &Connection) -> rusqlite::Result<Differences> {
    let held = objects(file)?;
    let wanted = objects(declared)?;
    let mut differences = Differences::default();
    let is_table = |object: &&Object| object.kind == "table";
    for want in wanted.iter() {
        match held.iter().find(|object| object.name == want.name) {
            None if want.kind == "table" => differences.missing_tables.push(want.name.clone()),
            // Dropping a table takes its indexes and triggers with it.
            None if !held.iter().any(|object| object.name == want.table) => {}
            None => differences
                .found
                .push(format!("the file lacks the {} {}", want.name, want.kind)),
            Some(have) if have == want => {}
            Some(_) if want.kind == "table" => {
                let have = columns(file, &want.name)?;
                let need = columns(declared, &want.name)?;
                let lacking: Vec<&String> = need.iter().filter(|c| !have.contains(c)).collect();
                let stray: Vec<&String> = have.iter().filter(|c| !need.contains(c)).collect();
                for column in &lacking {
                    let table = &want.name;
                    differences
                        .found
                        .push(format!("the {table} table lacks {column}"));
                }
                for column in &stray {
                    let table = &want.name;
                    differences
                        .found
                        .push(format!("the {table} table carries {column}"));
                }
                if lacking.is_empty() && stray.is_empty() {
                    let table = &want.name;
                    differences
                        .found
                        .push(format!("the {table} table differs from its definition"));
                }
            }
            Some(_) => {
                let (name, kind) = (&want.name, &want.kind);
                differences
                    .found
                    .push(format!("the {name} {kind} differs from its definition"));
            }
        }
    }
    let declared_tables: Vec<&str> = wanted
        .iter()
        .filter(is_table)
        .map(|table| table.name.as_str())
        .collect();
    for have in held.iter().filter(|object| object.kind != "table") {
        let ours = declared_tables.contains(&have.table.as_str());
        if ours && !wanted.iter().any(|want| want.name == have.name) {
            let (name, kind) = (&have.name, &have.kind);
            differences.found.push(format!(
                "the file carries the {name} {kind}, which this build does not declare"
            ));
        }
    }
    differences.present_tables = declared_tables
        .iter()
        .filter(|table| held.iter().any(|object| object.name == **table))
        .map(|table| table.to_string())
        .collect();
    Ok(differences)
}
