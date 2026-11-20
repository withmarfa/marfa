//! The swap, run for real on folders of its own against a local stand-in for GitHub's downloads,
//! and the start of an update on the writer.

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
use super::pending::{self, Folder, MARFA, PROGRAMS, Pending, SERVER, next_marfa, previous_of};
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
    program_checking(name, version, can_open, CHECKS)
}

/// `check` is what `marfa server run --dir <dir> --check` does.
fn program_checking(name: &str, version: &str, can_open: &str, check: &str) -> String {
    format!(
        "#!/bin/sh\ncase \"$1\" in\n--version) echo \"{name} {version}\";;\n--can-open) {can_open};;\nserver) {check};;\nesac\n"
    )
}

/// Passes only when asked exactly as the swap asks, about a folder that exists.
const CHECKS: &str = "[ \"$2 $3 $5\" = 'run --dir --check' ] && [ -d \"$4\" ] || { echo \"asked: $*\" >&2; exit 9; }";

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

const SUMS: &str = "/withmarfa/marfa/releases/download/v0.0.75/marfa-0.0.75-checksums.txt";

fn archive_path() -> String {
    format!(
        "/withmarfa/marfa/releases/download/v0.0.75/{}",
        archive_name("0.0.75", "linux-x86_64")
    )
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
        let stand = Stand::start();
        let faults = Arc::new(Faults::default());
        faults
            .set("release-feed", Some(&stand.url("/latest")))
            .unwrap();
        Case {
            root,
            stand,
            faults,
        }
    }

    fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }

    fn record(&self) -> Folder {
        Folder::beside(&self.root.join("data/marfa.db"))
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
        self.stand.serve(&archive_path(), packed);
        self.stand.serve(SUMS, line.into_bytes());
        Job {
            from: "0.0.74".into(),
            version: "0.0.75".into(),
            archive_name: name,
            archive: Asset {
                url: self.stand.url(&archive_path()),
                bytes: claimed,
            },
            checksums: Asset {
                url: self.stand.url(SUMS),
                bytes: 100,
            },
            programs: self.bin(),
            database: self.root.join("data/marfa.db"),
            record: self.record(),
            dir: self.root.clone(),
            attempt: "attempt".into(),
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
        assert!(!next_marfa(&self.bin()).exists());
        assert_eq!(self.record().pending().unwrap(), None);
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
async fn a_release_that_checks_out_swaps_in_its_server_and_stages_its_marfa() {
    let case = Case::new("swaps");
    let job = case.release(&good(OPENS), None, None);
    case.run(job).await.unwrap();
    assert_eq!(case.text(SERVER), new_program(SERVER));
    assert_eq!(
        fs::read_to_string(previous_of(&case.bin(), SERVER)).unwrap(),
        program(SERVER, "0.0.74", OPENS),
        "the old server is kept to put back"
    );
    assert_eq!(
        case.text(MARFA),
        program(MARFA, "0.0.74", OPENS),
        "the running release's marfa stays to supervise the new server"
    );
    assert_eq!(
        fs::read_to_string(next_marfa(&case.bin())).unwrap(),
        new_program(MARFA)
    );
    assert!(!previous_of(&case.bin(), MARFA).exists());
    let pending = case.record().pending().unwrap().unwrap();
    assert_eq!(
        (pending.from.as_str(), pending.to.as_str()),
        ("0.0.74", "0.0.75")
    );
    assert_eq!((pending.schema, pending.starts), (Some(1), 0));
    assert_eq!(pending.attempt.as_deref(), Some("attempt"));
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
        .serve(SUMS, b"abc  marfa-0.0.75-other.tar.gz\n".to_vec());
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("no line"), "{refused}");
    let job = case.release(&good(OPENS), None, None);
    let line = format!("{}  {name}\n", "1".repeat(64));
    case.stand.serve(SUMS, format!("{line}{line}").into_bytes());
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
    let job = case.release(&good(OPENS), None, None);
    case.stand.routes.lock().unwrap().remove(&archive_path());
    let refused = case.run(job).await.unwrap_err();
    assert!(refused.contains("404"), "{refused}");
    case.untouched();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_kept_at_an_address_but_marfas_own_is_never_fetched() {
    let case = Case::new("elsewhere");
    for elsewhere in [
        "/other/marfa/releases/download/v0.0.75/NAME",
        "/withmarfa/other/releases/download/v0.0.75/NAME",
        "/withmarfa/marfa/releases/download/v0.0.74/NAME",
        "/withmarfa/marfa/releases/download/v0.0.75/marfa-0.0.75-darwin-arm64.tar.gz",
    ] {
        for checksums in [false, true] {
            let mut job = case.release(&good(OPENS), None, None);
            let asset = if checksums {
                &mut job.checksums
            } else {
                &mut job.archive
            };
            let name = asset.url.rsplit('/').next().unwrap().to_string();
            let path = elsewhere.replace("NAME", &name);
            case.stand.serve(&path, b"elsewhere".to_vec());
            asset.url = case.stand.url(&path);
            let before = case.stand.asked();
            let refused = case.run(job).await.unwrap_err();
            assert!(refused.contains("not Marfa's own"), "{path}: {refused}");
            assert_eq!(case.stand.asked(), before, "{path}: nothing was asked");
            case.untouched();
        }
    }
    let before = case.stand.asked();
    case.run(case.release(&good(OPENS), None, None))
        .await
        .unwrap();
    assert!(
        case.stand.asked() > before,
        "the witness: at Marfa's own address the same release is fetched"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn staging_folders_left_by_earlier_updates_go_and_links_or_files_under_that_name_stay() {
    use std::os::unix::fs::symlink;
    let case = Case::new("leftovers");
    let outside = case.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("kept"), "not the server's").unwrap();
    for version in ["0.0.73", "0.0.75", "0.0.76"] {
        let left = case.bin().join(format!(".marfa-update-{version}"));
        fs::create_dir_all(left.join("nested")).unwrap();
        fs::write(left.join("archive.tar.gz"), "left over").unwrap();
        symlink(&outside, left.join("nested/out")).unwrap();
    }
    symlink(&outside, case.bin().join(".marfa-update-0.0.1")).unwrap();
    fs::write(case.bin().join(".marfa-update-notes"), "a file").unwrap();
    fs::create_dir(case.bin().join(".marfa-other")).unwrap();

    case.run(case.release(&good(OPENS), None, None))
        .await
        .unwrap();
    for version in ["0.0.73", "0.0.75", "0.0.76"] {
        assert!(
            !case.bin().join(format!(".marfa-update-{version}")).exists(),
            "{version}"
        );
    }
    assert!(case.bin().join(".marfa-update-0.0.1").is_symlink());
    assert!(case.bin().join(".marfa-update-notes").is_file());
    assert!(case.bin().join(".marfa-other").is_dir());
    assert_eq!(
        fs::read_to_string(outside.join("kept")).unwrap(),
        "not the server's"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_link_under_the_releases_own_staging_name_refuses_the_update_and_is_not_followed() {
    use std::os::unix::fs::symlink;
    let case = Case::new("staging-link");
    let outside = case.root.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, case.bin().join(".marfa-update-0.0.75")).unwrap();
    let refused = case.run(case.release(&good(OPENS), None, None)).await;
    assert!(refused.unwrap_err().contains("beside the programs"));
    assert!(case.bin().join(".marfa-update-0.0.75").is_symlink());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    for name in PROGRAMS {
        assert_eq!(case.text(name), program(name, "0.0.74", OPENS), "{name}");
    }
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
    // SAFETY: `geteuid` takes no arguments and cannot fail.
    let superuser = unsafe { libc::geteuid() } == 0;
    if !superuser {
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
    pending::keep_aside(&live, &kept, refused).unwrap();
    assert_eq!(fs::read(&kept).unwrap(), fs::read(&live).unwrap());
    assert_eq!(
        fs::metadata(&kept).unwrap().permissions().mode() & 0o777,
        0o755
    );
    fs::remove_file(&kept).unwrap();
    assert!(
        pending::keep_aside(&case.bin().join("absent"), &kept, refused).is_err(),
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
        fs::read_to_string(next_marfa(&case.bin())).unwrap(),
        cli,
        "the witness: the real entries were used"
    );
    assert_eq!(
        case.text("marfa"),
        program("marfa", "0.0.74", OPENS),
        "nothing replaced the running program"
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

#[test]
fn a_swap_that_fails_part_way_puts_the_old_server_back_and_replaces_a_copy_left_earlier() {
    let case = Case::new("undo");
    let job = case.release(&good(OPENS), None, None);
    let staging = case.bin().join(".staging");
    for (missing, said) in [
        (MARFA, "staging the new marfa"),
        (SERVER, "placing the new program"),
    ] {
        fs::create_dir(&staging).unwrap();
        for name in PROGRAMS.iter().filter(|name| **name != missing) {
            fs::write(staging.join(name), new_program(name)).unwrap();
        }
        let failed = apply::swap(&staging, &job, Some(1)).unwrap_err();
        assert!(failed.contains(said), "{failed}");
        fs::remove_dir_all(&staging).unwrap();
        case.untouched();
    }

    fs::create_dir(&staging).unwrap();
    for name in PROGRAMS {
        fs::write(staging.join(name), new_program(name)).unwrap();
    }
    let stale = previous_of(&case.bin(), SERVER);
    fs::write(&stale, "left by an earlier run").unwrap();
    apply::swap(&staging, &job, Some(1)).unwrap();
    assert_eq!(case.text(SERVER), new_program(SERVER));
    assert_eq!(
        fs::read_to_string(&stale).unwrap(),
        program(SERVER, "0.0.74", OPENS),
        "the witness: a copy left earlier is replaced by the running program"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_whose_marfa_will_not_run_this_install_is_not_swapped_in() {
    let case = Case::new("check");
    let mut files = good(OPENS);
    files[0].1 = program_checking(
        MARFA,
        "0.0.75",
        OPENS,
        "echo 'this install is not one I can run' >&2; exit 1",
    );
    let refused = case
        .run(case.release(&files, None, None))
        .await
        .unwrap_err();
    assert!(
        refused.contains("will not run this install")
            && refused.contains("this install is not one I can run"),
        "{refused}"
    );
    case.untouched();
    case.run(case.release(&good(OPENS), None, None))
        .await
        .unwrap();
    assert!(
        next_marfa(&case.bin()).exists(),
        "the witness: a marfa that checks out is staged"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn no_update_starts_while_another_holds_or_has_not_settled_the_programs() {
    let case = Case::new("claimed");
    let job = case.release(&good(OPENS), None, None);
    let held = apply::claim(&job).unwrap();
    let refused = case
        .run(case.release(&good(OPENS), None, None))
        .await
        .unwrap_err();
    assert!(refused.contains("under way"), "{refused}");
    drop(held);

    case.record()
        .keep_pending(&Pending {
            from: "0.0.73".into(),
            to: "0.0.74".into(),
            schema: Some(1),
            starts: 1,
            programs: case.bin(),
            attempt: None,
            limit_ended: None,
        })
        .unwrap();
    let refused = case
        .run(case.release(&good(OPENS), None, None))
        .await
        .unwrap_err();
    assert!(refused.contains("0.0.74 has not settled"), "{refused}");
    case.record().clear_pending().unwrap();

    fs::write(next_marfa(&case.bin()), "another server's swap").unwrap();
    let refused = case
        .run(case.release(&good(OPENS), None, None))
        .await
        .unwrap_err();
    assert!(refused.contains(".marfa.next"), "{refused}");
    fs::remove_file(next_marfa(&case.bin())).unwrap();

    case.run(job).await.unwrap();
    assert_eq!(
        case.text(SERVER),
        new_program(SERVER),
        "the witness: with nothing in the way the same update runs"
    );
}

#[test]
fn clearing_staging_keeps_the_staged_marfa_and_the_updates_lock() {
    let case = Case::new("clear-keeps");
    fs::write(next_marfa(&case.bin()), "the staged marfa").unwrap();
    fs::write(case.bin().join(pending::LOCK), "").unwrap();
    let left = case.bin().join(".marfa-update-0.0.73");
    fs::create_dir(&left).unwrap();

    apply::clear_staging(&case.bin()).unwrap();
    assert!(
        !left.exists(),
        "the witness: a leftover staging folder goes"
    );
    assert_eq!(
        fs::read_to_string(next_marfa(&case.bin())).unwrap(),
        "the staged marfa"
    );
    assert!(case.bin().join(pending::LOCK).is_file());
}

#[tokio::test(flavor = "multi_thread")]
async fn work_the_writer_begins_runs_after_the_request_that_asked_for_it_is_gone() {
    use crate::db::{Db, Lock, Options, Write, migrate::MIGRATIONS};
    use std::time::Duration;

    let options = Options {
        path: DatabasePath::Memory,
        write_wait: Duration::from_secs(5),
        readers: 1,
        migrations: MIGRATIONS,
        reserve: 0,
        upgrade_marks: None,
    };
    let lock = Lock::take(&options.path).map_err(|f| f.message).unwrap();
    let db = Arc::new(
        Db::open(&options, lock, Arc::default())
            .map_err(|f| f.message)
            .unwrap(),
    );

    let (entered, busy) = std::sync::mpsc::channel();
    let (let_go, held) = std::sync::mpsc::channel::<()>();
    let mut long = Box::pin(db.write(Write::own(), move |_| {
        entered.send(()).unwrap();
        held.recv().unwrap();
        Ok(())
    }));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut long)
            .await
            .is_err()
    );
    busy.recv_timeout(Duration::from_secs(5)).unwrap();

    let (ran, done) = tokio::sync::oneshot::channel();
    let mut asking = Box::pin(super::begin_on_writer(
        db.clone(),
        |db: &Db| db,
        |_: &Db| {},
        move |_, _| {
            Ok(Ok::<_, ()>(Some(async move {
                let _ = ran.send(());
            })))
        },
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut asking)
            .await
            .is_err(),
        "the start waits behind the long write"
    );
    drop(asking);
    let_go.send(()).unwrap();
    long.await.unwrap();

    tokio::time::timeout(Duration::from_secs(5), done)
        .await
        .expect("the begun work ran")
        .unwrap();
}

struct Starting {
    db: crate::db::Db,
    updates: Updates,
}

fn starting(
    migrations: &'static [crate::db::migrate::Migration],
    faults: Arc<Faults>,
) -> Arc<Starting> {
    use crate::db::{Db, Lock, Options};
    let options = Options {
        path: DatabasePath::Memory,
        write_wait: std::time::Duration::from_secs(5),
        readers: 1,
        migrations,
        reserve: 0,
        upgrade_marks: None,
    };
    let lock = Lock::take(&options.path).map_err(|f| f.message).unwrap();
    let db = Db::open(&options, lock, faults)
        .map_err(|f| f.message)
        .unwrap();
    Arc::new(Starting {
        db,
        updates: Updates::new(&DatabasePath::Memory),
    })
}

/// Begins the update and records its audit entry in the write, as `start_if` does.
async fn start_on(
    owner: &Arc<Starting>,
) -> crate::app::refusal::Result<std::result::Result<(), ()>> {
    let inside = owner.clone();
    super::begin_on_writer(
        owner.clone(),
        |owner: &Starting| &owner.db,
        |owner: &Starting| owner.updates.set(State::Idle),
        move |tx, begun| {
            if !inside.updates.begin("9.9.9") {
                return Ok(Ok(None));
            }
            begun.mark();
            crate::app::audit::record_from(
                tx,
                "2026-11-20T00:00:00.000Z",
                None,
                None,
                crate::app::audit::Entry {
                    action: super::UPDATE_STARTED,
                    resource_type: "instance",
                    resource_id: None,
                    details: None,
                },
            )?;
            Ok(Ok(Some(async {})))
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_start_whose_audit_entry_fails_puts_the_update_back_to_idle() {
    use crate::db::migrate::Migration;
    /// No `audit_log` table, so the start's audit entry fails.
    const NO_AUDIT_LOG: &[Migration] = &[Migration {
        version: 1,
        sql: "CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT;",
        done: None,
    }];
    let owner = starting(NO_AUDIT_LOG, Arc::default());

    assert!(start_on(&owner).await.is_err());
    assert_eq!(owner.updates.state(), State::Idle);
    assert!(
        start_on(&owner).await.is_err(),
        "a later start begins again rather than joining a start that never ran"
    );
    assert_eq!(owner.updates.state(), State::Idle);
}

#[cfg(feature = "test-hooks")]
#[tokio::test(flavor = "multi_thread")]
async fn a_start_whose_commit_fails_puts_the_update_back_to_idle() {
    let faults = Arc::new(Faults::default());
    let owner = starting(crate::db::migrate::MIGRATIONS, faults.clone());
    faults
        .set("fail:commit", Some(super::UPDATE_STARTED))
        .unwrap();

    assert!(start_on(&owner).await.is_err());
    assert_eq!(owner.updates.state(), State::Idle);

    faults.clear(Some("fail:commit"));
    assert_eq!(start_on(&owner).await.unwrap(), Ok(()));
    assert!(
        matches!(owner.updates.state(), State::Fetching { .. }),
        "a later start begins the update"
    );
}
