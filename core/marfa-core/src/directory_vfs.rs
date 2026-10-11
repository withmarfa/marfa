use rusqlite::{Connection, OpenFlags};
use std::{
    ffi::{CStr, CString},
    fs::File,
    os::fd::AsRawFd,
};

use crate::{Result, error::CoreError};

unsafe extern "C" {
    fn marfa_directory_vfs_register(fd: i32, name: *const std::ffi::c_char) -> i32;
    fn marfa_directory_vfs_unregister(name: *const std::ffi::c_char);
    fn marfa_directory_vfs_supported(fd: i32) -> i32;
}

pub(crate) struct DirectoryVfs {
    name: CString,
}

impl DirectoryVfs {
    pub(crate) fn supported(directory: &File) -> Result<()> {
        let result = unsafe { marfa_directory_vfs_supported(directory.as_raw_fd()) };
        if result != rusqlite::ffi::SQLITE_OK {
            return Err(CoreError::Invalid(
                "folder storage is unavailable on this platform or filesystem".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn new(directory: &File) -> Result<Self> {
        Self::supported(directory)?;
        let name = CString::new(format!("marfa-{}", uuid::Uuid::now_v7())).unwrap();
        let result = unsafe { marfa_directory_vfs_register(directory.as_raw_fd(), name.as_ptr()) };
        if result != rusqlite::ffi::SQLITE_OK {
            return Err(CoreError::Store(format!(
                "cannot register directory storage: SQLite {result}"
            )));
        }
        Ok(Self { name })
    }

    pub(crate) fn open(&self, name: &str, flags: OpenFlags) -> Result<Connection> {
        let conn = Connection::open_with_flags_and_vfs(name, flags, self.name.to_str().unwrap())?;
        unsafe {
            rusqlite::ffi::sqlite3_set_authorizer(
                conn.handle(),
                Some(single_store),
                std::ptr::null_mut(),
            );
        }
        Ok(conn)
    }
}

unsafe extern "C" fn single_store(
    _: *mut std::ffi::c_void,
    action: i32,
    argument: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
    _: *const std::ffi::c_char,
) -> i32 {
    if action == rusqlite::ffi::SQLITE_ATTACH && !argument.is_null() {
        let filename = unsafe { CStr::from_ptr(argument) }.to_bytes();
        if !filename.is_empty() && filename != b":memory:" {
            return rusqlite::ffi::SQLITE_DENY;
        }
    }
    rusqlite::ffi::SQLITE_OK
}

impl Drop for DirectoryVfs {
    fn drop(&mut self) {
        unsafe { marfa_directory_vfs_unregister(self.name.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn rw() -> OpenFlags {
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
    }

    #[test]
    fn storage_stays_in_the_open_directory_after_its_name_is_replaced() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("owned");
        std::fs::create_dir(&path).unwrap();
        let vfs = Arc::new(DirectoryVfs::new(&File::open(&path).unwrap()).unwrap());
        let conn = vfs.open("core.sqlite", rw()).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('before')").unwrap();
        let original = parent.path().join("original");
        std::fs::rename(&path, &original).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("core.sqlite"), b"replacement witness").unwrap();
        let before = std::fs::read(path.join("core.sqlite")).unwrap();
        conn.execute_batch("INSERT INTO proof VALUES ('after'); PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let peer = vfs.open("core.sqlite", rw()).unwrap();
        assert_eq!(
            peer.query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(peer);
        drop(conn);
        assert_eq!(std::fs::read(path.join("core.sqlite")).unwrap(), before);
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
        let ordinary = Connection::open(original.join("core.sqlite")).unwrap();
        assert_eq!(
            ordinary
                .query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn ordinary_and_anchored_connections_share_native_locks_and_wal() {
        let dir = tempfile::tempdir().unwrap();
        let vfs = DirectoryVfs::new(&File::open(dir.path()).unwrap()).unwrap();
        let anchored = vfs.open("core.sqlite", rw()).unwrap();
        anchored.busy_timeout(std::time::Duration::ZERO).unwrap();
        anchored
            .execute_batch(
                "PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES (1)",
            )
            .unwrap();
        let ordinary = Connection::open(dir.path().join("core.sqlite")).unwrap();
        ordinary.busy_timeout(std::time::Duration::ZERO).unwrap();
        anchored
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO proof VALUES (2)")
            .unwrap();
        assert_eq!(
            ordinary
                .execute_batch("BEGIN IMMEDIATE")
                .unwrap_err()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert_eq!(
            ordinary
                .query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        anchored.execute_batch("COMMIT").unwrap();
        assert_eq!(
            ordinary
                .query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        ordinary.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert_eq!(
            anchored
                .execute_batch("BEGIN IMMEDIATE")
                .unwrap_err()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        ordinary.execute_batch("ROLLBACK").unwrap();
        drop(ordinary);
        drop(anchored);
    }

    #[test]
    fn an_ordinary_reader_outlives_the_anchored_vfs_without_losing_shm_authority() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("owned");
        std::fs::create_dir(&path).unwrap();
        let vfs = DirectoryVfs::new(&File::open(&path).unwrap()).unwrap();
        let anchored = vfs.open("core.sqlite", rw()).unwrap();
        anchored
            .execute_batch(
                "PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES (1)",
            )
            .unwrap();
        let ordinary = Connection::open(path.join("core.sqlite")).unwrap();
        assert_eq!(
            ordinary
                .query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(anchored);
        drop(vfs);
        std::fs::rename(&path, parent.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("core.sqlite-shm"), b"replacement shared memory").unwrap();
        drop(ordinary);
        assert_eq!(
            std::fs::read(path.join("core.sqlite-shm")).unwrap(),
            b"replacement shared memory"
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    }

    #[test]
    fn native_files_retain_the_vfs_in_rollback_mode_and_refuse_attach() {
        let parent = tempfile::tempdir().unwrap();
        let path = parent.path().join("owned");
        std::fs::create_dir(&path).unwrap();
        let vfs = DirectoryVfs::new(&File::open(&path).unwrap()).unwrap();
        let conn = vfs.open("core.sqlite", rw()).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE; CREATE TABLE proof(value); INSERT INTO proof VALUES (1)",
        )
        .unwrap();
        assert!(
            conn.execute_batch("ATTACH 'other.sqlite' AS other")
                .is_err()
        );
        assert!(!path.join("other.sqlite").exists());
        drop(vfs);
        std::fs::rename(&path, parent.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        conn.execute_batch("BEGIN; INSERT INTO proof VALUES (2); SAVEPOINT inner; INSERT INTO proof VALUES (3); ROLLBACK TO inner; RELEASE inner; COMMIT; VACUUM").unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(conn);
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
    }

    #[test]
    fn separate_process_child() {
        let Some(path) = std::env::var_os("MARFA_DIRECTORY_VFS_CHILD") else {
            return;
        };
        let vfs = DirectoryVfs::new(&File::open(&path).unwrap()).unwrap();
        let claim = vfs.open("core.sqlite.writer-lock", rw()).unwrap();
        claim.busy_timeout(std::time::Duration::ZERO).unwrap();
        match std::env::var("MARFA_DIRECTORY_VFS_CHILD_MODE")
            .unwrap()
            .as_str()
        {
            "reader" => {
                assert_eq!(
                    claim
                        .execute_batch("BEGIN EXCLUSIVE")
                        .unwrap_err()
                        .sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy)
                );
                let reader = vfs
                    .open(
                        "core.sqlite",
                        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                    )
                    .unwrap();
                assert_eq!(
                    reader
                        .query_row("SELECT sum(value) FROM proof", [], |row| row
                            .get::<_, i64>(0))
                        .unwrap(),
                    3
                );
            }
            "native-blocked" | "native-free" => {
                let conn =
                    Connection::open(std::path::Path::new(&path).join("core.sqlite")).unwrap();
                conn.busy_timeout(std::time::Duration::ZERO).unwrap();
                let result = conn.execute_batch("BEGIN IMMEDIATE");
                if std::env::var("MARFA_DIRECTORY_VFS_CHILD_MODE").unwrap() == "native-blocked" {
                    assert_eq!(
                        result.unwrap_err().sqlite_error_code(),
                        Some(rusqlite::ErrorCode::DatabaseBusy)
                    );
                } else {
                    result.unwrap();
                }
            }
            "crash" => {
                claim.execute_batch("BEGIN EXCLUSIVE").unwrap();
                let writer = vfs.open("core.sqlite", rw()).unwrap();
                writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value); INSERT INTO proof VALUES (1); BEGIN IMMEDIATE; INSERT INTO proof VALUES (2)").unwrap();
                println!("ready to terminate");
                use std::io::Write;
                std::io::stdout().flush().unwrap();
                loop {
                    std::thread::park();
                }
            }
            _ => panic!("unknown child mode"),
        }
    }

    fn child(path: &std::path::Path, mode: &str) -> std::process::Child {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "directory_vfs::tests::separate_process_child",
                "--nocapture",
            ])
            .env("MARFA_DIRECTORY_VFS_CHILD", path)
            .env("MARFA_DIRECTORY_VFS_CHILD_MODE", mode)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap()
    }

    #[test]
    fn another_process_reads_committed_wal_and_cannot_take_the_writer_role() {
        let directory = tempfile::tempdir().unwrap();
        let vfs = DirectoryVfs::new(&File::open(directory.path()).unwrap()).unwrap();
        let claim = vfs.open("core.sqlite.writer-lock", rw()).unwrap();
        claim.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let writer = vfs.open("core.sqlite", rw()).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES (1),(2); BEGIN IMMEDIATE; INSERT INTO proof VALUES (4)").unwrap();
        let output = child(directory.path(), "reader")
            .wait_with_output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        writer.execute_batch("ROLLBACK").unwrap();
    }

    #[test]
    fn a_killed_writer_recovers_only_committed_wal_and_releases_its_role() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = child(directory.path(), "crash");
        use std::io::{BufRead, BufReader};
        let mut output = BufReader::new(writer.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "child ended before crash witness"
            );
            if line.contains("ready to terminate") {
                break;
            }
            line.clear();
        }
        writer.kill().unwrap();
        assert!(!writer.wait().unwrap().success());
        let vfs = DirectoryVfs::new(&File::open(directory.path()).unwrap()).unwrap();
        let claim = vfs.open("core.sqlite.writer-lock", rw()).unwrap();
        claim.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let recovered = vfs.open("core.sqlite", rw()).unwrap();
        assert_eq!(
            recovered
                .query_row("SELECT sum(value) FROM proof", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            recovered
                .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        recovered
            .execute_batch("INSERT INTO proof VALUES (3); PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
    }

    #[test]
    fn temp_spills_and_multiple_registrations_stay_in_original_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned");
        std::fs::create_dir(&path).unwrap();
        let first = DirectoryVfs::new(&File::open(&path).unwrap()).unwrap();
        let second = DirectoryVfs::new(&File::open(&path).unwrap()).unwrap();
        let writer = first.open("core.sqlite", rw()).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA temp_store=FILE; PRAGMA cache_size=5; CREATE TABLE proof(value TEXT); WITH RECURSIVE seq(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM seq WHERE x<20000) INSERT INTO proof SELECT printf('%08d-%01000d',x,x) FROM seq").unwrap();
        let reader = second.open("core.sqlite", rw()).unwrap();
        std::fs::rename(&path, directory.path().join("original")).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("outside-witness"), b"keep unchanged").unwrap();
        writer.execute_batch("CREATE TEMP TABLE sorted AS SELECT value FROM proof ORDER BY substr(value,9) DESC; SAVEPOINT inner; DELETE FROM proof; ROLLBACK TO inner; RELEASE inner; VACUUM").unwrap();
        assert_eq!(
            reader
                .query_row("SELECT count(*) FROM proof", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            20000
        );
        assert_eq!(
            writer
                .query_row("SELECT count(*) FROM sorted", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            20000
        );
        drop(first);
        drop(second);
        drop(writer);
        drop(reader);
        assert_eq!(
            std::fs::read(path.join("outside-witness")).unwrap(),
            b"keep unchanged"
        );
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
    }

    #[test]
    fn runtime_options_and_limits_match_build_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let vfs = DirectoryVfs::new(&File::open(directory.path()).unwrap()).unwrap();
        let conn = vfs.open("core.sqlite", rw()).unwrap();
        let options: Vec<String> = conn
            .prepare("PRAGMA compile_options")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        for required in [
            "ENABLE_FTS5",
            "ENABLE_RTREE",
            "ENABLE_STAT4",
            "THREADSAFE=1",
        ] {
            assert!(
                options.iter().any(|option| option == required),
                "{required}: {options:?}"
            );
        }
        for (expected, limit) in [
            (
                option_env!("MARFA_EXPECT_SQLITE_MAX_VARIABLE_NUMBER"),
                rusqlite::ffi::SQLITE_LIMIT_VARIABLE_NUMBER,
            ),
            (
                option_env!("MARFA_EXPECT_SQLITE_MAX_EXPR_DEPTH"),
                rusqlite::ffi::SQLITE_LIMIT_EXPR_DEPTH,
            ),
            (
                option_env!("MARFA_EXPECT_SQLITE_MAX_COLUMN"),
                rusqlite::ffi::SQLITE_LIMIT_COLUMN,
            ),
        ] {
            if let Some(expected) = expected {
                assert_eq!(
                    unsafe { rusqlite::ffi::sqlite3_limit(conn.handle(), limit, -1) },
                    expected.parse::<i32>().unwrap()
                );
            }
        }
    }
    #[test]
    fn identity_checks_do_not_release_native_database_locks() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap();
        let directory = crate::directory::Directory::open(&path).unwrap();
        let vfs = DirectoryVfs::new(directory.file()).unwrap();
        let writer = vfs.open("core.sqlite", rw()).unwrap();
        writer
            .execute_batch("CREATE TABLE proof(value); BEGIN EXCLUSIVE")
            .unwrap();
        for _ in 0..5 {
            directory
                .entry_identity(std::path::Path::new("core.sqlite"))
                .unwrap();
        }
        let blocked = child(&path, "native-blocked").wait_with_output().unwrap();
        assert!(
            blocked.status.success(),
            "{}{}",
            String::from_utf8_lossy(&blocked.stdout),
            String::from_utf8_lossy(&blocked.stderr)
        );
        writer.execute_batch("ROLLBACK").unwrap();
        let free = child(&path, "native-free").wait_with_output().unwrap();
        assert!(
            free.status.success(),
            "{}",
            String::from_utf8_lossy(&free.stdout)
        );
    }
}
