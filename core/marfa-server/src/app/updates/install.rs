//! How this server was installed, which decides whether it can swap its own programs.

use std::ffi::{CString, OsStr};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use marfa_rules::environment::{INSTALL_DIR, SERVICE};

pub const IMAGE: &str = "ghcr.io/withmarfa/marfa-server";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Install {
    /// A service that restarts the server on failure, run by `marfa server run --dir` for the
    /// install folder `dir`, with programs it may replace.
    Service {
        programs: PathBuf,
        dir: PathBuf,
    },
    Container,
    Other,
}

pub struct Facts<'a> {
    pub service: Option<&'a str>,
    /// What `marfa server run --dir` set for `INSTALL_DIR`.
    pub install_dir: Option<&'a Path>,
    pub exe: &'a Path,
    pub container: bool,
    pub writable: &'a dyn Fn(&Path) -> bool,
}

pub fn detect_with(facts: &Facts<'_>) -> Install {
    if facts.container {
        return Install::Container;
    }
    let managed = matches!(facts.service, Some("launchd" | "systemd"));
    let programs = facts.exe.parent();
    let under_homebrew = facts
        .exe
        .components()
        .any(|part| part.as_os_str() == OsStr::new("Cellar"));
    let supervised = facts.install_dir.filter(|dir| dir.is_absolute());
    match (programs, supervised) {
        (Some(programs), Some(dir))
            if managed
                && !under_homebrew
                && programs.join("marfa").is_file()
                && (facts.writable)(programs) =>
        {
            Install::Service {
                programs: programs.to_path_buf(),
                dir: dir.to_path_buf(),
            }
        }
        _ => Install::Other,
    }
}

fn writable(folder: &Path) -> bool {
    CString::new(folder.as_os_str().as_bytes())
        // SAFETY: `access` reads the NUL-terminated path it is given and nothing else.
        .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0)
}

pub fn detect() -> Install {
    let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return Install::Other;
    };
    let service = std::env::var(SERVICE).ok();
    let install_dir = std::env::var_os(INSTALL_DIR).map(PathBuf::from);
    detect_with(&Facts {
        service: service.as_deref(),
        install_dir: install_dir.as_deref(),
        exe: &exe,
        container: Path::new("/.dockerenv").exists() || Path::new("/run/.containerenv").exists(),
        writable: &writable,
    })
}

/// What the owner does on the host to move to `version`, in plain words.
pub fn step(install: &Install, version: &str) -> Option<String> {
    match install {
        Install::Service { .. } => None,
        Install::Container => Some(format!(
            "Redeploy the image {IMAGE}:{version} on this host. For a server made with `marfa server install --docker`, run `marfa server upgrade --release {version}` on that machine."
        )),
        Install::Other => Some(format!(
            "Install release {version} on this host, then restart the server. `marfa server upgrade` moves a service that `marfa server install` made to the release installed beside `marfa`."
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    fn detect_in(service: Option<&str>, exe: &Path, container: bool, can_write: bool) -> Install {
        detect_with(&Facts {
            service,
            install_dir: Some(Path::new("/srv/marfa")),
            exe,
            container,
            writable: &move |_| can_write,
        })
    }

    fn folder(test: &str, with_marfa: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marfa-install-{}-{test}-{with_marfa}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["marfa-server"]
            .into_iter()
            .chain(with_marfa.then_some("marfa"))
        {
            let path = dir.join(name);
            std::fs::write(&path, "").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    #[test]
    fn a_service_with_writable_programs_beside_marfa_can_swap_them() {
        let dir = folder("service", true);
        let exe = dir.join("marfa-server");
        for manager in ["launchd", "systemd"] {
            assert_eq!(
                detect_in(Some(manager), &exe, false, true),
                Install::Service {
                    programs: dir.clone(),
                    dir: PathBuf::from("/srv/marfa"),
                }
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_else_swaps_its_programs() {
        let dir = folder("nothing", true);
        let exe = dir.join("marfa-server");
        assert_eq!(
            detect_in(None, &exe, false, true),
            Install::Other,
            "no service"
        );
        assert_eq!(detect_in(Some("cron"), &exe, false, true), Install::Other);
        assert_eq!(
            detect_in(Some("systemd"), &exe, false, false),
            Install::Other,
            "programs it cannot write"
        );
        assert_eq!(
            detect_in(Some("systemd"), &exe, true, true),
            Install::Container
        );
        let cellar = Path::new("/opt/homebrew/Cellar/marfa/0.0.70/bin/marfa-server");
        assert_eq!(
            detect_in(Some("launchd"), cellar, false, true),
            Install::Other
        );
        let alone = folder("nothing", false);
        assert_eq!(
            detect_in(Some("systemd"), &alone.join("marfa-server"), false, true),
            Install::Other,
            "no marfa beside it"
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&alone);
    }

    #[test]
    fn a_server_no_counting_marfa_started_never_swaps_its_programs() {
        let dir = folder("unsupervised", true);
        let exe = dir.join("marfa-server");
        let with = |install_dir: Option<&Path>| {
            detect_with(&Facts {
                service: Some("launchd"),
                install_dir,
                exe: &exe,
                container: false,
                writable: &|_| true,
            })
        };
        assert!(
            matches!(with(Some(Path::new("/srv/marfa"))), Install::Service { .. }),
            "the witness: started by marfa server run, it can swap them"
        );
        assert_eq!(with(None), Install::Other);
        assert_eq!(with(Some(Path::new("relative"))), Install::Other);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_the_account_cannot_write_is_not_writable_and_its_own_is() {
        let dir = folder("writable", true);
        assert!(writable(&dir));
        assert!(!writable(&dir.join("absent")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_an_install_that_cannot_swap_names_a_step() {
        let service = Install::Service {
            programs: PathBuf::from("/x"),
            dir: PathBuf::from("/srv/marfa"),
        };
        assert_eq!(step(&service, "0.0.75"), None);
        assert!(
            step(&Install::Container, "0.0.75")
                .unwrap()
                .contains("ghcr.io/withmarfa/marfa-server:0.0.75")
        );
        assert!(
            step(&Install::Other, "0.0.75")
                .unwrap()
                .contains("release 0.0.75")
        );
    }
}
