//! The system account a server runs as when root installs it on Linux.

use std::ffi::CString;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

use crate::error::CliError;

pub const NAME: &str = "marfa";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pub uid: u32,
    pub gid: u32,
}

pub fn is_root() -> bool {
    // SAFETY: `geteuid` cannot fail.
    unsafe { libc::geteuid() == 0 }
}

pub fn lookup(name: &str) -> Option<Identity> {
    let name = CString::new(name).ok()?;
    let mut buffer = vec![0u8; 8192];
    let mut passwd = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call, and `buffer` outlives it.
    let status = unsafe {
        libc::getpwnam_r(
            name.as_ptr(),
            passwd.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() {
        return None;
    }
    // SAFETY: `getpwnam_r` filled it, since it found an entry.
    let passwd = unsafe { passwd.assume_init() };
    Some(Identity {
        uid: passwd.pw_uid,
        gid: passwd.pw_gid,
    })
}

/// The name `loginctl` knows the account by, or its number.
pub fn current_user() -> String {
    ["USER", "LOGNAME"]
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        // SAFETY: `getuid` cannot fail.
        .unwrap_or_else(|| unsafe { libc::getuid() }.to_string())
}

/// The account, made if it is missing, with the install's folder as its home.
pub fn ensure(dir: &Path, trace: bool) -> Result<Identity, CliError> {
    if let Some(identity) = lookup(NAME) {
        return Ok(identity);
    }
    let home = dir.to_str().ok_or_else(|| {
        CliError::Usage(format!(
            "{} is not a path an account can have as its home",
            dir.display()
        ))
    })?;
    let arguments = [
        "--system",
        "--user-group",
        "--no-create-home",
        "--home-dir",
        home,
        "--shell",
        "/usr/sbin/nologin",
        NAME,
    ];
    if trace {
        eprintln!("  $ useradd {}", arguments.join(" "));
    }
    let ran = Command::new("useradd")
        .args(arguments)
        .output()
        .map_err(|error| {
            CliError::Install(format!(
                "cannot run useradd to make the {NAME} account: {error}"
            ))
        })?;
    if !ran.status.success() {
        return Err(CliError::Install(format!(
            "`useradd` could not make the {NAME} account: {}. Make it yourself with `useradd {}`",
            String::from_utf8_lossy(&ran.stderr).trim(),
            arguments.join(" ")
        )));
    }
    lookup(NAME).ok_or_else(|| {
        CliError::Install(format!("the {NAME} account was made and cannot be found"))
    })
}

pub fn own(path: &Path, identity: Identity) -> Result<(), CliError> {
    std::os::unix::fs::chown(path, Some(identity.uid), Some(identity.gid)).map_err(|error| {
        CliError::Io(std::io::Error::new(
            error.kind(),
            format!("cannot give {NAME} {}: {error}", path.display()),
        ))
    })
}

/// A command that runs as the account. Changing the user from root drops
/// root's other groups too.
pub fn command_as(identity: Identity, program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.uid(identity.uid).gid(identity.gid);
    command
}
