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
    /// The folders below `folder` that are not there yet.
    missing: Vec<OsString>,
    name: OsString,
}

impl Reached {
    fn path(&self) -> PathBuf {
        self.missing
            .iter()
            .fold(self.folder.clone(), |path, name| path.join(name))
            .join(&self.name)
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
        let looked = match look(&next, me) {
            Ok(looked) => looked,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let mut missing = vec![name];
                for step in ahead {
                    let Step::Name(name) = step else {
                        return Err(refused(&next, "is not there, and the path goes on past it"));
                    };
                    missing.push(name);
                }
                return Ok(Reached {
                    folder,
                    missing,
                    name: last,
                });
            }
            Err(error) => return Err(refused(&next, format_args!("could not be read: {error}"))),
        };
        if let Some(target) = &looked.target {
            if looked.found.uid() != me && looked.found.uid() != 0 {
                return Err(refused(
                    &next,
                    "is a symbolic link another account made. Name the folder it points to \
                     instead.",
                ));
            }
            if looked.others_may_change {
                return Err(refused(
                    &next,
                    format_args!(
                        "is a symbolic link whose access control list lets another account \
                         change or remove it. Run `chmod -h -N {}`.",
                        next.display()
                    ),
                ));
            }
            links += 1;
            if links > MAX_LINKS || target.as_os_str().is_empty() {
                return Err(refused(
                    path,
                    "could not be followed through its symbolic links",
                ));
            }
            for step in steps(target).rev() {
                ahead.push_front(step);
            }
            continue;
        }
        judged_on_the_way(&next, &looked, me)?;
        folder = next;
    }
    Ok(Reached {
        folder,
        missing: Vec::new(),
        name: last,
    })
}

fn on_the_way(folder: &Path, me: u32) -> Result<(), Failure> {
    let looked = look(folder, me)
        .map_err(|error| refused(folder, format_args!("could not be read: {error}")))?;
    judged_on_the_way(folder, &looked, me)
}

/// A file or folder on the way, unfollowed, and what it says about itself.
struct Looked {
    found: Metadata,
    /// Whether its own access control list lets another account change it, remove it or, for a
    /// folder, change what it holds.
    others_may_change: bool,
    /// Where it points, when it is a symbolic link.
    target: Option<PathBuf>,
}

/// One descriptor for all of it: here an entry's own ACL can let another account replace it.
#[cfg(target_os = "macos")]
fn look(path: &Path, me: u32) -> std::io::Result<Looked> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;

    // A folder needs only search rights this way; a link answers ENOTDIR and is opened as itself.
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_SEARCH | libc::O_NOFOLLOW)
        .open(path)
    {
        Err(error) if error.raw_os_error() == Some(libc::ENOTDIR) => OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_SYMLINK | libc::O_EVTONLY)
            .open(path)?,
        opened => opened?,
    };
    let found = file.metadata()?;
    let others_may_change = marfa_acl::others_may_write_file(&file, me)?;
    let target = if found.file_type().is_symlink() {
        let mut buffer = vec![0u8; libc::PATH_MAX as usize];
        // SAFETY: the file is open and the buffer has the size passed.
        let length =
            unsafe { libc::freadlink(file.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
        let length = usize::try_from(length).map_err(|_| std::io::Error::last_os_error())?;
        buffer.truncate(length);
        Some(PathBuf::from(OsString::from_vec(buffer)))
    } else {
        None
    };
    Ok(Looked {
        found,
        others_may_change,
        target,
    })
}

/// Read by name: here only the entry's folder, judged first, decides who can replace it, and a
/// link keeps no access control list.
#[cfg(not(target_os = "macos"))]
fn look(path: &Path, me: u32) -> std::io::Result<Looked> {
    let found = std::fs::symlink_metadata(path)?;
    let target = if found.file_type().is_symlink() {
        Some(std::fs::read_link(path)?)
    } else {
        None
    };
    let others_may_change = found.is_dir() && marfa_acl::others_may_write(path, me)?;
    Ok(Looked {
        found,
        others_may_change,
        target,
    })
}

fn judged_on_the_way(folder: &Path, looked: &Looked, me: u32) -> Result<(), Failure> {
    let why = marfa_acl::exposure_by_mode(&looked.found, me)
        .or(looked.others_may_change.then_some(marfa_acl::Exposure::Acl));
    let Some(why) = why else {
        return Ok(());
    };
    let fix = match why {
        marfa_acl::Exposure::Link | marfa_acl::Exposure::NotFolder => {
            return Err(refused(folder, "is not a folder"));
        }
        marfa_acl::Exposure::Owner => {
            "Give it to the server's account or to root, or keep the data in another folder."
                .to_string()
        }
        marfa_acl::Exposure::Mode => format!("Run `chmod go-w {}`.", folder.display()),
        marfa_acl::Exposure::Acl => format!(
            "Remove those entries with {}.",
            marfa_acl::removal_command(false)
        ),
    };
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
    let mut folder = reached.folder;
    for name in &reached.missing {
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
        let mut files = Vec::new();
        let mut data = None;
        if let Some(database) = database_path.file() {
            let secrets = walk(&secrets_file(database_path), me)?;
            if let Some(first) = secrets.missing.first() {
                return Err(refused(&secrets.folder.join(first), "is not there"));
            }
            holds_new_files(&secrets.folder, me)?;
            let name = database
                .file_name()
                .ok_or_else(|| refused(&database, "does not end in a file name"))?;
            files.push(secrets.folder.join(&secrets.name));
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
                    secrets.folder.join(beside)
                }),
            );
            data = Some(secrets.folder);
        }
        let reached = walk(blobs, me)?;
        let path = reached.path();
        if data.as_ref().is_some_and(|data| data.starts_with(&path)) {
            return Err(refused(
                &path,
                "holds the database, and the server makes its blob folder private, which would \
                 change the other files beside the database. Give the blobs a folder of their \
                 own.",
            ));
        }
        let opened = if reached.missing.is_empty() {
            open(&path, true)?
        } else {
            None
        };
        let blobs_made = match opened {
            Some(opened) => {
                secure_blob_folder(&opened, &path, me)?;
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
            Some(opened) if reached.missing.is_empty() => secure_blob_folder(&opened, &path, me),
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
        (Exposure::Mode(_), false) => {
            "It belongs to another account: give it to the server's account with `chown`."
                .to_string()
        }
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

    #[cfg(target_os = "macos")]
    #[test]
    fn a_link_on_the_way_that_another_account_may_change_or_remove_refuses_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let (holder, real) = (dir.path().join("holder"), dir.path().join("real"));
        fs::create_dir(&holder).unwrap();
        fs::create_dir_all(real.join("blobs")).unwrap();
        let link = holder.join("via");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let blobs = link.join("blobs");
        let chmod_acl = |args: &[&std::ffi::OsStr]| {
            let done = std::process::Command::new("/bin/chmod").args(args).status();
            assert!(done.unwrap().success());
        };
        // The witness: the same link, with nothing granted, leads to the blob folder.
        kept(dir.path(), &blobs).unwrap();
        chmod_acl(&[
            "-h".as_ref(),
            "+a".as_ref(),
            "everyone allow delete".as_ref(),
            link.as_ref(),
        ]);
        let failure = kept(dir.path(), &blobs).err().expect("refused");
        assert!(failure.message.contains("access control list"), "{failure}");
        assert!(
            failure.message.contains(link.to_str().unwrap()),
            "{failure}"
        );
        chmod_acl(&["-h".as_ref(), "-N".as_ref(), link.as_ref()]);
        kept(dir.path(), &blobs).unwrap();
        chmod_acl(&[
            "+a".as_ref(),
            "everyone allow delete_child".as_ref(),
            holder.as_ref(),
        ]);
        let failure = kept(dir.path(), &blobs).err().expect("refused");
        assert!(failure.message.contains("access control list"), "{failure}");
        assert!(
            failure.message.contains(holder.to_str().unwrap()),
            "{failure}"
        );
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

    #[test]
    fn an_in_memory_database_keeps_no_file_and_judges_no_folder_for_one() {
        let dir = tempfile::tempdir().unwrap();
        let (open, private) = (dir.path().join("open"), dir.path().join("private"));
        fs::create_dir(&open).unwrap();
        fs::create_dir(&private).unwrap();
        // The witness: a database file in this folder is refused.
        chmod(&open, 0o777);
        let failure = kept(&open, &private.join("blobs")).err().expect("refused");
        assert!(
            failure.message.contains("written by another account"),
            "{failure}"
        );
        std::env::set_current_dir(&open).unwrap();
        for memory in [
            DatabasePath::Memory,
            DatabasePath::Uri("file::memory:".into()),
            DatabasePath::Uri("file:marfa.db?mode=memory".into()),
        ] {
            Kept::closed(&memory, &private.join("blobs")).unwrap();
        }
        assert_eq!(fs::read_dir(&open).unwrap().count(), 0);
    }

    #[test]
    fn a_blob_folder_that_holds_the_database_refuses_the_start_and_nothing_changes() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        fs::create_dir(&data).unwrap();
        fs::write(data.join("notes.txt"), "").unwrap();
        chmod(&data, 0o755);
        chmod(&data.join("notes.txt"), 0o644);
        // The witness: a blob folder beside the database's folder is made private.
        let beside = dir.path().join("blobs");
        fs::create_dir(&beside).unwrap();
        chmod(&beside, 0o755);
        kept(&data, &beside).unwrap();
        assert_eq!(mode(&beside), 0o700);
        for blobs in [data.clone(), data.join("."), dir.path().to_path_buf()] {
            let failure = kept(&data, &blobs).err().expect("refused");
            assert!(failure.message.contains("holds the database"), "{failure}");
            assert_eq!((mode(&data), mode(&data.join("notes.txt"))), (0o755, 0o644));
        }
    }

    #[test]
    fn a_folder_on_the_way_whose_access_control_list_lets_another_account_write_refuses_the_start()
    {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared");
        let blobs = shared.join("blobs");
        fs::create_dir_all(&blobs).unwrap();
        // The witness: with nothing granted, the folder above leads to the blob folder.
        kept(dir.path(), &blobs).unwrap();
        if !let_another_account(&shared, Grant::Write) {
            eprintln!("skipped: this file system keeps no access control lists");
            return;
        }
        chmod(&blobs, 0o755);
        let failure = kept(dir.path(), &blobs).err().expect("refused");
        // Here a grant to a named account also shows as group write, through the mask.
        let says = if cfg!(target_os = "macos") {
            "access control list"
        } else {
            "written by another account"
        };
        assert!(failure.message.contains(says), "{failure}");
        assert!(
            failure.message.contains(shared.to_str().unwrap()),
            "{failure}"
        );
        assert_eq!(mode(&blobs), 0o755);
    }
}
