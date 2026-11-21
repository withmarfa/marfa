//! Fetches a release, checks it, and swaps its programs in, keeping the old ones.

use std::fs::{self, File};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use marfa_rules::update_record::Ran;

use flate2::read::GzDecoder;
use serde::Deserialize;
use url::Url;

use super::feed::{Feed, RELEASE_HOSTS};
use super::pending::{
    self, ASK_LIMIT, CONNECTOR, Folder, MARFA, PROGRAMS, Pending, SERVER, run_within, sync_folder,
};
use super::release::{self, Asset};
use crate::db::volume;

const MAX_ARCHIVE_BYTES: u64 = 512 << 20;
const MAX_CHECKSUMS_BYTES: u64 = 64 << 10;
const MAX_PROGRAM_BYTES: u64 = 512 << 20;
const DOWNLOAD_TIME: Duration = Duration::from_secs(20 * 60);
/// The room unpacking needs, as a multiple of the archive's size and a margin.
const ROOM_FACTOR: u64 = 4;
const ROOM_MARGIN: u64 = 64 << 20;

pub struct Job {
    pub from: String,
    pub version: String,
    pub archive_name: String,
    pub archive: Asset,
    pub checksums: Asset,
    pub programs: PathBuf,
    /// The install folder `marfa server run --dir` named.
    pub dir: PathBuf,
    pub database: PathBuf,
    pub record: Folder,
    /// Tells this swap's outcome from that of an earlier swap to the same release.
    pub attempt: String,
}

pub const FETCHING: &str = "fetching";
pub const CHECKING: &str = "checking";
pub const SWAPPING: &str = "swapping";

/// What staging folders are called, each followed by its release.
const STAGING: &str = ".marfa-update-";

/// The file's one address on Marfa's releases, which the release must have named.
fn address(feed: &Feed, version: &str, name: &str, asset: &Asset) -> Result<Url, String> {
    let wanted = release::download_url(&feed.downloads(), version, name);
    if asset.url != wanted {
        return Err(format!(
            "The release names {name} at an address that is not Marfa's own, so nothing was fetched."
        ));
    }
    Url::parse(&wanted)
        .map_err(|_| "The release names a download address that does not read.".to_string())
}

/// The checksum the release's file gives `name`, exactly once.
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

/// Unpacks the programs, and the connector where the release holds one.
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let unreadable =
        |error: &dyn std::fmt::Display| format!("The archive could not be unpacked: {error}");
    let wanted: [&str; PROGRAMS.len() + 1] = [PROGRAMS[0], PROGRAMS[1], CONNECTOR];
    let mut tar = tar::Archive::new(GzDecoder::new(
        File::open(archive).map_err(|e| unreadable(&e))?,
    ));
    let mut found = [false; PROGRAMS.len() + 1];
    for entry in tar.entries().map_err(|e| unreadable(&e))? {
        let mut entry = entry.map_err(|e| unreadable(&e))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|e| unreadable(&e))?.into_owned();
        let name = path.strip_prefix("./").unwrap_or(&path);
        let Some(at) = wanted.iter().position(|program| Path::new(program) == name) else {
            continue;
        };
        if entry.size() > MAX_PROGRAM_BYTES {
            return Err(format!(
                "{} in the archive is larger than a program is.",
                wanted[at]
            ));
        }
        if found[at] {
            return Err(format!("The archive holds {} more than once.", wanted[at]));
        }
        let to = into.join(wanted[at]);
        entry.unpack(&to).map_err(|e| unreadable(&e))?;
        set_executable(&to).map_err(|e| unreadable(&e))?;
        // Unsynced bytes renamed into place can be damaged by a power loss.
        File::open(&to)
            .and_then(|program| program.sync_all())
            .map_err(|e| unreadable(&e))?;
        found[at] = true;
    }
    if let Some((program, _)) = PROGRAMS.iter().zip(found).find(|(_, held)| !held) {
        return Err(format!("The archive holds no {program}."));
    }
    sync_folder(into).map_err(|e| unreadable(&e))
}

fn set_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

/// Runs a program of the release with `arguments`, for at most [`ASK_LIMIT`].
pub(super) fn ask(program: &Path, arguments: &[&std::ffi::OsStr]) -> std::io::Result<Ran> {
    let mut command = Command::new(program);
    command.args(arguments);
    run_within(command, ASK_LIMIT)
}

#[derive(Deserialize)]
struct Said {
    schema: Option<u32>,
}

/// Proves each program and asks the new server about the database; gives its schema version.
fn prove(staging: &Path, job: &Job) -> Result<Option<u32>, String> {
    for name in PROGRAMS {
        let reported = ask(&staging.join(name), &["--version".as_ref()])
            .ok()
            .filter(|ran| ran.status.success())
            .ok_or_else(|| format!("The downloaded {name} does not run on this machine."))?;
        let wanted = format!("{name} {}", job.version);
        if reported.stdout.trim() != wanted {
            return Err(format!(
                "The downloaded {name} reports '{}', not '{wanted}'.",
                reported.stdout.trim()
            ));
        }
    }
    // Cloudflare's own release number, so only what it is and that it runs here are checked.
    if staging.join(CONNECTOR).is_file() {
        let reported = ask(&staging.join(CONNECTOR), &["--version".as_ref()])
            .ok()
            .filter(|ran| ran.status.success())
            .ok_or_else(|| format!("The downloaded {CONNECTOR} does not run on this machine."))?;
        if !reported
            .stdout
            .trim()
            .starts_with(&format!("{CONNECTOR} version "))
        {
            return Err(format!(
                "The downloaded {CONNECTOR} reports '{}', not a {CONNECTOR} version.",
                reported.stdout.trim()
            ));
        }
    }
    let checked = ask(
        &staging.join(MARFA),
        &[
            "server".as_ref(),
            "run".as_ref(),
            "--dir".as_ref(),
            job.dir.as_os_str(),
            "--check".as_ref(),
        ],
    )
    .map_err(|error| format!("The downloaded marfa could not check this install: {error}."))?;
    if !checked.status.success() {
        return Err(format!(
            "The downloaded marfa will not run this install, so nothing was changed. {}",
            checked.stderr.trim()
        ));
    }
    let asked = ask(
        &staging.join(SERVER),
        &["--can-open".as_ref(), job.database.as_os_str()],
    )
    .map_err(|error| {
        format!(
            "Release {} could not be asked about the database: {error}.",
            job.version
        )
    })?;
    match asked.status.code() {
        Some(0) => Ok(serde_json::from_str::<Said>(asked.stdout.trim())
            .map_err(|_| {
                format!(
                    "Release {} answered about the database in words this server cannot read.",
                    job.version
                )
            })?
            .schema),
        Some(78) => Err(format!(
            "Release {} will not run on this server's settings and database, so nothing was changed. {}",
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

/// Puts in only the new `marfa-server`, keeping the old one beside it, and stages the new
/// `marfa` as `.marfa.next`: the running release's `marfa server run` supervises the new server
/// until it settles. Replaces the connector last, and a put-back leaves the new one. Undoes what
/// it did when a step fails.
pub(super) fn swap(staging: &Path, job: &Job, schema: Option<u32>) -> Result<(), String> {
    let pending = Pending {
        from: job.from.clone(),
        to: job.version.clone(),
        schema,
        starts: 0,
        programs: job.programs.clone(),
        attempt: Some(job.attempt.clone()),
        limit_ended: None,
    };
    job.record
        .keep_pending(&pending)
        .map_err(|error| format!("The update's record could not be kept: {error}."))?;
    let (live, kept, next) = (
        job.programs.join(SERVER),
        pending::previous_of(&job.programs, SERVER),
        pending::next_marfa(&job.programs),
    );
    let undo = |what: &str, error: std::io::Error, server_kept: bool| {
        let _ = fs::remove_file(&next);
        if server_kept {
            // A server still in place shares its inode with the copy, and renaming one link
            // onto another does nothing.
            let _ = fs::rename(&kept, &live);
            let _ = fs::remove_file(&kept);
        }
        let _ = job.record.clear_pending();
        format!(
            "The programs could not be swapped ({what}: {error}), so the running release stays."
        )
    };
    fs::rename(staging.join(MARFA), &next)
        .map_err(|error| undo("staging the new marfa", error, false))?;
    pending::keep_aside(&live, &kept, |from, to| fs::hard_link(from, to))
        .map_err(|error| undo("keeping the old program", error, false))?;
    fs::rename(staging.join(SERVER), &live)
        .map_err(|error| undo("placing the new program", error, true))?;
    let connector = staging.join(CONNECTOR);
    if connector.is_file() {
        fs::rename(&connector, job.programs.join(CONNECTOR))
            .map_err(|error| undo("placing the new connector", error, true))?;
    }
    let _ = sync_folder(&job.programs);
    Ok(())
}

/// The lock held from unpacking to the swap: one update at a time moves these programs, and
/// none while another has swapped them and not settled.
pub(super) fn claim(job: &Job) -> Result<File, String> {
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(job.programs.join(pending::LOCK))
        .map_err(|error| {
            format!(
                "A lock for the update could not be made beside the programs in {}: {error}.",
                job.programs.display()
            )
        })?;
    if lock.try_lock().is_err() {
        return Err(format!(
            "Another update of the programs in {} is under way.",
            job.programs.display()
        ));
    }
    match job.record.pending() {
        Ok(None) => {}
        Ok(Some(pending)) => {
            return Err(format!(
                "The update to release {} has not settled yet.",
                pending.to
            ));
        }
        Err(error) => return Err(format!("The update's record could not be read: {error}.")),
    }
    let next = pending::next_marfa(&job.programs);
    if next.exists() {
        return Err(format!(
            "Another server using the programs in {} has swapped in a release that has not settled. If no server using them is updating, remove {}.",
            job.programs.display(),
            next.display()
        ));
    }
    Ok(lock)
}

/// Removes the folders earlier updates left beside the programs, whatever release each was for.
/// A link or a file under such a name is left alone.
pub(super) fn clear_staging(programs: &Path) -> Result<(), String> {
    let unreadable = |error: std::io::Error| {
        format!("The folder holding the programs could not be read: {error}.")
    };
    for entry in fs::read_dir(programs).map_err(unreadable)? {
        let name = entry.map_err(unreadable)?.file_name();
        if !name.to_str().is_some_and(|name| name.starts_with(STAGING)) {
            continue;
        }
        let left = programs.join(&name);
        let is_folder = fs::symlink_metadata(&left).is_ok_and(|met| met.file_type().is_dir());
        if !is_folder {
            continue;
        }
        fs::remove_dir_all(&left).map_err(|error| {
            format!(
                "A folder an earlier update left beside the programs, {}, could not be removed: {error}.",
                name.to_string_lossy()
            )
        })?;
    }
    Ok(())
}

/// Blocks, and runs only while the update holds `Updates::begin`. On `Ok` the new programs are in
/// place; on `Err` the running release is as it was.
pub fn run(feed: &Feed, job: &Job, stage: &dyn Fn(&'static str)) -> Result<(), String> {
    let _claim = claim(job)?;
    clear_staging(&job.programs)?;
    let staging = job.programs.join(format!("{STAGING}{}", job.version));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&staging)
        .map_err(|error| {
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
    let sums_name = release::checksums_name(&job.version);
    let sums_at = address(feed, &job.version, &sums_name, &job.checksums)?;
    let archive_at = address(feed, &job.version, &job.archive_name, &job.archive)?;
    let sums = feed
        .document(
            &sums_at,
            MAX_CHECKSUMS_BYTES,
            Duration::from_secs(60),
            &RELEASE_HOSTS,
        )
        .map_err(|failed| {
            format!(
                "The release's checksums could not be fetched: {}.",
                failed.words()
            )
        })?;
    let downloaded = feed
        .file(&archive_at, &archive, job.archive.bytes, DOWNLOAD_TIME)
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
