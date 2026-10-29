//! How much of the volume the file cache may take, and keeping it out of
//! backups.
//!
//! A person's files are fetched when opened and kept in a folder beside the
//! store (`device/blob-kept-beside`). The budget bounds that folder; a trim
//! (`blob::Cache::trim`) enforces it.

use std::fs::File;
use std::io;
use std::path::Path;

use serde::Serialize;

const GIB: u64 = 1024 * 1024 * 1024;

/// What the default budget is never below, and what stands where the volume
/// cannot be read.
pub const DEFAULT_FLOOR: u64 = 2 * GIB;

/// What the default budget is never below, however full the volume.
pub(crate) const DEFAULT_MINIMUM: u64 = 256 * 1024 * 1024;

/// The setting in the store's `meta` table; absent for the default.
pub(crate) const META_BUDGET: &str = "file_budget";
const KEEP_ALL: &str = "keep_all";

/// Why the last bytes fetched could not be kept out of backups; absent once
/// they could.
pub(crate) const META_BACKUP_UNMARKED: &str = "file_backup_unmarked";

/// How the cache's budget is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileBudget {
    /// The share of the volume the contract states (`device/file-budget-default`).
    Default,
    /// This many bytes.
    Bytes(u64),
    /// No budget: every file fetched stays.
    KeepAll,
}

impl FileBudget {
    pub(crate) fn stored(text: Option<&str>) -> FileBudget {
        match text {
            None => FileBudget::Default,
            Some(KEEP_ALL) => FileBudget::KeepAll,
            Some(digits) => digits
                .parse()
                .map_or(FileBudget::Default, FileBudget::Bytes),
        }
    }

    pub(crate) fn to_stored(self) -> Option<String> {
        match self {
            FileBudget::Default => None,
            FileBudget::Bytes(bytes) => Some(bytes.to_string()),
            FileBudget::KeepAll => Some(KEEP_ALL.into()),
        }
    }
}

/// The cache as the state report gives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileCache {
    /// What was chosen.
    pub setting: FileBudget,
    /// The budget in force, in bytes; `None` while every file fetched is
    /// kept.
    pub budget: Option<u64>,
    /// The bytes of the files kept now; `None` where the cache could not be
    /// read, and `held_unreadable` says why. A cache not made yet holds 0.
    pub held: Option<u64>,
    /// Why `held` is unknown: the cache's folder or an entry in it could not
    /// be read.
    pub held_unreadable: Option<String>,
    /// Whether the default budget is the floor because the volume holding
    /// the cache could not be read, or read as a size of zero.
    pub volume_unreadable: bool,
    /// Why the last bytes fetched could not be kept out of backups; `None`
    /// once they could, and off Apple platforms, where nothing is marked.
    pub backup_mark_failure: Option<String>,
    /// The files attached to items the copy holds, which stay on the device
    /// outside the budget; `None` from the start of a hydration until one
    /// completes, since the copy's rows have not all arrived, for a folder's
    /// copy, which holds its files in the folder, and where the cache could
    /// not be read.
    pub attachments: Option<Attachments>,
}

/// The files attached to items the copy holds (`device/attachment-kept`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Attachments {
    /// The file items whose bytes the cache holds whole.
    pub held: u64,
    /// The bytes of those files, counted once for files that share them.
    /// They are in `FileCache::held`, and not counted against the budget.
    pub held_bytes: u64,
    /// The bytes of partial files of attachments, which stay for a resume
    /// and are not counted against the budget either.
    pub partial_bytes: u64,
    /// The attachments whose bytes the cache does not hold whole.
    pub not_held: u64,
    /// The bytes those attachments state, counted once for files that share
    /// them; an attachment that states no size adds none.
    pub not_held_bytes: u64,
    /// The attachments not held, by why.
    pub not_held_by_reason: Vec<NotHeld>,
}

/// The attachments not held for one reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotHeld {
    pub reason: NotHeldReason,
    pub attachments: u64,
    /// The bytes they state, counted once for files that share them.
    pub bytes: u64,
    /// How many of them state no size, so add nothing to `bytes`.
    pub unstated: u64,
}

/// Why an attachment's bytes are not held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotHeldReason {
    /// No fetch of them has been asked for since they became an attachment.
    NotFetched,
    /// The volume had no room for them, or for an attachment before them in
    /// the same fetch.
    NoRoom,
    /// The server, or the link it gave, could not be reached, or the link
    /// stopped sending part way.
    Unreachable,
    /// The server asked the device to wait longer than a fetch of
    /// attachments waits, before this attachment or one before it.
    RateLimited,
    /// The server holds no bytes by that hash.
    Absent,
    /// The fetch failed otherwise: the link answered what does not continue
    /// or match the bytes, or the server answered what could not be read.
    Failed,
    /// The edge is held but its file item is not, since the slice holds
    /// `attached-to` edges whole and not the file's type, so the device
    /// does not know which bytes it names.
    NotInCopy,
}

impl NotHeldReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            NotHeldReason::NotFetched => "not_fetched",
            NotHeldReason::NoRoom => "no_room",
            NotHeldReason::Unreachable => "unreachable",
            NotHeldReason::RateLimited => "rate_limited",
            NotHeldReason::Absent => "absent",
            NotHeldReason::Failed => "failed",
            NotHeldReason::NotInCopy => "not_in_copy",
        }
    }

    pub(crate) fn stored(text: &str) -> NotHeldReason {
        match text {
            "no_room" => NotHeldReason::NoRoom,
            "unreachable" => NotHeldReason::Unreachable,
            "rate_limited" => NotHeldReason::RateLimited,
            "absent" => NotHeldReason::Absent,
            "failed" => NotHeldReason::Failed,
            _ => NotHeldReason::NotFetched,
        }
    }
}

/// What a fetch of the attachments not held did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeptFetch {
    /// The files whose bytes it fetched, counted once for files that share
    /// them.
    pub fetched: u64,
    pub fetched_bytes: u64,
    /// The attachments after it, as the state report gives them.
    pub attachments: Option<Attachments>,
}

/// The attachments that share one hash.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Group {
    pub(crate) files: u64,
    /// The largest size any of them states.
    pub(crate) stated: Option<u64>,
    /// How many of them state no size.
    pub(crate) unstated: u64,
}

/// The attachments, grouped by the hex of the hash of their bytes.
pub(crate) fn by_bytes(
    found: &[crate::store::Attachment],
) -> std::collections::BTreeMap<String, Group> {
    let mut groups = std::collections::BTreeMap::<String, Group>::new();
    for attachment in found {
        let Ok(hex) = crate::blob::hex_of(&attachment.hash) else {
            continue;
        };
        let group = groups.entry(hex.to_string()).or_default();
        group.files += 1;
        group.stated = group.stated.max(attachment.stated);
        group.unstated += u64::from(attachment.stated.is_none());
    }
    groups
}

/// The report of `found`, with `not_in_copy` edges whose file item the copy
/// does not hold, the cache's entries by name and size in `entries`, and the
/// reason the last fetch left each unheld by hex in `misses`.
pub(crate) fn attachments_of(
    found: &[crate::store::Attachment],
    not_in_copy: u64,
    entries: &std::collections::HashMap<String, u64>,
    misses: &std::collections::HashMap<String, String>,
) -> Attachments {
    let mut report = Attachments {
        held: 0,
        held_bytes: 0,
        partial_bytes: 0,
        not_held: 0,
        not_held_bytes: 0,
        not_held_by_reason: Vec::new(),
    };
    let mut reasons = std::collections::BTreeMap::<NotHeldReason, NotHeld>::new();
    let mut miss = |reason: NotHeldReason, group: Group| {
        let entry = reasons.entry(reason).or_insert(NotHeld {
            reason,
            attachments: 0,
            bytes: 0,
            unstated: 0,
        });
        entry.attachments += group.files;
        entry.bytes += group.stated.unwrap_or(0);
        entry.unstated += group.unstated;
    };
    for (hex, group) in by_bytes(found) {
        if let Some(size) = entries.get(&format!(".partial-{hex}")) {
            report.partial_bytes += size;
        }
        // Held bytes a read failed on stay not held until a fetch finds them
        // readable again.
        if let Some(size) = entries.get(&hex)
            && misses.get(&hex).map(String::as_str) != Some(NotHeldReason::Failed.as_str())
        {
            report.held += group.files;
            report.held_bytes += size;
            continue;
        }
        let reason = misses.get(&hex).map_or(NotHeldReason::NotFetched, |text| {
            NotHeldReason::stored(text)
        });
        miss(reason, group);
    }
    if not_in_copy > 0 {
        let outside = Group {
            files: not_in_copy,
            stated: None,
            unstated: not_in_copy,
        };
        miss(NotHeldReason::NotInCopy, outside);
    }
    report.not_held_by_reason = reasons.into_values().collect();
    report.not_held = report
        .not_held_by_reason
        .iter()
        .map(|reason| reason.attachments)
        .sum();
    report.not_held_bytes = report
        .not_held_by_reason
        .iter()
        .map(|reason| reason.bytes)
        .sum();
    report
}

/// The figures of the volume that holds the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Volume {
    pub(crate) size: u64,
    pub(crate) free: u64,
}

/// The budget in force, and what it was worked out from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InForce {
    /// `None` while every file fetched is kept.
    pub(crate) bytes: Option<u64>,
    /// Whether the default rule fell back to its floor because the volume
    /// could not be read.
    pub(crate) volume_unreadable: bool,
}

/// What the default rule gives, with `held` bytes in the cache now.
///
/// The share is a tenth of the volume, never under the floor. A trim that
/// reaches it must also leave a twentieth of the volume free, which the
/// bytes already held count towards, since a trim hands them back. On a
/// volume too full for that, the minimum still stands, so a fetch does not
/// take every other file.
pub(crate) fn default_budget(volume: Volume, held: u64) -> u64 {
    let share = (volume.size / 10).max(DEFAULT_FLOOR);
    let room = held
        .saturating_add(volume.free)
        .saturating_sub(volume.size / 20);
    share.min(room).max(minimum())
}

/// A debug build reads `MARFA_TEST_FAULT` first: `budget-minimum=<bytes>`
/// stands for the minimum, since a fixture cannot fetch 256 MiB to see the
/// default budget trim.
fn minimum() -> u64 {
    crate::fault::named("budget-minimum")
        .and_then(|bytes| bytes.parse().ok())
        .unwrap_or(DEFAULT_MINIMUM)
}

pub(crate) fn in_force(setting: FileBudget, volume: Option<Volume>, held: u64) -> InForce {
    match setting {
        FileBudget::KeepAll => InForce {
            bytes: None,
            volume_unreadable: false,
        },
        FileBudget::Bytes(bytes) => InForce {
            bytes: Some(bytes),
            volume_unreadable: false,
        },
        FileBudget::Default => match volume {
            Some(volume) => InForce {
                bytes: Some(default_budget(volume, held)),
                volume_unreadable: false,
            },
            None => InForce {
                bytes: Some(DEFAULT_FLOOR),
                volume_unreadable: true,
            },
        },
    }
}

/// Where the cache is, for reading its volume.
pub(crate) enum Place<'a> {
    /// A directory held open: the cache's own folder, or the folder it is
    /// made in before the first fetch makes it.
    Held(&'a File),
    /// A path, or the nearest of its parents that exists, since the cache's
    /// own folder is made by the first fetch.
    Named(&'a Path),
}

/// The volume at `place`; `None` where it cannot be read.
///
/// A debug build reads `MARFA_TEST_FAULT` first: `volume=<size>:<free>` in
/// bytes stands for the volume, and `volume-unreadable` for a volume that
/// cannot be read, since no fixture can choose its runner's disk.
pub(crate) fn read_volume(place: Place<'_>) -> Option<Volume> {
    if crate::fault::named("volume-unreadable").is_some() {
        return None;
    }
    if let Some(figures) = crate::fault::named("volume") {
        let (size, free) = figures.split_once(':')?;
        return volume_from(size.parse().ok()?, free.parse().ok()?, 1);
    }
    statvfs(place)
}

#[cfg(unix)]
fn statvfs(place: Place<'_>) -> Option<Volume> {
    let read = |figures: rustix::fs::StatVfs| {
        volume_from(figures.f_blocks, figures.f_bavail, figures.f_frsize)
    };
    match place {
        Place::Held(directory) => rustix::fs::fstatvfs(directory).ok().and_then(read),
        Place::Named(path) => path.ancestors().find_map(|ancestor| {
            let ancestor = if ancestor.as_os_str().is_empty() {
                Path::new(".")
            } else {
                ancestor
            };
            rustix::fs::statvfs(ancestor).ok().map(read)
        })?,
    }
}

/// Windows is neither built nor tested in CI, so it reports a volume that
/// cannot be read and the default is 2 GiB.
#[cfg(not(unix))]
fn statvfs(_place: Place<'_>) -> Option<Volume> {
    None
}

/// Some FUSE and network mounts answer a size of zero, which says nothing
/// of the volume, so it counts as one that cannot be read.
fn volume_from(blocks: u64, available: u64, unit: u64) -> Option<Volume> {
    let size = blocks.saturating_mul(unit);
    (size > 0).then(|| Volume {
        size,
        free: available.saturating_mul(unit),
    })
}

/// Marks the file `file` is open on as excluded from backups, through the
/// resource value `isExcludedFromBackup` documents
/// (`kCFURLIsExcludedFromBackupKey`). Does nothing off Apple platforms,
/// where no backup reads the mark.
///
/// The mark is never taken off: the system can put a mark back on a file
/// soon after it was cleared, so a file that has to be in backups is made
/// without one.
///
/// A debug build refuses the exclusion where `MARFA_TEST_FAULT` names
/// `backup-mark-refused`, since no fixture can make the system refuse it.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn exclude_from_backups(file: &File) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::error::CFError;
    use core_foundation::string::CFString;
    use core_foundation::url::{
        CFURL, CFURLSetResourcePropertyForKey, kCFURLIsExcludedFromBackupKey,
    };

    if crate::fault::named("backup-mark-refused").is_some() {
        return Err(io::Error::other("the system refused the mark"));
    }
    // The resource value is set by URL, and the file is held by descriptor:
    // the URL is the path the descriptor has now, checked to still name it.
    let path = rustix::fs::getpath(file)?;
    let path = Path::new(std::ffi::OsStr::from_bytes(path.to_bytes()));
    let held = file.metadata()?;
    let named = std::fs::symlink_metadata(path)?;
    if (held.dev(), held.ino()) != (named.dev(), named.ino()) {
        return Err(io::Error::other("the file moved before it could be marked"));
    }
    let url = CFURL::from_path(path, false)
        .ok_or_else(|| io::Error::other("the file's path is not a file URL"))?;
    // The key is a constant of CoreFoundation, held by it for the process.
    let key = unsafe { CFString::wrap_under_get_rule(kCFURLIsExcludedFromBackupKey) };
    let mut error = std::ptr::null_mut();
    let set = unsafe {
        CFURLSetResourcePropertyForKey(
            url.as_concrete_TypeRef(),
            key.as_concrete_TypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
            &mut error,
        )
    };
    if set != 0 {
        return Ok(());
    }
    let reason = if error.is_null() {
        "the system gave no reason".to_string()
    } else {
        // Returned under the create rule, so it is released here.
        unsafe { CFError::wrap_under_create_rule(error) }
            .description()
            .to_string()
    };
    Err(io::Error::other(reason))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub(crate) fn exclude_from_backups(_file: &File) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const TB: u64 = 1_000_000_000_000;

    #[test]
    fn the_default_is_a_tenth_of_the_volume_when_the_volume_has_room() {
        let volume = Volume {
            size: TB,
            free: TB / 2,
        };
        assert_eq!(default_budget(volume, 0), TB / 10);
    }

    #[test]
    fn the_default_is_never_below_the_floor_on_a_small_volume() {
        let volume = Volume {
            size: 10_000_000_000,
            free: 8_000_000_000,
        };
        assert_eq!(default_budget(volume, 0), DEFAULT_FLOOR);
    }

    #[test]
    fn the_default_leaves_a_twentieth_of_the_volume_free_counting_what_is_held() {
        let volume = Volume {
            size: TB,
            free: TB / 20 + 7,
        };
        assert_eq!(default_budget(volume, DEFAULT_MINIMUM), DEFAULT_MINIMUM + 7);
        assert_eq!(
            default_budget(volume, DEFAULT_MINIMUM + 5),
            DEFAULT_MINIMUM + 12
        );
    }

    #[test]
    fn the_default_is_never_below_its_minimum_on_a_volume_with_no_room() {
        let volume = Volume { size: TB, free: 1 };
        assert_eq!(default_budget(volume, 0), DEFAULT_MINIMUM);
        let volume = Volume {
            size: TB,
            free: TB / 20 + DEFAULT_MINIMUM + 1,
        };
        assert_eq!(default_budget(volume, 0), DEFAULT_MINIMUM + 1);
    }

    #[test]
    fn a_volume_whose_size_reads_as_zero_cannot_be_read() {
        assert_eq!(volume_from(0, 0, 4096), None);
        assert_eq!(
            volume_from(10, 4, 4096),
            Some(Volume {
                size: 40960,
                free: 16384
            })
        );
    }

    #[test]
    fn a_volume_that_cannot_be_read_gives_the_floor() {
        let forced = in_force(FileBudget::Default, None, 123);
        assert_eq!(forced.bytes, Some(DEFAULT_FLOOR));
        assert!(forced.volume_unreadable);
    }

    #[test]
    fn a_set_budget_ignores_the_volume() {
        let volume = Volume { size: TB, free: 0 };
        assert_eq!(
            in_force(FileBudget::Bytes(9), Some(volume), 0).bytes,
            Some(9)
        );
        assert_eq!(in_force(FileBudget::KeepAll, Some(volume), 0).bytes, None);
    }

    #[test]
    fn attachments_are_counted_by_file_and_their_bytes_once_by_hash() {
        let hex = |c: char| c.to_string().repeat(64);
        let attachment = |id: &str, c: char, stated: Option<u64>| crate::store::Attachment {
            item_id: id.into(),
            hash: format!("sha256:{}", hex(c)),
            stated,
        };
        let found = [
            attachment("a1", 'a', Some(10)),
            attachment("a2", 'a', Some(10)),
            attachment("b", 'b', Some(30)),
            attachment("c", 'c', None),
            attachment("d", 'd', Some(7)),
            attachment("d2", 'd', None),
            attachment("e", 'e', Some(5)),
            crate::store::Attachment {
                item_id: "bad".into(),
                hash: "not a hash".into(),
                stated: Some(1),
            },
        ];
        let entries = std::collections::HashMap::from([
            (hex('a'), 10),
            (format!(".partial-{}", hex('b')), 12),
            (hex('e'), 5),
        ]);
        let misses = std::collections::HashMap::from([
            (hex('b'), "no_room".to_string()),
            (hex('a'), "unreachable".to_string()),
            (hex('e'), NotHeldReason::Failed.as_str().to_string()),
        ]);
        let report = attachments_of(&found, 2, &entries, &misses);
        assert_eq!(report.held, 2);
        assert_eq!(report.held_bytes, 10);
        assert_eq!(report.partial_bytes, 12);
        assert_eq!(
            report.not_held, 7,
            "held bytes a read failed on counted as held"
        );
        assert_eq!(report.not_held_bytes, 42);
        let reasons: Vec<_> = report
            .not_held_by_reason
            .iter()
            .map(|why| (why.reason, why.attachments, why.bytes, why.unstated))
            .collect();
        assert_eq!(
            reasons,
            [
                (NotHeldReason::NotFetched, 3, 7, 2),
                (NotHeldReason::NoRoom, 1, 30, 0),
                (NotHeldReason::Failed, 1, 5, 0),
                (NotHeldReason::NotInCopy, 2, 0, 2),
            ]
        );
    }

    #[test]
    fn a_setting_is_stored_and_read_back() {
        for setting in [
            FileBudget::Default,
            FileBudget::Bytes(0),
            FileBudget::Bytes(u64::MAX),
            FileBudget::KeepAll,
        ] {
            assert_eq!(FileBudget::stored(setting.to_stored().as_deref()), setting);
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_volume_of_a_folder_not_made_yet_is_its_parents() {
        let dir = tempfile::tempdir().unwrap();
        let volume =
            read_volume(Place::Named(&dir.path().join("not-yet.blobs"))).expect("a volume");
        assert!(volume.size > 0 && volume.free <= volume.size);
    }

    /// Whether `tmutil` says Time Machine leaves `path` out.
    #[cfg(target_os = "macos")]
    pub(crate) fn excluded(path: &Path) -> bool {
        let said = std::process::Command::new("tmutil")
            .arg("isexcluded")
            .arg(path)
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&said.stdout).into_owned();
        assert!(
            said.contains("[Included]") || said.contains("[Excluded]"),
            "{said}"
        );
        said.contains("[Excluded]")
    }

    /// Fetched bytes are left out of backups, and the bytes of an upload,
    /// the only copy until the server has them, never are, nor the folder
    /// that holds both.
    #[cfg(target_os = "macos")]
    #[test]
    fn fetched_bytes_are_kept_out_of_backups_and_upload_bytes_are_not() {
        // The system excludes its own temporary folders, so the witness has to
        // sit under the home folder.
        let home = std::env::var_os("HOME").expect("HOME");
        let area = tempfile::Builder::new()
            .prefix(".marfa-backup-test-")
            .tempdir_in(home)
            .unwrap();
        let root = area.path().join("anchored");
        std::fs::create_dir(&root).unwrap();
        let directory = crate::directory::Directory::open(&root.canonicalize().unwrap()).unwrap();
        let caches = [
            crate::blob::Cache::beside(&area.path().join("core.sqlite")),
            crate::blob::Cache::anchored(&directory, &root.join("core.sqlite"), true).unwrap(),
        ];
        for cache in caches {
            let source = area.path().join("upload.txt");
            std::fs::write(&source, b"only copy").unwrap();
            let taken = cache
                .take_reader(&source, File::open(&source).unwrap())
                .unwrap();
            let upload = cache.held(&taken.hash).unwrap().unwrap();
            assert!(
                !excluded(&upload),
                "the bytes of an upload were left out of backups"
            );
            assert!(
                !excluded(upload.parent().unwrap()),
                "the folder that holds upload bytes was left out of backups"
            );

            let bytes = b"fetched again whenever";
            let fetched = cache
                .keep(
                    &crate::blob::name_of(bytes),
                    &bytes[..],
                    crate::blob::tests::no_uploads,
                )
                .unwrap();
            assert_eq!(fetched.mark, crate::blob::Mark::Excluded);
            assert!(
                excluded(&fetched.path),
                "tmutil does not see fetched bytes as excluded"
            );

            // Bytes fetched and then queued as an upload are an upload's again.
            let again = area.path().join("again.txt");
            std::fs::write(&again, bytes).unwrap();
            cache
                .take_reader(&again, File::open(&again).unwrap())
                .unwrap();
            assert!(
                !excluded(&fetched.path),
                "bytes an upload names stayed out of backups"
            );
        }
    }
}
