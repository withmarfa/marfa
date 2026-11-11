//! A start that is killed leaves a database the next start accepts whole.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use tempfile::TempDir;

const KILLS: u64 = 48;

fn program(dir: &Path) -> Command {
    let control = dir.canonicalize().unwrap().join("control").join("s.sock");
    let mut command = Command::new(env!("CARGO_BIN_EXE_marfa-server"));
    command
        .env_clear()
        .env("MARFA_PORT", "0")
        .env("MARFA_LISTEN_HOST", "127.0.0.1")
        .env("MARFA_DATABASE_PATH", dir.join("marfa.db"))
        .env("MARFA_BLOB_PATH", dir.join("blobs"))
        .env("MARFA_CONTROL_SOCKET", control)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}

/// Whether the program printed that it listens, before it ended or `wait` passed.
fn listens(child: &mut Child, wait: Duration) -> bool {
    let stdout = child.stdout.take().unwrap();
    let (found, heard) = std::sync::mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("listening on port") {
                let _ = found.send(());
                return;
            }
        }
    });
    heard.recv_timeout(wait).is_ok()
}

/// Read from a copy, so that recovering the log changes nothing in the folder under test.
fn shape(file: &Path) -> (String, i64) {
    let copy = TempDir::new().unwrap();
    let kept = copy.path().join("marfa.db");
    std::fs::copy(file, &kept).unwrap();
    let mut log = file.as_os_str().to_owned();
    log.push("-wal");
    if Path::new(&log).exists() {
        std::fs::copy(&log, copy.path().join("marfa.db-wal")).unwrap();
    }
    let db = Connection::open(kept).unwrap();
    let checked: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    let tables = db
        .query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type = 'table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    (checked, tables)
}

fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_kill_during_the_first_start_leaves_a_database_the_next_start_accepts_whole() {
    let whole = TempDir::new().unwrap();
    let mut reference = program(whole.path()).spawn().unwrap();
    assert!(listens(&mut reference, Duration::from_secs(30)));
    stop(&mut reference);
    let (_, expected_tables) = shape(&whole.path().join("marfa.db"));
    assert!(expected_tables > 0);

    let mut left_empty = 0;
    let mut left_whole = 0;
    for kill in 0..KILLS {
        let dir = TempDir::new().unwrap();
        let mut first = program(dir.path()).spawn().unwrap();
        thread::sleep(Duration::from_micros(kill * 1_300));
        stop(&mut first);
        let file = dir.path().join("marfa.db");
        if file.exists() && std::fs::metadata(&file).unwrap().len() > 0 {
            let (_, tables) = shape(&file);
            match tables {
                0 => left_empty += 1,
                found if found == expected_tables => left_whole += 1,
                found => panic!("a kill left {found} of {expected_tables} tables"),
            }
        }

        let started = Instant::now();
        let mut second = program(dir.path()).spawn().unwrap();
        assert!(
            listens(&mut second, Duration::from_secs(30)),
            "the start after a kill {kill} ms in did not listen"
        );
        assert!(started.elapsed() < Duration::from_secs(30));
        stop(&mut second);
        let (checked, tables) = shape(&file);
        assert_eq!(checked, "ok");
        assert_eq!(tables, expected_tables);
    }
    assert!(
        left_empty + left_whole > 0,
        "no kill landed after the file was made, so none tested the migration"
    );
}
