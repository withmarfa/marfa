//! The swap, run for real on folders of its own against a local stand-in for GitHub's downloads.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};

use super::apply::{self, Job};
use super::feed::Feed;
use super::pending::{Folder, PROGRAMS, previous_of};
use super::release::{Asset, archive_name};
use super::{State, Updates};
use crate::app::faults::Faults;
use crate::settings::DatabasePath;

type Routes = Arc<Mutex<HashMap<String, (u16, Vec<u8>)>>>;

struct Stand {
    port: u16,
    hits: Arc<AtomicUsize>,
    routes: Routes,
}

impl Stand {
    fn start() -> Stand {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let routes: Routes = Arc::default();
        let (counted, held) = (hits.clone(), routes.clone());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                counted.fetch_add(1, Ordering::SeqCst);
                let mut head = [0u8; 2048];
                let read = stream.read(&mut head).unwrap_or(0);
                let head = String::from_utf8_lossy(&head[..read]).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = held
                    .lock()
                    .unwrap()
                    .get(&path)
                    .cloned()
                    .unwrap_or((404, Vec::new()));
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = stream.write_all(&body);
            }
        });
        Stand { port, hits, routes }
    }

    fn serve(&self, path: &str, body: Vec<u8>) {
        self.routes
            .lock()
            .unwrap()
            .insert(path.to_string(), (200, body));
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn asked(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

fn program(name: &str, version: &str, can_open: &str) -> String {
    format!(
        "#!/bin/sh\ncase \"$1\" in\n--version) echo \"{name} {version}\";;\n--can-open) {can_open};;\nesac\n"
    )
}

const OPENS: &str = "echo '{\"schema\":1,\"standing\":\"current\"}'";

/// An archive with each entry as given, whatever its name or kind.
fn raw_archive(entries: &[(&str, tar::EntryType, &str, &str)]) -> Vec<u8> {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for (name, kind, link, text) in entries {
        let mut header = tar::Header::new_gnu();
        let named = header.as_gnu_mut().unwrap();
        named.name[..name.len()].copy_from_slice(name.as_bytes());
        named.linkname[..link.len()].copy_from_slice(link.as_bytes());
        header.set_entry_type(*kind);
        header.set_size(text.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append(&header, text.as_bytes()).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn archive(files: &[(&str, String)]) -> Vec<u8> {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for (name, text) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(text.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, name, text.as_bytes()).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

fn hex_of(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

struct Case {
    root: PathBuf,
    stand: Stand,
    faults: Arc<Faults>,
}

impl Case {
    fn new(name: &str) -> Case {
        let root = std::env::temp_dir().join(format!("marfa-apply-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        for program_name in PROGRAMS {
            let path = root.join("bin").join(program_name);
            fs::write(&path, program(program_name, "0.0.74", OPENS)).unwrap();
            apply_mode(&path);
        }
        let faults = Arc::new(Faults::default());
        faults
            .set("release-feed", Some("http://127.0.0.1:9/latest"))
            .unwrap();
        Case {
            root,
            stand: Stand::start(),
            faults,
        }
    }

    fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }

    fn record(&self) -> Folder {
        Folder::of(&DatabasePath::File(self.root.join("data/marfa.db"))).unwrap()
    }

    /// The release's files served, with the checksums line `sum` gives (the archive's own when
    /// `None`) and `bytes` as the size the release claims.
    fn release(&self, files: &[(&str, String)], sum: Option<&str>, bytes: Option<u64>) -> Job {
        self.release_of(archive(files), sum, bytes)
    }

    fn release_of(&self, packed: Vec<u8>, sum: Option<&str>, bytes: Option<u64>) -> Job {
        let name = archive_name("0.0.75", "linux-x86_64");
        let line = format!(
            "{}  {name}\n",
            sum.map_or_else(|| hex_of(&packed), str::to_string)
        );
        let claimed = bytes.unwrap_or(packed.len() as u64);
        self.stand.serve("/archive", packed);
        self.stand.serve("/sums", line.into_bytes());
        Job {
            from: "0.0.74".into(),
            version: "0.0.75".into(),
            archive_name: name,
            archive: Asset {
                url: self.stand.url("/archive"),
                bytes: claimed,
            },
            checksums: Asset {
                url: self.stand.url("/sums"),
                bytes: 100,
            },
            programs: self.bin(),
            database: self.root.join("data/marfa.db"),
            record: self.record(),
        }
    }

    async fn run(&self, job: Job) -> Result<(), String> {
        let feed = Feed::new(self.faults.clone());
        tokio::task::spawn_blocking(move || apply::run(&feed, &job, &|_| {}))
            .await
            .unwrap()
    }

    fn text(&self, name: &str) -> String {
        fs::read_to_string(self.bin().join(name)).unwrap()
    }

    fn untouched(&self) {
        for name in PROGRAMS {
            assert_eq!(self.text(name), program(name, "0.0.74", OPENS), "{name}");
            assert!(!previous_of(&self.bin(), name).exists(), "{name}");
        }
        assert!(self.record().pending().is_none());
        let staged = fs::read_dir(self.bin()).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".marfa-update-")
        });
        assert!(!staged, "the unpacking folder is removed");
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn apply_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn good(can_open: &str) -> Vec<(&'static str, String)> {
    vec![
        ("marfa", program("marfa", "0.0.75", OPENS)),
        ("marfa-server", program("marfa-server", "0.0.75", can_open)),
        ("NOTICES.txt", "notices".to_string()),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_that_checks_out_replaces_both_programs_and_keeps_the_old_ones() {
    let case = Case::new("swaps");
    let job = case.release(&good(OPENS), None, None);
    case.run(job).await.unwrap();
    for name in PROGRAMS {
        assert_eq!(case.text(name), program(name, "0.0.75", OPENS), "{name}");
        assert_eq!(
            fs::read_to_string(previous_of(&case.bin(), name)).unwrap(),
            program(name, "0.0.74", OPENS),
            "the old {name} is kept to put back"
        );
    }
    let pending = case.record().pending().unwrap();
    assert_eq!(
        (pending.from.as_str(), pending.to.as_str()),
        ("0.0.74", "0.0.75")
    );
    assert_eq!((pending.schema, pending.starts), (Some(1), 0));
    assert!(!case.bin().join(".marfa-update-0.0.75").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_checksum_that_does_not_match_leaves_the_running_release_as_it_was() {
    let case = Case::new("mismatch");
    let wrong = "0".repeat(64);
    let job = case.release(&good(OPENS), Some(&wrong), None);
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("checksum"), "{refused}");
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_checksum_file_with_no_line_or_two_lines_for_the_archive_is_refused() {
    let case = Case::new("lines");
    let job = case.release(&good(OPENS), None, None);
    let name = job.archive_name.clone();
    case.stand
        .serve("/sums", b"abc  marfa-0.0.75-other.tar.gz\n".to_vec());
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("no line"), "{refused}");
    let job = case.release(&good(OPENS), None, None);
    let line = format!("{}  {name}\n", "1".repeat(64));
    case.stand
        .serve("/sums", format!("{line}{line}").into_bytes());
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("more than once"), "{refused}");
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_program_that_will_not_run_or_names_another_release_is_not_swapped_in() {
    let case = Case::new("wrong");
    let mut files = good(OPENS);
    files[1].1 = program("marfa-server", "0.0.99", OPENS);
    let job = case.release(&files, None, None);
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("0.0.99"), "{refused}");
    case.untouched();

    let mut files = good(OPENS);
    files[0].1 = "#!/nonexistent/interpreter\n".to_string();
    let job = case.release(&files, None, None);
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("does not run"), "{refused}");
    case.untouched();

    let files = vec![("marfa-server", program("marfa-server", "0.0.75", OPENS))];
    let job = case.release(&files, None, None);
    assert!(case.run(job).await.unwrap_err().contains("holds no marfa"));
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_that_will_not_open_this_database_changes_nothing_and_says_the_way_forward() {
    let case = Case::new("database");
    let refuses = "echo 'the database is not this build' >&2; exit 78";
    let job = case.release(&good(refuses), None, None);
    let refused = case.run(job).await.unwrap_err();
    assert!(
        refused.contains("will not run on this server's settings and database"),
        "{refused}"
    );
    assert!(
        refused.contains("the database is not this build"),
        "{refused}"
    );
    case.untouched();

    let job = case.release(&good("echo nonsense"), None, None);
    assert!(case.run(job).await.unwrap_err().contains("cannot read"));
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_download_that_is_missing_leaves_the_running_release_as_it_was() {
    let case = Case::new("missing");
    let mut job = case.release(&good(OPENS), None, None);
    job.archive.url = case.stand.url("/nowhere");
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("404"), "{refused}");
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_disk_with_too_little_room_is_refused_before_anything_is_downloaded() {
    let case = Case::new("room");
    let job = case.release(&good(OPENS), None, Some(1 << 60));
    let before = case.stand.asked();
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("not enough room"), "{refused}");
    assert_eq!(case.stand.asked(), before, "no request was made");
    case.untouched();

    let job = case.release(&good(OPENS), None, None);
    case.run(job).await.unwrap();
    assert!(
        case.stand.asked() > before,
        "the witness: with room the same release is fetched"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_archive_larger_than_its_release_claims_is_cut_off() {
    let case = Case::new("larger");
    let job = case.release(&good(OPENS), None, Some(10));
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("larger"), "{refused}");
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_program_folder_the_account_cannot_write_is_refused_with_the_programs_untouched() {
    use std::os::unix::fs::PermissionsExt;
    let case = Case::new("readonly");
    let job = case.release(&good(OPENS), None, None);
    let _locked = marfa_acl::testing::locked(case.bin(), 0o555);
    let refused = case.run(job).await;
    fs::set_permissions(case.bin(), fs::Permissions::from_mode(0o755)).unwrap();
    // A superuser can write anywhere, so the refusal is only owed to everyone else.
    if unsafe { libc::geteuid() } != 0 {
        assert!(refused.unwrap_err().contains("beside the programs"));
        case.untouched();
    }
}

#[test]
fn a_refused_link_keeps_the_old_program_as_an_executable_copy() {
    use std::os::unix::fs::PermissionsExt;
    let case = Case::new("copy-aside");
    let live = case.bin().join("marfa-server");
    let kept = previous_of(&case.bin(), "marfa-server");
    let refused = |_: &Path, _: &Path| Err(std::io::Error::other("links refused here"));
    apply::keep_aside(&live, &kept, refused).unwrap();
    assert_eq!(fs::read(&kept).unwrap(), fs::read(&live).unwrap());
    assert_eq!(
        fs::metadata(&kept).unwrap().permissions().mode() & 0o777,
        0o755
    );
    fs::remove_file(&kept).unwrap();
    assert!(
        apply::keep_aside(&case.bin().join("absent"), &kept, refused).is_err(),
        "the witness: with nothing to copy the fallback fails too"
    );
}

#[test]
fn a_second_request_while_one_runs_joins_it_and_the_update_runs_once() {
    let updates = Updates::new(&DatabasePath::Memory);
    assert!(updates.begin("0.0.75"));
    assert!(!updates.begin("0.0.75"), "the second joins");
    updates.stage("checking");
    assert_eq!(
        updates.state(),
        State::Fetching {
            version: "0.0.75".into(),
            stage: "checking"
        }
    );
    updates.set(State::Idle);
    assert!(
        updates.begin("0.0.75"),
        "the witness: once it ends another may start"
    );
}

fn new_program(name: &str) -> String {
    program(name, "0.0.75", OPENS)
}

#[tokio::test(flavor = "multi_thread")]
async fn entries_outside_the_archive_or_named_as_a_program_but_not_a_file_are_never_written() {
    use tar::EntryType::{Link, Regular, Symlink};
    let case = Case::new("hostile");
    let outside = case.root.join("escaped");
    let outside = outside.to_str().unwrap();
    let (server, cli) = (new_program("marfa-server"), new_program("marfa"));
    let packed = raw_archive(&[
        ("../marfa", Regular, "", "evil"),
        ("../../escaped", Regular, "", "evil"),
        (outside, Regular, "", "evil"),
        ("nested/marfa-server", Regular, "", "evil"),
        ("marfa-server", Regular, "", &server),
        ("marfa", Regular, "", &cli),
    ]);
    case.run(case.release_of(packed, None, None)).await.unwrap();
    assert_eq!(
        case.text("marfa"),
        cli,
        "the witness: the real entries were used"
    );
    assert_eq!(
        fs::read_to_string(previous_of(&case.bin(), "marfa")).unwrap(),
        program("marfa", "0.0.74", OPENS),
        "nothing replaced the running program before the swap"
    );
    assert!(!Path::new(outside).exists());
    assert!(!case.root.join("marfa").exists());
    assert!(!case.bin().join("nested").exists());

    for (kind, link) in [(Symlink, "/etc/passwd"), (Link, "marfa")] {
        let case = Case::new("hostile-link");
        let packed = raw_archive(&[
            ("marfa-server", kind, link, ""),
            ("marfa", Regular, "", &cli),
        ]);
        let refused = case.run(case.release_of(packed, None, None)).await;
        assert!(
            refused.unwrap_err().contains("holds no marfa-server"),
            "{kind:?}"
        );
        case.untouched();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_archive_that_holds_a_program_twice_is_refused() {
    use tar::EntryType::Regular;
    let case = Case::new("twice");
    let (server, cli) = (new_program("marfa-server"), new_program("marfa"));
    let packed = raw_archive(&[
        ("marfa-server", Regular, "", &server),
        ("marfa", Regular, "", &cli),
        ("./marfa-server", Regular, "", &server),
    ]);
    let refused = case.run(case.release_of(packed, None, None)).await;
    assert!(refused.unwrap_err().contains("more than once"));
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_swap_that_fails_on_the_second_program_puts_both_back_and_replaces_a_copy_left_earlier() {
    let case = Case::new("undo");
    let staging = case.bin().join(".staging");
    fs::create_dir(&staging).unwrap();
    fs::write(staging.join("marfa-server"), new_program("marfa-server")).unwrap();
    let job = case.release(&good(OPENS), None, None);
    let failed = apply::swap(&staging, &job, Some(1)).unwrap_err();
    assert!(failed.contains("placing the new program"), "{failed}");
    let _ = fs::remove_dir_all(&staging);
    case.untouched();

    fs::create_dir(&staging).unwrap();
    for name in PROGRAMS {
        fs::write(staging.join(name), new_program(name)).unwrap();
    }
    let stale = previous_of(&case.bin(), "marfa");
    fs::write(&stale, "left by an earlier run").unwrap();
    apply::swap(&staging, &job, Some(1)).unwrap();
    for name in PROGRAMS {
        assert_eq!(case.text(name), new_program(name), "{name}");
        assert_eq!(
            fs::read_to_string(previous_of(&case.bin(), name)).unwrap(),
            program(name, "0.0.74", OPENS),
            "the witness: a copy left earlier is replaced by the running program"
        );
    }
}
