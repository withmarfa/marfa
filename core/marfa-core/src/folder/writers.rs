//! Whether a program holds a file open for writing, asked of a file this
//! process holds open read-only.
//!
//! Linux answers from the kernel with a read lease, which it refuses while
//! any process holds the file open for writing. macOS has no such lease for
//! an application, so it answers from one look at the open files of every
//! process this user runs. Processes of root and of other accounts are
//! outside the look, so a file another account may write answers unknown.

use serde::{Deserialize, Serialize};
use std::fs::File;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Writers {
    /// No program holds it open for writing.
    None,
    /// A program holds it open for writing.
    Open,
    /// The platform, the volume or the file's permissions leave it unknown.
    Unknown,
}

/// What a folder knows of the files programs hold open for writing.
///
/// On macOS one census of this user's processes, taken when first asked and
/// kept until [`Census::fresh`] or for `CENSUS_KEPT`: a program that opens a
/// file after the census is not in it. Elsewhere each answer asks the kernel.
#[derive(Default)]
pub(crate) struct Census {
    #[cfg(target_os = "macos")]
    taken: std::sync::Mutex<Option<(std::time::Instant, std::sync::Arc<darwin::Snapshot>)>>,
}

/// How long one census answers, which bounds how stale an answer is in a
/// long pass.
#[cfg(target_os = "macos")]
const CENSUS_KEPT: std::time::Duration = std::time::Duration::from_secs(1);

impl Census {
    /// Forgets the census taken, so the next answer takes another.
    pub(crate) fn fresh(&self) {
        #[cfg(target_os = "macos")]
        {
            *self
                .taken
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        }
    }

    /// Whether an answer of [`Census::of`] covers every program that opened
    /// the file before it was asked. Where it does not, only a census taken
    /// after a moment covers what opened the file before that moment.
    pub(crate) fn current(&self) -> bool {
        cfg!(target_os = "linux")
    }

    /// Whether a program holds `file` open for writing. `file` must be open
    /// read-only in this process while it is asked.
    pub(crate) fn of(&self, file: &File) -> Writers {
        if forced("writers-unknown") {
            return Writers::Unknown;
        }
        if forced("writers-open") {
            return Writers::Open;
        }
        self.asked(file)
    }

    #[cfg(target_os = "linux")]
    fn asked(&self, file: &File) -> Writers {
        linux::of(file)
    }

    #[cfg(target_os = "macos")]
    fn asked(&self, file: &File) -> Writers {
        let snapshot = {
            let mut taken = self
                .taken
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let now = std::time::Instant::now();
            match &*taken {
                Some((at, snapshot)) if now.duration_since(*at) < CENSUS_KEPT => {
                    std::sync::Arc::clone(snapshot)
                }
                _ => {
                    let snapshot = std::sync::Arc::new(darwin::take());
                    *taken = Some((now, std::sync::Arc::clone(&snapshot)));
                    snapshot
                }
            }
        };
        darwin::of(file, &snapshot)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn asked(&self, _: &File) -> Writers {
        Writers::Unknown
    }
}

/// Whether a test or a fixture makes every answer `point`'s.
fn forced(point: &str) -> bool {
    #[cfg(debug_assertions)]
    return crate::fault::fails(|| point) || crate::fault::named(point).is_some();
    #[cfg(not(debug_assertions))]
    {
        let _ = point;
        false
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::Writers;
    use std::fs::File;
    use std::os::fd::AsRawFd;

    // A program on another machine writes a network volume unseen by this
    // kernel's leases.
    const NETWORK: [u32; 8] = [
        0x6969,      // NFS
        0x517B,      // SMB
        0xFE53_4D42, // SMB2
        0xFF53_4D42, // CIFS
        0x6573_5546, // FUSE
        0x00C3_6400, // Ceph
        0x0102_1997, // 9P
        0x5346_414F, // AFS
    ];
    // `fcntl.h`; the libc crate leaves it out for glibc.
    const F_SETSIG: libc::c_int = 10;

    pub(super) fn of(file: &File) -> Writers {
        let fd = file.as_raw_fd();
        // SAFETY: `statfs` is plain data, written by `fstatfs` before it is read.
        let mut volume: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: the descriptor is open for as long as `file` is.
        if unsafe { libc::fstatfs(fd, &mut volume) } != 0
            || NETWORK.contains(&(volume.f_type as u32))
        {
            return Writers::Unknown;
        }
        // A writer that opens the file while the lease is held breaks it, and
        // the kernel signals the holder. The signal is one whose default is to
        // be ignored, since SIGIO's default ends the process.
        // SAFETY: the descriptor is open for as long as `file` is.
        if unsafe { libc::fcntl(fd, F_SETSIG, libc::SIGURG) } != 0 {
            return Writers::Unknown;
        }
        // SAFETY: as above.
        match unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_RDLCK) } {
            0 => {
                // SAFETY: as above.
                unsafe { libc::fcntl(fd, libc::F_SETLEASE, libc::F_UNLCK) };
                Writers::None
            }
            _ => match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EAGAIN) => Writers::Open,
                // Not the file's owner, a volume with no leases, or leases
                // turned off.
                _ => Writers::Unknown,
            },
        }
    }
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::Writers;
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ProcFileinfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct VnodeFdinfo {
        pfi: ProcFileinfo,
        pvi: libc::vnode_info,
    }

    // From `sys/proc_info.h`.
    const PROC_UID_ONLY: u32 = 4;
    const PROC_PIDFDVNODEINFO: i32 = 1;
    const FWRITE: u32 = 0x2;

    /// A file by its device and inode.
    type Vnode = (u32, u64);

    pub(super) struct Snapshot {
        /// Every file a process of this user holds open for writing.
        writing: HashSet<Vnode>,
        /// Every file this process holds open, which a file asked about must
        /// be among, as witness that the census saw the files it was asked of.
        held: HashSet<Vnode>,
        /// Whether every process of this user was read.
        whole: bool,
    }

    pub(super) fn of(file: &File, snapshot: &Snapshot) -> Writers {
        let Ok(metadata) = file.metadata() else {
            return Writers::Unknown;
        };
        let vnode = (metadata.dev() as u32, metadata.ino());
        if snapshot.writing.contains(&vnode) {
            return Writers::Open;
        }
        // SAFETY: `geteuid` has no preconditions.
        let me = unsafe { libc::geteuid() };
        let others_may_write = metadata.mode() & 0o022 != 0
            || metadata.uid() != me
            || marfa_acl::others_may_write_file(file, me).unwrap_or(true);
        if !snapshot.whole || !snapshot.held.contains(&vnode) || others_may_write || !local(file) {
            return Writers::Unknown;
        }
        Writers::None
    }

    /// Whether `file` is on a volume of this machine, which no program on
    /// another machine writes.
    fn local(file: &File) -> bool {
        // SAFETY: `statfs` is plain data, written by `fstatfs` before it is read.
        let mut volume: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: the descriptor is open for as long as `file` is.
        let read = unsafe { libc::fstatfs(file.as_raw_fd(), &mut volume) };
        read == 0 && volume.f_flags & libc::MNT_LOCAL as u32 != 0
    }

    pub(super) fn take() -> Snapshot {
        let mut snapshot = Snapshot {
            writing: HashSet::new(),
            held: HashSet::new(),
            whole: true,
        };
        // SAFETY: `geteuid` and `getpid` have no preconditions.
        let (me, this) = unsafe { (libc::geteuid(), libc::getpid()) };
        let Some(pids) = processes(me) else {
            snapshot.whole = false;
            return snapshot;
        };
        for pid in pids {
            let Some(fds) = descriptors(pid, &mut snapshot.whole) else {
                continue;
            };
            for fd in fds {
                if fd.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
                    continue;
                }
                let Some(info) = vnode(pid, fd.proc_fd, &mut snapshot.whole) else {
                    continue;
                };
                let found = (info.pvi.vi_stat.vst_dev, info.pvi.vi_stat.vst_ino);
                if pid == this {
                    snapshot.held.insert(found);
                }
                if info.pfi.fi_openflags & FWRITE != 0 {
                    snapshot.writing.insert(found);
                }
            }
        }
        snapshot
    }

    fn processes(uid: u32) -> Option<Vec<i32>> {
        let mut pids = vec![0i32; 4096];
        loop {
            let room = i32::try_from(pids.len() * size_of::<i32>()).ok()?;
            // SAFETY: the buffer holds `room` bytes.
            let filled = unsafe {
                libc::proc_listpids(PROC_UID_ONLY, uid, pids.as_mut_ptr().cast::<c_void>(), room)
            };
            if filled <= 0 {
                return None;
            }
            // A full buffer may have left some out.
            if filled >= room {
                pids.resize(pids.len() * 2, 0);
                continue;
            }
            pids.truncate(filled as usize / size_of::<i32>());
            pids.retain(|pid| *pid > 0);
            return Some(pids);
        }
    }

    fn descriptors(pid: i32, whole: &mut bool) -> Option<Vec<libc::proc_fdinfo>> {
        let blank = libc::proc_fdinfo {
            proc_fd: 0,
            proc_fdtype: 0,
        };
        let mut fds = vec![blank; 256];
        loop {
            let room = i32::try_from(fds.len() * size_of::<libc::proc_fdinfo>()).ok()?;
            // SAFETY: the buffer holds `room` bytes.
            let filled = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDLISTFDS,
                    0,
                    fds.as_mut_ptr().cast::<c_void>(),
                    room,
                )
            };
            if filled < 0 {
                // A process that ended holds nothing open.
                if errno() != libc::ESRCH {
                    *whole = false;
                }
                return None;
            }
            if filled >= room {
                fds.resize(fds.len() * 2, blank);
                continue;
            }
            fds.truncate(filled as usize / size_of::<libc::proc_fdinfo>());
            return Some(fds);
        }
    }

    fn vnode(pid: i32, fd: i32, whole: &mut bool) -> Option<VnodeFdinfo> {
        // SAFETY: `VnodeFdinfo` is plain data, written by the call before it is read.
        let mut info: VnodeFdinfo = unsafe { std::mem::zeroed() };
        let size = size_of::<VnodeFdinfo>() as i32;
        // SAFETY: `__error` answers this thread's `errno`, which a failed call
        // may leave as it was.
        unsafe { *libc::__error() = 0 };
        // SAFETY: `info` holds `size` bytes.
        let filled = unsafe {
            libc::proc_pidfdinfo(
                pid,
                fd,
                PROC_PIDFDVNODEINFO,
                (&raw mut info).cast::<c_void>(),
                size,
            )
        };
        if filled == size {
            return Some(info);
        }
        match errno() {
            // Closed or ended since the list.
            libc::EBADF | libc::ESRCH => {}
            // The system withholds a few files, such as those under data
            // vault protection, even from their own user, while it shows the
            // rest of the process's files. This process could not have
            // opened such a file to ask about it.
            libc::EPERM => {}
            _ => *whole = false,
        }
        None
    }

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_writer_this_test_holds_open_answers_open_and_none_once_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "first\n").unwrap();
        let census = Census::default();
        let read = File::open(&path).unwrap();
        // Witness: the same file with no writer is seen as such.
        assert_eq!(census.of(&read), Writers::None);

        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writer.write_all(b"second\n").unwrap();
        census.fresh();
        assert_eq!(census.of(&read), Writers::Open);

        drop(writer);
        census.fresh();
        assert_eq!(census.of(&read), Writers::None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_census_answers_from_what_it_saw_until_it_is_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "first\n").unwrap();
        let census = Census::default();
        let read = File::open(&path).unwrap();
        assert_eq!(census.of(&read), Writers::None);
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            census.of(&read),
            Writers::None,
            "the census predates the writer"
        );
        census.fresh();
        assert_eq!(census.of(&read), Writers::Open);
        drop(writer);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_the_census_did_not_see_held_answers_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "first\n").unwrap();
        let census = Census::default();
        let other = dir.path().join("other.md");
        std::fs::write(&other, "other\n").unwrap();
        let first = File::open(&other).unwrap();
        assert_eq!(census.of(&first), Writers::None);
        let read = File::open(&path).unwrap();
        assert_eq!(census.of(&read), Writers::Unknown);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_file_another_account_may_write_answers_unknown() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "first\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        let read = File::open(&path).unwrap();
        assert_eq!(Census::default().of(&read), Writers::Unknown);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_writer_in_another_process_answers_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "first\n").unwrap();
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg("exec 3>>\"$1\"; read line")
            .arg("sh")
            .arg(&path)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let read = File::open(&path).unwrap();
        let census = Census::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while census.of(&read) != Writers::Open {
            assert!(
                std::time::Instant::now() < deadline,
                "the writer was never seen"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        drop(child.stdin.take());
        child.wait().unwrap();
        assert_eq!(census.of(&read), Writers::None);
    }
}
