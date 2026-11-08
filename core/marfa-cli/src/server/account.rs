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

/// The group with this number: its name and every account in it, named in the
/// group or having it as its primary group.
fn group_of(gid: u32) -> Option<(String, Vec<String>)> {
    let mut buffer = vec![0u8; 65_536];
    let mut group = std::mem::MaybeUninit::<libc::group>::uninit();
    let mut found: *mut libc::group = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call, and `buffer` outlives it.
    let status = unsafe {
        libc::getgrgid_r(
            gid,
            group.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() {
        return None;
    }
    // SAFETY: `getgrgid_r` filled it, since it found an entry.
    let group = unsafe { group.assume_init() };
    // SAFETY: the name is a C string in `buffer`.
    let name = unsafe { std::ffi::CStr::from_ptr(group.gr_name) }
        .to_string_lossy()
        .into_owned();
    let mut members = Vec::new();
    let mut next = group.gr_mem;
    // SAFETY: `gr_mem` is a null-terminated list of C strings in `buffer`.
    unsafe {
        while !next.is_null() && !(*next).is_null() {
            members.push(
                std::ffi::CStr::from_ptr(*next)
                    .to_string_lossy()
                    .into_owned(),
            );
            next = next.add(1);
        }
    }
    members.extend(primary_members(gid));
    Some((name, members))
}

/// Every account whose primary group is `gid`.
fn primary_members(gid: u32) -> Vec<String> {
    let mut names = Vec::new();
    // SAFETY: the command is single-threaded where it reads the account
    // database, so nothing else walks it at the same time.
    unsafe {
        libc::setpwent();
        loop {
            let entry = libc::getpwent();
            if entry.is_null() {
                break;
            }
            if (*entry).pw_gid == gid {
                names.push(
                    std::ffi::CStr::from_ptr((*entry).pw_name)
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        libc::endpwent();
    }
    names
}

/// Whether the group can be the account's own: named like the account, and
/// with nobody else in it. The unit runs the server in the group by that name,
/// and the install keeps its secrets readable by the account's primary group,
/// so any other member would read them.
fn judge_group(group: Option<(String, Vec<String>)>) -> Result<(), CliError> {
    let Some((name, members)) = group else {
        return Err(CliError::Usage(format!(
            "the {NAME} account exists and its primary group cannot be read: make a group named {NAME} that only the account belongs to, and make it the account's primary group (`usermod --gid {NAME} {NAME}`)"
        )));
    };
    let mut others: Vec<&str> = members
        .iter()
        .map(String::as_str)
        .filter(|member| *member != NAME)
        .collect();
    others.sort_unstable();
    others.dedup();
    if name == NAME && others.is_empty() {
        return Ok(());
    }
    let why = if name != NAME {
        format!("its primary group is {name}, and the server runs in the group {NAME}")
    } else {
        format!("its primary group {NAME} also holds {}", others.join(", "))
    };
    Err(CliError::Usage(format!(
        "the {NAME} account already exists, but {why}. The install keeps the server's secrets readable by the account's primary group, so every member of that group would read them. Make a group named {NAME} that only the account belongs to, and make it the account's primary group (`usermod --gid {NAME} {NAME}`), or remove the account"
    )))
}

/// Refuses an existing account whose primary group is not a group of its own
/// named like it. Nothing to check where the account is still to be made: it
/// is made with a group of its own.
pub fn check_group() -> Result<(), CliError> {
    match lookup(NAME) {
        Some(identity) => judge_group(group_of(identity.gid)),
        None => Ok(()),
    }
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
    let ran = Command::new(useradd())
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

/// Where `useradd` is, for a root whose `PATH` has no system folder.
fn useradd() -> &'static str {
    ["/usr/sbin/useradd", "/sbin/useradd", "/usr/bin/useradd"]
        .into_iter()
        .find(|path| Path::new(path).exists())
        .unwrap_or("useradd")
}

/// A command that runs as the account. Changing the user from root drops
/// root's other groups too.
pub fn command_as(identity: Identity, program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.uid(identity.uid).gid(identity.gid);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(name: &str, members: &[&str]) -> Option<(String, Vec<String>)> {
        Some((
            name.to_string(),
            members.iter().map(|member| member.to_string()).collect(),
        ))
    }

    #[test]
    fn the_account_may_have_a_group_of_its_own_named_like_it() {
        judge_group(group("marfa", &[])).unwrap();
        // Named in its own group, and as the primary group of its own entry.
        judge_group(group("marfa", &["marfa", "marfa"])).unwrap();
    }

    #[test]
    fn a_shared_group_is_refused_because_its_members_would_read_the_secrets() {
        let error = judge_group(group("users", &["alice"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("primary group is users"), "{error}");
        assert!(error.contains("every member"), "{error}");
        // Alone in it, but not the group the unit names.
        assert!(judge_group(group("users", &[])).is_err());
    }

    #[test]
    fn a_group_named_like_the_account_that_others_belong_to_is_refused() {
        let error = judge_group(group("marfa", &["marfa", "bob", "alice", "bob"]))
            .unwrap_err()
            .to_string();
        assert!(error.contains("also holds alice, bob"), "{error}");
    }

    #[test]
    fn a_group_that_cannot_be_read_is_refused() {
        assert!(judge_group(None).is_err());
    }

    #[test]
    fn the_name_and_members_of_a_real_group_are_read() {
        // The witness for the readers: the group of the user running this test
        // is found, and that user, whose primary group it is, is in it.
        // SAFETY: `getgid` cannot fail.
        let (name, members) = group_of(unsafe { libc::getgid() }).expect("the group is known");
        assert!(!name.is_empty());
        assert!(!members.is_empty(), "{name} has no member");
    }
}
