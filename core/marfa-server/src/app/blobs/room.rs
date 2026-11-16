//! The disk reserve: the free space a write must leave on a volume, and what a refusal says of it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::app::faults::{Faults, Volume};
use crate::app::refusal::{Code, Refusal, Result};
use crate::db::volume;
use crate::settings::registry::DISK_RESERVE_BYTES;

use super::App;

const KIB: u64 = 1024;
const SETTING: &str = "disk_reserve_bytes";

/// A byte count in the largest binary unit that holds it, such as `128 MiB`, or in bytes below 1 KiB.
pub fn bytes_in_words(bytes: u64) -> String {
    let units = ["KiB", "MiB", "GiB", "TiB"];
    let Some(mut unit) = (bytes >= KIB).then_some(0) else {
        return format!("{bytes} bytes");
    };
    let mut scale = KIB;
    while unit + 1 < units.len() && bytes / scale >= KIB {
        scale *= KIB;
        unit += 1;
    }
    let tenths = bytes.saturating_mul(10) / scale;
    if tenths.is_multiple_of(10) {
        format!("{} {}", tenths / 10, units[unit])
    } else {
        format!("{}.{} {}", tenths / 10, tenths % 10, units[unit])
    }
}

/// What a volume holds, and what a write asks of it, as far as a refusal for the reserve says.
#[derive(Debug, PartialEq, Eq)]
pub struct Shortfall {
    pub volume: Volume,
    pub available: u64,
    pub size: Option<u64>,
    pub reserve: u64,
    /// What the write needs, or 0 where it is not known yet.
    pub incoming: u64,
}

impl Shortfall {
    /// Whether the reserve is at least the whole volume, so that no write can leave it free.
    pub fn unfit(&self) -> bool {
        self.size.is_some_and(|size| self.reserve >= size)
    }

    fn place(&self) -> &'static str {
        match self.volume {
            Volume::Database => "the volume the database is kept on",
            Volume::Blobs => "the volume the blobs are kept on",
            Volume::Backups => "the backup folder's disk",
        }
    }

    /// The refusal's reason, as one clause that names the reserve and the setting that changes it.
    pub fn reason(&self) -> String {
        let reserve = bytes_in_words(self.reserve);
        if let (true, Some(size)) = (self.unfit(), self.size) {
            return format!(
                "the disk reserve of {reserve} ({SETTING}) is not less than the {} {} holds, so no \
                 write can leave that much free there; lower {SETTING} below the volume's size, or set it \
                 to 0 to hold nothing back",
                bytes_in_words(size),
                self.place().trim_start_matches("the ")
            );
        }
        let free = bytes_in_words(self.available);
        let taking = if self.incoming > 0 {
            format!(" and the write takes {}", bytes_in_words(self.incoming))
        } else {
            String::new()
        };
        format!(
            "{} has {free} free{taking}, which leaves less than the disk reserve of {reserve} \
             ({SETTING}); free some space there, or lower {SETTING}, where 0 holds nothing back",
            self.place()
        )
    }

    /// `507` for an upload, naming the reserve.
    pub fn refusal(&self) -> Refusal {
        let reason = self.reason();
        let mut text = reason.clone();
        if let Some(first) = text.get_mut(..1) {
            first.make_ascii_uppercase();
        }
        Refusal::new(Code::InsufficientStorage, format!("{text}."))
            .with_detail("reserve_bytes", self.reserve)
            .with_detail("available_bytes", self.available)
    }
}

/// How much `incoming` more bytes on `root`'s volume would fall short of `reserve`, if they would.
pub fn shortfall(
    faults: &Faults,
    which: Volume,
    root: &Path,
    reserve: u64,
    incoming: u64,
) -> Option<Shortfall> {
    if reserve == 0 {
        return None;
    }
    let available = faults
        .free(which)
        .unwrap_or_else(|| volume::free_bytes(root))?;
    if available.saturating_sub(incoming) >= reserve {
        return None;
    }
    let size = faults
        .size(which)
        .unwrap_or_else(|| volume::size_bytes(root));
    Some(Shortfall {
        volume: which,
        available,
        size,
        reserve,
        incoming,
    })
}

/// Why `incoming` bytes do not fit in the backup folder: the reserve holds only on a shared volume.
pub fn copy_shortfall(
    faults: &Faults,
    root: &Path,
    reserve: u64,
    shared: bool,
    incoming: u64,
) -> Option<String> {
    if shared {
        return shortfall(faults, Volume::Backups, root, reserve, incoming).map(|s| s.reason());
    }
    let available = faults
        .free(Volume::Backups)
        .unwrap_or_else(|| volume::free_bytes(root))?;
    (available < incoming).then(|| {
        format!(
            "the backup folder's disk has {} free and the copy takes {}, so it does not fit; free \
             some space there",
            bytes_in_words(available),
            bytes_in_words(incoming)
        )
    })
}

/// `copy_shortfall` for `app`'s reserve, off the async runtime; `shared` is read once and kept.
pub async fn folder_shortfall(
    app: &App,
    root: &Path,
    shared: &mut Option<bool>,
    incoming: u64,
) -> Option<String> {
    let reserve = app.settings.live().get(DISK_RESERVE_BYTES);
    let (faults, root, known) = (app.faults.clone(), root.to_path_buf(), *shared);
    let start = &app.settings.start;
    let (blobs, database) = (start.blob_path.clone(), start.database.folder());
    let judged = tokio::task::spawn_blocking(move || {
        let shared = known.unwrap_or_else(|| volume::shares_with(&root, &[&blobs, &database]));
        (
            shared,
            copy_shortfall(&faults, &root, reserve, shared, incoming),
        )
    })
    .await;
    match judged {
        Ok((found, why)) => {
            *shared = Some(found);
            why
        }
        Err(_) => Some("the room in the backup folder's disk could not be read".to_string()),
    }
}

/// Refuses a body that would leave less free on the blob volume than the reserve.
pub fn room(faults: &Faults, root: &Path, reserve: u64, incoming: u64) -> Result<()> {
    room_on(faults, Volume::Blobs, root, reserve, incoming)
}

/// Refuses a body that would leave less free on `root`'s volume than the reserve.
pub fn room_on(
    faults: &Faults,
    which: Volume,
    root: &Path,
    reserve: u64,
    incoming: u64,
) -> Result<()> {
    match shortfall(faults, which, root, reserve, incoming) {
        Some(short) => Err(short.refusal()),
        None => Ok(()),
    }
}

/// The reserve a file the server writes on the disk store's volume must leave free there.
#[derive(Clone)]
pub struct Room {
    faults: Arc<Faults>,
    root: PathBuf,
    reserve: u64,
}

impl Room {
    pub fn new(faults: Arc<Faults>, root: PathBuf, reserve: u64) -> Room {
        Room {
            faults,
            root,
            reserve,
        }
    }

    /// Refuses where the volume already has less free than the reserve. It blocks.
    pub fn check(&self) -> Result<()> {
        room(&self.faults, &self.root, self.reserve, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = KIB * KIB;

    fn faults(free: u64, size: Option<u64>) -> Faults {
        let faults = Faults::default();
        faults.set("free:blobs", Some(&free.to_string())).unwrap();
        if let Some(size) = size {
            faults.set("size:blobs", Some(&size.to_string())).unwrap();
        }
        faults
    }

    fn refused(faults: &Faults, reserve: u64, incoming: u64) -> Option<Refusal> {
        room(faults, Path::new("."), reserve, incoming).err()
    }

    #[test]
    fn a_count_of_bytes_is_said_in_the_unit_a_person_reads() {
        assert_eq!(bytes_in_words(0), "0 bytes");
        assert_eq!(bytes_in_words(1023), "1023 bytes");
        assert_eq!(bytes_in_words(KIB), "1 KiB");
        assert_eq!(bytes_in_words(128 * MIB), "128 MiB");
        assert_eq!(bytes_in_words(MIB + MIB / 2), "1.5 MiB");
        assert_eq!(bytes_in_words(1024 * MIB), "1 GiB");
        assert_eq!(bytes_in_words(1024 * 1024 * MIB), "1 TiB");
        assert_eq!(bytes_in_words(5 * 1024 * 1024 * MIB), "5 TiB");
    }

    #[test]
    fn a_volume_below_the_reserve_names_the_reserve_and_the_setting() {
        let refusal = refused(&faults(100 * MIB, Some(4096 * MIB)), 128 * MIB, 0).unwrap();
        assert_eq!(refusal.code, Code::InsufficientStorage);
        assert!(
            refusal.message.contains("100 MiB free"),
            "{}",
            refusal.message
        );
        assert!(refusal.message.contains("disk reserve of 128 MiB"));
        assert!(refusal.message.contains("disk_reserve_bytes"));
        assert!(refusal.message.contains("0 holds nothing back"));
    }

    #[test]
    fn an_upload_that_fits_but_crosses_the_reserve_says_what_it_takes() {
        let faults = faults(200 * MIB, Some(4096 * MIB));
        assert!(refused(&faults, 128 * MIB, 72 * MIB).is_none());
        let refusal = refused(&faults, 128 * MIB, 73 * MIB).unwrap();
        assert!(
            refusal.message.contains("200 MiB free"),
            "{}",
            refusal.message
        );
        assert!(refusal.message.contains("takes 73 MiB"));
        assert!(refusal.message.contains("disk reserve of 128 MiB"));
        let details = refusal.details.unwrap();
        assert_eq!(details["reserve_bytes"], 128 * MIB);
        assert_eq!(details["available_bytes"], 200 * MIB);
    }

    #[test]
    fn a_reserve_the_volume_cannot_hold_is_said_to_be_too_big_for_it() {
        let faults = faults(50 * MIB, Some(64 * MIB));
        let refusal = refused(&faults, 128 * MIB, 0).unwrap();
        assert!(
            refusal.message.contains(
                "disk reserve of 128 MiB (disk_reserve_bytes) is not less than the 64 MiB"
            ),
            "{}",
            refusal.message
        );
        assert!(refusal.message.contains("lower disk_reserve_bytes"));
        assert!(
            refused(&faults, 64 * MIB, 0)
                .is_some_and(|refusal| { refusal.message.contains("not less than the 64 MiB") })
        );
        let fits = refused(&faults, 60 * MIB, 0).unwrap();
        assert!(fits.message.contains("50 MiB free"), "{}", fits.message);
    }

    #[test]
    fn a_reserve_of_zero_holds_nothing_back_and_a_volume_that_cannot_be_read_refuses_nothing() {
        assert!(refused(&faults(0, Some(64 * MIB)), 0, 10 * MIB).is_none());
        let unknown = Faults::default();
        unknown.set("free:blobs", Some("unknown")).unwrap();
        assert!(refused(&unknown, 128 * MIB, 10 * MIB).is_none());
    }

    #[test]
    fn a_backup_folder_on_a_disk_of_its_own_is_held_to_the_size_of_the_copy_and_not_the_reserve() {
        let faults = Faults::default();
        faults.set("free:backups", Some("58000000")).unwrap();
        let root = Path::new(".");
        assert_eq!(
            copy_shortfall(&faults, root, 128 * MIB, false, 1_000_000),
            None
        );
        let why = copy_shortfall(&faults, root, 128 * MIB, false, 59_000_000).unwrap();
        assert!(why.contains("does not fit"), "{why}");
        assert!(!why.contains("reserve"), "{why}");
        let shared = copy_shortfall(&faults, root, 128 * MIB, true, 1_000_000).unwrap();
        assert!(
            shared.contains("disk reserve of 128 MiB (disk_reserve_bytes)"),
            "{shared}"
        );
        assert_eq!(copy_shortfall(&faults, root, 0, true, 1_000_000), None);
    }

    #[test]
    fn the_message_of_a_backup_folder_names_its_disk() {
        let faults = Faults::default();
        faults.set("free:backups", Some("1048576")).unwrap();
        let short =
            shortfall(&faults, Volume::Backups, Path::new("."), 128 * MIB, 3 * MIB).unwrap();
        let reason = short.reason();
        assert!(
            reason.starts_with("the backup folder's disk has 1 MiB free"),
            "{reason}"
        );
        assert!(reason.contains("takes 3 MiB"));
        assert!(reason.contains("disk_reserve_bytes"));
    }
}
