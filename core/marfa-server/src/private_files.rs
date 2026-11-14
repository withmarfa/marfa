use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{DirBuilder, File, Metadata, OpenOptions, Permissions};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use crate::failure::Failure;
use crate::settings::{DatabasePath, secrets_file};

const OTHERS: u32 = 0o077;
const OTHERS_WRITE: u32 = 0o022;
const OWNER: u32 = 0o700;
const MAX_LINKS: usize = 40;

pub fn take_umask() {
    // SAFETY: `umask` takes a mask and cannot fail.
    unsafe {
        libc::umask(0o077);
    }
}

fn me() -> u32 {
    // SAFETY: `geteuid` takes nothing and cannot fail.
    unsafe { libc::geteuid() }
}

fn refused(path: &Path, why: impl std::fmt::Display) -> Failure {
    Failure::start(format!("{} {why}", path.display()))
}

enum Step {
    Root,
    Up,
    Name(OsString),
}

fn steps(path: &Path) -> impl DoubleEndedIterator<Item = Step> + '_ {
    path.components().filter_map(|part| match part {
        Component::RootDir => Some(Step::Root),
        Component::ParentDir => Some(Step::Up),
        Component::Normal(name) => Some(Step::Name(name.to_os_string())),
        Component::CurDir | Component::Prefix(_) => None,
    })
}

/// A path with every folder above its last name judged.
struct Reached {
    /// The deepest folder that is there, named without a link.
    folder: PathBuf,
    /// The folders below `folder` that are not there yet, then the last name.
    below: Vec<OsString>,
}

impl Reached {
    fn path(&self) -> PathBuf {
        self.below
            .iter()
            .fold(self.folder.clone(), |path, name| path.join(name))
    }
}

fn walk(path: &Path, me: u32) -> Result<Reached, Failure> {
    let absolute = std::path::absolute(path)
        .map_err(|error| refused(path, format_args!("could not be resolved: {error}")))?;
    let mut ahead: VecDeque<Step> = steps(&absolute).collect();
    let Some(Step::Name(last)) = ahead.pop_back() else {
        return Err(refused(path, "does not end in a file or folder name"));
    };
    let mut folder = PathBuf::from("/");
    on_the_way(&folder, me)?;
    let mut links = 0;
    while let Some(step) = ahead.pop_front() {
        let name = match step {
            Step::Root => {
                folder = PathBuf::from("/");
                continue;
            }
            Step::Up => {
                folder.pop();
                continue;
            }
            Step::Name(name) => name,
        };
        let next = folder.join(&name);
        let found = match std::fs::symlink_metadata(&next) {
            Ok(found) => found,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let mut below = vec![name];
                for step in ahead {
                    let Step::Name(name) = step else {
                        return Err(refused(&next, "is not there, and the path goes on past it"));
                    };
                    below.push(name);
                }
                below.push(last);
                return Ok(Reached { folder, below });
            }
            Err(error) => return Err(refused(&next, format_args!("could not be read: {error}"))),
        };
        if found.file_type().is_symlink() {
            if found.uid() != me && found.uid() != 0 {
                return Err(refused(
                    &next,
                    "is a symbolic link another account made. Name the folder it points to \
                     instead.",
                ));
            }
            links += 1;
            let target = std::fs::read_link(&next)
                .map_err(|error| refused(&next, format_args!("could not be read: {error}")))?;
            if links > MAX_LINKS || target.as_os_str().is_empty() {
                return Err(refused(
                    path,
                    "could not be followed through its symbolic links",
                ));
            }
            for step in steps(&target).rev() {
                ahead.push_front(step);
            }
            continue;
        }
        judged_on_the_way(&next, &found, me)?;
        folder = next;
    }
    Ok(Reached {
        folder,
        below: vec![last],
    })
}

fn on_the_way(folder: &Path, me: u32) -> Result<(), Failure> {
    let found = std::fs::symlink_metadata(folder)
        .map_err(|error| refused(folder, format_args!("could not be read: {error}")))?;
    judged_on_the_way(folder, &found, me)
}

fn judged_on_the_way(folder: &Path, found: &Metadata, me: u32) -> Result<(), Failure> {
    let why =
        marfa_acl::exposure(folder, found, me).map_err(|error| unreadable_acl(folder, &error))?;
    let fix = match why {
        None => return Ok(()),
        Some(marfa_acl::Exposure::Link | marfa_acl::Exposure::NotFolder) => {
            return Err(refused(folder, "is not a folder"));
        }
        Some(marfa_acl::Exposure::Owner) => {
            "Give it to the server's account or to root, or keep the data in another folder."
                .to_string()
        }
        Some(marfa_acl::Exposure::Mode) => format!("Run `chmod go-w {}`.", folder.display()),
        Some(marfa_acl::Exposure::Acl) => format!(
            "Remove those entries with {}.",
            marfa_acl::removal_command(false)
        ),
    };
    let why = why.map(|why| why.to_string()).unwrap_or_default();
    Err(refused(
        folder,
        format_args!("{why}, so another account could replace the server's data. {fix}"),
    ))
}

/// Root's sticky folders still let another account make a file before the server does.
fn holds_new_files(folder: &Path, me: u32) -> Result<(), Failure> {
    let opened = open(folder, true)?.ok_or_else(|| refused(folder, "is not there"))?;
    let found = read(&opened, folder)?;
    if found.mode() & OTHERS_WRITE != 0 {
        return Err(refused(
            folder,
            "lets other accounts add files to it, so one could make a file the server would \
             then write in. Keep the data in a folder of its own.",
        ));
    }
    let reach = marfa_acl::reach(&opened, me).map_err(|error| unreadable_acl(folder, &error))?;
    if reach.passed_on {
        return Err(refused(
            folder,
            format_args!(
                "passes access to another account on to the files the server makes in it, \
                 through its access control list. Remove those entries with {}, or keep the \
                 data in another folder.",
                marfa_acl::removal_command(true)
            ),
        ));
    }
    Ok(())
}

// An existing database folder may hold files that do not belong to the server.
pub fn make_data_folder(database: &DatabasePath) -> Result<(), Failure> {
    let Some(file) = database.file() else {
        return Ok(());
    };
    let me = me();
    let reached = walk(&file, me)?;
    let Some((_, missing)) = reached.below.split_last() else {
        return Ok(());
    };
    let mut folder = reached.folder;
    for name in missing {
        let next = folder.join(name);
        match DirBuilder::new().mode(OWNER).create(&next) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(refused(&next, format_args!("could not be made: {error}")));
            }
        }
        let made = open(&next, true)?.ok_or_else(|| refused(&next, "could not be made"))?;
        let found = read(&made, &next)?;
        if found.uid() == me {
            close(&made, &found, &next)?;
        }
        on_the_way(&next, me)?;
        folder = next;
    }
    Ok(())
}

pub struct Kept {
    files: Vec<PathBuf>,
    blobs: PathBuf,
    blobs_made: bool,
}

impl Kept {
    pub fn closed(database_path: &DatabasePath, blobs: &Path) -> Result<Kept, Failure> {
        let me = me();
        let secrets = walk(&secrets_file(database_path), me)?;
        let [secrets_name] = secrets.below.as_slice() else {
            return Err(refused(
                &secrets.folder.join(&secrets.below[0]),
                "is not there",
            ));
        };
        holds_new_files(&secrets.folder, me)?;
        let folder = secrets.folder.clone();
        let mut files = vec![folder.join(secrets_name)];
        if let Some(database) = database_path.file() {
            let name = database
                .file_name()
                .ok_or_else(|| refused(&database, "does not end in a file name"))?;
            files.extend(
                [
                    "",
                    "-wal",
                    "-shm",
                    "-journal",
                    ".before-upgrade",
                    ".before-upgrade.partial",
                ]
                .iter()
                .map(|suffix| {
                    let mut beside = name.to_os_string();
                    beside.push(suffix);
                    folder.join(beside)
                }),
            );
        }
        let reached = walk(blobs, me)?;
        let opened = match reached.below.len() {
            1 => open(&reached.path(), true)?,
            _ => None,
        };
        let blobs_made = match opened {
            Some(opened) => {
                secure_blob_folder(&opened, &reached.path(), me)?;
                false
            }
            None => {
                holds_new_files(&reached.folder, me)?;
                true
            }
        };
        let kept = Kept {
            files,
            blobs: blobs.to_path_buf(),
            blobs_made,
        };
        kept.database_opened()?;
        Ok(kept)
    }

    pub fn database_opened(&self) -> Result<(), Failure> {
        let me = me();
        self.files.iter().try_for_each(|file| secure(file, me))
    }

    pub fn blobs_opened(&self) -> Result<(), Failure> {
        if !self.blobs_made {
            return Ok(());
        }
        let me = me();
        let reached = walk(&self.blobs, me)?;
        let path = reached.path();
        match open(&path, true)? {
            Some(opened) if reached.below.len() == 1 => secure_blob_folder(&opened, &path, me),
            _ => Err(refused(&path, "is not there")),
        }
    }
}

fn open(path: &Path, folder: bool) -> Result<Option<File>, Failure> {
    let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK | if folder { libc::O_DIRECTORY } else { 0 };
    match OpenOptions::new().read(true).custom_flags(flags).open(path) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(not_opened(path, &error)),
    }
}

fn not_opened(path: &Path, error: &std::io::Error) -> Failure {
    // macOS answers ENOTDIR, not ELOOP, for a link opened as a folder.
    let link = std::fs::symlink_metadata(path).is_ok_and(|found| found.is_symlink());
    match error.raw_os_error() {
        _ if link => refused(
            path,
            "is a symbolic link, and the server keeps its data only where it can make it \
             private. Name the file or folder the link points to instead.",
        ),
        Some(libc::ENOTDIR) => refused(path, "is not a folder"),
        _ => refused(path, format_args!("could not be opened: {error}")),
    }
}

fn read(file: &File, path: &Path) -> Result<Metadata, Failure> {
    file.metadata()
        .map_err(|error| refused(path, format_args!("could not be read: {error}")))
}

fn close(file: &File, found: &Metadata, path: &Path) -> Result<(), Failure> {
    let reach = marfa_acl::reach(file, me()).map_err(|error| unreadable_acl(path, &error))?;
    if reach != marfa_acl::Reach::default() {
        marfa_acl::clear(file).map_err(|error| {
            refused(
                path,
                format_args!("has an access control list the server could not remove: {error}"),
            )
        })?;
    }
    if found.mode() & OTHERS != 0 {
        file.set_permissions(Permissions::from_mode(found.mode() & OWNER))
            .map_err(|error| refused(path, format_args!("could not be made private: {error}")))?;
    }
    Ok(())
}

fn unreadable_acl(path: &Path, error: &std::io::Error) -> Failure {
    refused(
        path,
        format_args!("has an access control list that could not be read: {error}"),
    )
}

enum Exposure {
    Mode(u32),
    Acl,
    PassedOn,
}

fn exposure(file: &File, path: &Path) -> Result<Option<Exposure>, Failure> {
    let mode = read(file, path)?.mode();
    let reach = marfa_acl::reach(file, me()).map_err(|error| unreadable_acl(path, &error))?;
    Ok(if reach.passed_on {
        Some(Exposure::PassedOn)
    } else if mode & OTHERS != 0 {
        Some(Exposure::Mode(mode & 0o7777))
    } else if reach.itself {
        Some(Exposure::Acl)
    } else {
        None
    })
}

fn exposed(path: &Path, why: &Exposure, ours: bool) -> Failure {
    let what = match why {
        Exposure::Mode(mode) => format!("is open to other accounts (mode {mode:04o})"),
        Exposure::Acl => "has an access control list that lets another account in".to_string(),
        Exposure::PassedOn => "passes access to another account on to what is made inside it, \
                               through its access control list"
            .to_string(),
    };
    let fix = match (why, ours) {
        (_, true) => "The server could not make it private: keep the data on a file system \
                      that keeps file modes and access control lists."
            .to_string(),
        (Exposure::Mode(_), false) => format!(
            "It belongs to another account: give it to the server's account with `chown`, or \
             run `chmod go-rwx {}`.",
            path.display()
        ),
        (Exposure::Acl, false) => format!(
            "Remove those entries with {}.",
            marfa_acl::removal_command(false)
        ),
        (Exposure::PassedOn, false) => format!(
            "Remove those entries with {}.",
            marfa_acl::removal_command(true)
        ),
    };
    refused(path, format_args!("{what}. {fix}"))
}

fn secure(path: &Path, me: u32) -> Result<(), Failure> {
    let Some(file) = open(path, false)? else {
        return Ok(());
    };
    let found = read(&file, path)?;
    if !found.is_file() {
        return Err(refused(path, "is not a file"));
    }
    let ours = found.uid() == me;
    if ours {
        close(&file, &found, path)?;
    }
    match exposure(&file, path)? {
        None => Ok(()),
        Some(why) => Err(exposed(path, &why, ours)),
    }
}

/// The store writes inside this folder, so it must be one the server can keep private.
fn secure_blob_folder(file: &File, path: &Path, me: u32) -> Result<(), Failure> {
    let found = read(file, path)?;
    if !found.is_dir() {
        return Err(refused(path, "is not a folder"));
    }
    if found.uid() != me {
        return Err(refused(
            path,
            "belongs to another account, and the server keeps its blobs only in a folder of its \
             own. Give it to the server's account with `chown`.",
        ));
    }
    close(file, &found, path)?;
    match exposure(file, path)? {
        None => Ok(()),
        Some(why) => Err(exposed(path, &why, true)),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use marfa_acl::testing::{Grant, let_another_account};

    use super::*;

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().mode() & 0o777
    }

    fn chmod(path: &Path, mode: u32) {
        fs::set_permissions(path, Permissions::from_mode(mode)).unwrap();
    }

    fn reach(path: &Path) -> marfa_acl::Reach {
        marfa_acl::reach(&File::open(path).unwrap(), me()).unwrap()
    }

    fn kept(data: &Path, blobs: &Path) -> Result<Kept, Failure> {
        Kept::closed(&DatabasePath::File(data.join("marfa.db")), blobs)
    }

    #[test]
    fn what_is_the_servers_is_made_private_and_a_link_is_refused_unfollowed() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, file) = (dir.path().join("blobs"), dir.path().join("marfa.db"));
        fs::create_dir(&folder).unwrap();
        fs::write(&file, "").unwrap();
        chmod(&folder, 0o755);
        chmod(&file, 0o644);
        kept(dir.path(), &folder).unwrap();
        assert_eq!((mode(&folder), mode(&file)), (0o700, 0o600));

        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        chmod(&outside, 0o755);
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let mut slashed = link.clone().into_os_string();
        slashed.push("/");
        for named in [link.clone(), PathBuf::from(slashed), link.join(".")] {
            let failure = kept(dir.path(), &named).err().expect("refused");
            assert!(failure.message.contains("symbolic link"), "{failure}");
        }
        assert_eq!(mode(&outside), 0o755);
    }

    #[test]
    fn a_link_the_servers_account_made_above_the_blob_folder_leads_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        fs::create_dir_all(real.join("blobs")).unwrap();
        chmod(&real.join("blobs"), 0o755);
        std::os::unix::fs::symlink(&real, dir.path().join("via")).unwrap();
        kept(dir.path(), &dir.path().join("via/blobs")).unwrap();
        assert_eq!(mode(&real.join("blobs")), 0o700);
    }

    #[test]
    fn a_folder_another_account_could_change_on_the_way_refuses_the_start_and_nothing_changes() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared");
        let blobs = shared.join("blobs");
        fs::create_dir_all(&blobs).unwrap();
        chmod(&blobs, 0o755);
        // The witness: while only the server's account can change the folder above, it starts.
        chmod(&shared, 0o755);
        kept(dir.path(), &blobs).unwrap();
        chmod(&blobs, 0o755);
        for open in [0o777, 0o1777, 0o775] {
            chmod(&shared, open);
            let failure = kept(dir.path(), &blobs).err().expect("refused");
            assert!(
                failure.message.contains("written by another account"),
                "{failure}"
            );
            assert!(
                failure.message.contains(shared.to_str().unwrap()),
                "{failure}"
            );
            assert_eq!(mode(&blobs), 0o755);
        }
        chmod(&shared, 0o777);
        let failure = kept(dir.path(), &shared.join("new"))
            .err()
            .expect("refused");
        assert!(
            failure.message.contains("written by another account"),
            "{failure}"
        );
        assert!(!shared.join("new").exists());
    }

    #[test]
    fn a_blob_folder_of_another_account_refuses_the_start_and_is_left_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let blobs = dir.path().join("blobs");
        fs::create_dir(&blobs).unwrap();
        chmod(&blobs, 0o755);
        let opened = open(&blobs, true).unwrap().unwrap();
        // The witness: as the server's own folder, it is made private.
        secure_blob_folder(&opened, &blobs, me()).unwrap();
        assert_eq!(mode(&blobs), 0o700);
        chmod(&blobs, 0o755);
        let passes_on = let_another_account(&blobs, Grant::InheritReadToFiles);
        assert_eq!(reach(&blobs).passed_on, passes_on);
        let another = u32::MAX - 1;
        let failure = secure_blob_folder(&opened, &blobs, another).unwrap_err();
        assert!(
            failure.message.contains("belongs to another account"),
            "{failure}"
        );
        assert_eq!(mode(&blobs), 0o755);
        assert_eq!(reach(&blobs).passed_on, passes_on);
    }

    #[test]
    fn an_access_control_list_on_what_is_the_servers_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, file) = (dir.path().join("blobs"), dir.path().join("marfa.db"));
        fs::create_dir(&folder).unwrap();
        fs::write(&file, "").unwrap();
        chmod(&file, 0o640);
        if !let_another_account(&folder, Grant::Read) {
            eprintln!("skipped: this file system keeps no access control lists");
            return;
        }
        assert!(let_another_account(&folder, Grant::InheritReadToFiles));
        assert!(let_another_account(&file, Grant::ReadFile));
        assert!(reach(&folder).itself && reach(&folder).passed_on);
        assert!(reach(&file).itself);
        kept(dir.path(), &folder).unwrap();
        assert_eq!(reach(&folder), marfa_acl::Reach::default());
        assert_eq!(reach(&file), marfa_acl::Reach::default());
        assert_eq!(mode(&file), 0o600);
    }

    #[test]
    fn a_folder_files_are_made_in_that_passes_access_on_refuses_the_start_and_is_left_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        chmod(&data, 0o755);
        let blobs = data.join("blobs");
        // The witness: an open folder that passes nothing on is kept as it is, and allowed.
        kept(&data, &blobs).unwrap();
        if !let_another_account(&data, Grant::InheritReadToFiles) {
            eprintln!("skipped: this file system keeps no access control lists");
            return;
        }
        for blobs in [blobs, dir.path().join("blobs")] {
            let failure = kept(&data, &blobs).err().expect("refused");
            assert!(failure.message.contains("passes access"), "{failure}");
        }
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&elsewhere).unwrap();
        let failure = kept(&elsewhere, &data.join("blobs"))
            .err()
            .expect("refused");
        assert!(failure.message.contains("passes access"), "{failure}");
        assert!(!data.join("blobs").exists());
        make_data_folder(&DatabasePath::File(data.join("marfa.db"))).unwrap();
        assert!(reach(&data).passed_on);
        assert_eq!(mode(&data), 0o755);
    }

    #[test]
    fn a_database_folder_the_server_makes_is_private_and_takes_no_inherited_entry() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared");
        fs::create_dir(&shared).unwrap();
        let data = shared.join("data");
        let inherits = let_another_account(&shared, Grant::InheritRead)
            && let_another_account(&shared, Grant::InheritReadToFiles);
        make_data_folder(&DatabasePath::File(data.join("deeper/marfa.db"))).unwrap();
        for made in [&data, &data.join("deeper")] {
            assert_eq!(mode(made), 0o700);
            assert_eq!(reach(made), marfa_acl::Reach::default());
        }
        if inherits {
            // The witness: a folder made there by another hand inherits the entries.
            let other = shared.join("other");
            fs::create_dir(&other).unwrap();
            assert_ne!(reach(&other), marfa_acl::Reach::default());
        }
    }
}
