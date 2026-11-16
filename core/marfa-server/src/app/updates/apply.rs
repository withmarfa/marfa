//! Fetches a release, checks it against the release's checksums, asks the new program whether it
//! opens this database, and only then swaps the programs, keeping the old ones to put back.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use serde::Deserialize;
use url::Url;

use super::feed::Feed;
use super::pending::{self, Folder, PROGRAMS, Pending};
use super::release::Asset;
use crate::db::volume;

const MAX_ARCHIVE_BYTES: u64 = 512 << 20;
const MAX_CHECKSUMS_BYTES: u64 = 64 << 10;
const MAX_PROGRAM_BYTES: u64 = 512 << 20;
const DOWNLOAD_TIME: Duration = Duration::from_secs(20 * 60);
const RUN_TIME: Duration = Duration::from_secs(20);
/// What unpacking needs beyond the archive's own size: the programs and the swap's copies.
const ROOM_FACTOR: u64 = 4;
const ROOM_MARGIN: u64 = 64 << 20;

pub struct Job {
    pub from: String,
    pub version: String,
    pub archive_name: String,
    pub archive: Asset,
    pub checksums: Asset,
    pub programs: PathBuf,
    pub database: PathBuf,
    pub record: Folder,
}

/// The stages the owner can watch, in order.
pub const FETCHING: &str = "fetching";
pub const CHECKING: &str = "checking";
pub const SWAPPING: &str = "swapping";

fn address(asset: &Asset) -> Result<Url, String> {
    Url::parse(&asset.url)
        .map_err(|_| "The release names a download address that does not read.".to_string())
}

/// The checksum the release's file gives `name`, which it must give exactly once.
fn expected(sums: &str, name: &str) -> Result<String, String> {
    let mut found = sums.lines().filter_map(|line| {
        let mut words = line.split_whitespace();
        let (hash, file) = (words.next()?, words.next()?);
        (file.trim_start_matches('*') == name && words.next().is_none())
            .then(|| hash.to_ascii_lowercase())
    });
    match (found.next(), found.next()) {
        (Some(hash), None) => Ok(hash),
        (None, _) => Err(format!("The release's checksums have no line for {name}.")),
        (Some(_), Some(_)) => Err(format!(
            "The release's checksums name {name} more than once."
        )),
    }
}

fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let unreadable =
        |error: &dyn std::fmt::Display| format!("The archive could not be unpacked: {error}");
    let mut tar = tar::Archive::new(GzDecoder::new(
        File::open(archive).map_err(|e| unreadable(&e))?,
    ));
    let mut found = [false; PROGRAMS.len()];
    for entry in tar.entries().map_err(|e| unreadable(&e))? {
        let mut entry = entry.map_err(|e| unreadable(&e))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|e| unreadable(&e))?.into_owned();
        let name = path.strip_prefix("./").unwrap_or(&path);
        let Some(at) = PROGRAMS
            .iter()
            .position(|program| Path::new(program) == name)
        else {
            continue;
        };
        if entry.size() > MAX_PROGRAM_BYTES {
            return Err(format!(
                "{} in the archive is larger than a program is.",
                PROGRAMS[at]
            ));
        }
        let to = into.join(PROGRAMS[at]);
        entry.unpack(&to).map_err(|e| unreadable(&e))?;
        set_executable(&to).map_err(|e| unreadable(&e))?;
        found[at] = true;
    }
    match PROGRAMS.iter().zip(found).find(|(_, held)| !held) {
        Some((program, _)) => Err(format!("The archive holds no {program}.")),
        None => Ok(()),
    }
}

fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

struct Ran {
    status: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs a program of the release and gives it `RUN_TIME`.
fn run_within(program: &Path, arguments: &[&std::ffi::OsStr]) -> Result<Ran, std::io::Error> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let began = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if began.elapsed() > RUN_TIME {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "it did not answer in time",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let text = |from: Option<&mut dyn Read>| {
        let mut text = String::new();
        if let Some(from) = from {
            let _ = from.take(64 << 10).read_to_string(&mut text);
        }
        text
    };
    let stdout = text(child.stdout.as_mut().map(|out| out as &mut dyn Read));
    let stderr = text(child.stderr.as_mut().map(|err| err as &mut dyn Read));
    Ok(Ran {
        status,
        stdout,
        stderr,
    })
}

#[derive(Deserialize)]
struct Said {
    schema: Option<u32>,
}

/// Each program says which release it is, and the new server says whether it opens the database.
/// Returns the schema version the database holds.
fn prove(staging: &Path, job: &Job) -> Result<Option<u32>, String> {
    for name in PROGRAMS {
        let reported = run_within(&staging.join(name), &["--version".as_ref()])
            .ok()
            .filter(|ran| ran.status == Some(0))
            .ok_or_else(|| format!("The downloaded {name} does not run on this machine."))?;
        let wanted = format!("{name} {}", job.version);
        if reported.stdout.trim() != wanted {
            return Err(format!(
                "The downloaded {name} reports '{}', not '{wanted}'.",
                reported.stdout.trim()
            ));
        }
    }
    let asked = run_within(
        &staging.join("marfa-server"),
        &["--can-open".as_ref(), job.database.as_os_str()],
    )
    .map_err(|error| {
        format!(
            "Release {} could not be asked about the database: {error}.",
            job.version
        )
    })?;
    match asked.status {
        Some(0) => Ok(serde_json::from_str::<Said>(asked.stdout.trim())
            .map_err(|_| {
                format!(
                    "Release {} answered about the database in words this server cannot read.",
                    job.version
                )
            })?
            .schema),
        Some(78) => Err(format!(
            "Release {} will not open this server's database, so nothing was changed. {}",
            job.version,
            asked.stderr.trim()
        )),
        _ => Err(format!(
            "Release {} could not say whether it opens this server's database: {}",
            job.version,
            asked.stderr.trim()
        )),
    }
}

/// Renames each program aside and the new one into its place, undoing what was done when any
/// step fails. The record of the swap is kept first, so a stop part-way leaves it findable.
fn swap(staging: &Path, job: &Job, schema: Option<u32>) -> Result<(), String> {
    let pending = Pending {
        from: job.from.clone(),
        to: job.version.clone(),
        schema,
        starts: 0,
        programs: job.programs.clone(),
    };
    job.record
        .keep_pending(&pending)
        .map_err(|error| format!("The update's record could not be kept: {error}."))?;
    let mut aside: Vec<&str> = Vec::new();
    let undo = |aside: &[&str], what: &str, error: std::io::Error| {
        for name in aside.iter().rev() {
            let _ = fs::rename(
                pending::previous_of(&job.programs, name),
                job.programs.join(name),
            );
        }
        job.record.clear_pending();
        format!(
            "The programs could not be swapped ({what}: {error}), so the running release stays."
        )
    };
    for name in PROGRAMS {
        let (live, kept) = (
            job.programs.join(name),
            pending::previous_of(&job.programs, name),
        );
        match fs::remove_file(&kept) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(undo(&aside, "clearing the last copy", error));
            }
            _ => {}
        }
        fs::rename(&live, &kept).map_err(|error| undo(&aside, "keeping the old program", error))?;
        aside.push(name);
        fs::rename(staging.join(name), &live)
            .map_err(|error| undo(&aside, "placing the new program", error))?;
    }
    let _ = File::open(&job.programs).and_then(|folder| folder.sync_all());
    Ok(())
}

/// Blocks. On `Ok` the new programs are in place and the server should end for its service to
/// start them; on `Err` the running release is as it was.
pub fn run(feed: &Feed, job: &Job, stage: &dyn Fn(&'static str)) -> Result<(), String> {
    let staging = job.programs.join(format!(".marfa-update-{}", job.version));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir(&staging).map_err(|error| {
        format!(
            "A folder to unpack release {} in could not be made beside the programs: {error}.",
            job.version
        )
    })?;
    let done = prepare(feed, job, &staging, stage).and_then(|schema| {
        stage(SWAPPING);
        swap(&staging, job, schema)
    });
    let _ = fs::remove_dir_all(&staging);
    done
}

fn prepare(
    feed: &Feed,
    job: &Job,
    staging: &Path,
    stage: &dyn Fn(&'static str),
) -> Result<Option<u32>, String> {
    let needed = job
        .archive
        .bytes
        .saturating_mul(ROOM_FACTOR)
        .saturating_add(ROOM_MARGIN);
    if let Some(free) = volume::free_bytes(&job.programs)
        && free < needed
    {
        return Err(format!(
            "There is not enough room beside the programs to unpack release {}: it needs about {needed} bytes and {free} are free.",
            job.version
        ));
    }
    if job.archive.bytes > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "Release {}'s archive is larger than a release's is.",
            job.version
        ));
    }
    stage(FETCHING);
    let archive = staging.join("archive.tar.gz");
    let sums = feed
        .document(
            &address(&job.checksums)?,
            MAX_CHECKSUMS_BYTES,
            Duration::from_secs(60),
        )
        .map_err(|failed| {
            format!(
                "The release's checksums could not be fetched: {}.",
                failed.words()
            )
        })?;
    let downloaded = feed
        .file(
            &address(&job.archive)?,
            &archive,
            job.archive.bytes,
            DOWNLOAD_TIME,
        )
        .map_err(|failed| {
            format!(
                "Release {} could not be downloaded: {}.",
                job.version,
                failed.words()
            )
        })?;
    stage(CHECKING);
    let sums =
        String::from_utf8(sums).map_err(|_| "The release's checksums are not text.".to_string())?;
    if expected(&sums, &job.archive_name)? != downloaded {
        return Err(format!(
            "The download of release {} does not match the release's checksum, so it was not used.",
            job.version
        ));
    }
    unpack(&archive, staging)?;
    prove(staging, job)
}
