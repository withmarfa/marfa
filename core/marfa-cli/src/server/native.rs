//! A server run without Docker: where its files are, the environment it is
//! started in, and the path a service names for `marfa`.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use crate::error::CliError;
use crate::server::envfile::EnvFile;
use crate::server::names;

/// The proxy on the same machine reaches the server over the loopback.
pub const LOOPBACK_PROXIES: &str = "127.0.0.1/32,::1/128";

/// What the range above must contain for a settings file that something else
/// owns.
pub const LOOPBACK_NETWORK: &str = "127.0.0.1/32";

/// The longest path a Unix socket can be bound at on a Mac, less a margin.
const SOCKET_PATH_LIMIT: usize = 100;

pub struct Layout<'a> {
    dir: &'a Path,
}

impl<'a> Layout<'a> {
    pub fn new(dir: &'a Path) -> Self {
        Self { dir }
    }

    pub fn data(&self) -> PathBuf {
        self.dir.join("data")
    }

    pub fn database(&self) -> PathBuf {
        self.data().join("marfa.db")
    }

    pub fn blobs(&self) -> PathBuf {
        self.data().join("blobs")
    }

    pub fn socket(&self) -> PathBuf {
        self.data().join("control").join("marfa.sock")
    }

    /// A socket path the system can bind.
    pub fn check_socket(&self) -> Result<(), CliError> {
        let socket = self.socket();
        if socket.as_os_str().len() > SOCKET_PATH_LIMIT {
            return Err(CliError::Usage(format!(
                "{} is too long for the server's private socket, which a system binds at {SOCKET_PATH_LIMIT} characters or fewer: choose a shorter --dir",
                socket.display()
            )));
        }
        Ok(())
    }
}

/// What the server is started with: this folder's paths and the port, unless
/// the settings file sets them, then everything the settings file holds.
pub fn environment(dir: &Path, port: u16, settings: &EnvFile) -> Vec<(String, String)> {
    let layout = Layout::new(dir);
    let path = |path: PathBuf| path.to_string_lossy().into_owned();
    let defaults = [
        (names::PORT, port.to_string()),
        (names::LISTEN_HOST, "127.0.0.1".to_string()),
        (names::SQLITE_PATH, path(layout.database())),
        (names::BLOB_PATH, path(layout.blobs())),
        (names::CONTROL_SOCKET, path(layout.socket())),
    ];
    let mut environment = settings.entries();
    for (name, value) in defaults {
        if !environment.iter().any(|(set, _)| set == name) {
            environment.push((name.to_string(), value));
        }
    }
    environment
}

/// The path a service names for `marfa`. A binary in a Homebrew Cellar moves
/// at every upgrade, and the prefix's `bin/marfa` follows it, so that is the
/// path whenever the real path of the running binary is in a Cellar. The
/// prefix is read from the path. Any other binary is named by the path it was
/// run by.
pub fn stable_binary(real: &Path, invoked: PathBuf) -> PathBuf {
    let parts: Vec<Component> = real.components().collect();
    let cellar = parts
        .iter()
        .position(|part| part.as_os_str() == OsStr::new("Cellar"));
    match cellar {
        // <prefix>/Cellar/<formula>/<version>/bin/marfa
        Some(at) if at > 0 && parts.len() > at + 3 => {
            let prefix: PathBuf = parts[..at].iter().collect();
            prefix.join("bin").join("marfa")
        }
        _ => invoked,
    }
}

/// The path a service names for the `marfa` that is running.
pub fn stable_binary_of_this() -> Result<PathBuf, CliError> {
    let invoked = std::env::current_exe()?;
    let real = std::fs::canonicalize(&invoked)?;
    Ok(stable_binary(&real, invoked))
}

/// The private socket's checks read ACLs with `getfacl` on Linux, so an
/// install without it could not talk to its own server.
pub fn check_acl_tool() -> Result<(), CliError> {
    if !cfg!(target_os = "linux") {
        return Ok(());
    }
    let found = std::process::Command::new("getfacl")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    if found {
        return Ok(());
    }
    Err(CliError::Install(
        "`getfacl` was not found, and the server's private socket cannot be checked without it: install the acl package (`apt install acl`, `dnf install acl`)".into(),
    ))
}

/// `marfa-server` beside the real path of `marfa`, else the first on `path`.
pub fn find_server(real_exe: &Path, path: Option<&OsStr>) -> Option<PathBuf> {
    let is_program = |candidate: &PathBuf| candidate.is_file();
    let beside = real_exe.parent().map(|dir| dir.join("marfa-server"));
    beside.filter(is_program).or_else(|| {
        std::env::split_paths(path?)
            .map(|dir| dir.join("marfa-server"))
            .find(is_program)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paths_are_the_folders_and_the_environment_leaves_a_setting_alone() {
        let dir = Path::new("/srv/marfa");
        let layout = Layout::new(dir);
        assert_eq!(layout.database(), Path::new("/srv/marfa/data/marfa.db"));
        assert_eq!(layout.blobs(), Path::new("/srv/marfa/data/blobs"));
        assert_eq!(
            layout.socket(),
            Path::new("/srv/marfa/data/control/marfa.sock")
        );

        let settings = EnvFile::parse("API_KEY_SALT=aa\nMARFA_AUTH_SECRET=bb\nPORT=9000\n");
        let built = environment(dir, 8601, &settings);
        let get = |name: &str| {
            built
                .iter()
                .find(|(set, _)| set == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("PORT"), Some("9000"), "the settings file wins");
        assert_eq!(get("MARFA_LISTEN_HOST"), Some("127.0.0.1"));
        assert_eq!(get("SQLITE_PATH"), Some("/srv/marfa/data/marfa.db"));
        assert_eq!(get("BLOB_PATH"), Some("/srv/marfa/data/blobs"));
        assert_eq!(
            get("MARFA_CONTROL_SOCKET"),
            Some("/srv/marfa/data/control/marfa.sock")
        );
        assert_eq!(get("API_KEY_SALT"), Some("aa"));
        assert_eq!(built.iter().filter(|(n, _)| n == "PORT").count(), 1);
        assert_eq!(
            environment(dir, 8601, &EnvFile::default())
                .iter()
                .find(|(n, _)| n == "PORT")
                .map(|(_, v)| v.as_str()),
            Some("8601")
        );
    }

    #[test]
    fn a_socket_path_too_long_to_bind_is_refused() {
        let long = PathBuf::from(format!("/{}", "a".repeat(90)));
        assert!(Layout::new(&long).check_socket().is_err());
        assert!(Layout::new(Path::new("/srv/marfa")).check_socket().is_ok());
    }

    #[test]
    fn a_homebrew_binary_is_named_by_the_prefix_and_not_by_its_version() {
        let run_by = PathBuf::from("/usr/local/bin/marfa");
        assert_eq!(
            stable_binary(
                Path::new("/opt/homebrew/Cellar/marfa/0.0.70/bin/marfa"),
                run_by.clone()
            ),
            Path::new("/opt/homebrew/bin/marfa")
        );
        assert_eq!(
            stable_binary(
                Path::new("/usr/local/Cellar/marfa/0.0.70_1/bin/marfa"),
                run_by.clone()
            ),
            Path::new("/usr/local/bin/marfa")
        );
        assert_eq!(
            stable_binary(
                Path::new("/home/linuxbrew/.linuxbrew/Cellar/marfa/0.0.70/bin/marfa"),
                run_by.clone()
            ),
            Path::new("/home/linuxbrew/.linuxbrew/bin/marfa")
        );
    }

    #[test]
    fn any_other_binary_keeps_the_path_it_was_run_by() {
        let run_by = PathBuf::from("/home/x/.local/bin/marfa");
        for real in [
            "/home/x/.local/bin/marfa",
            "/Cellar/marfa",
            "/opt/Cellar-things/bin/marfa",
            "/opt/homebrew/Cellar/marfa",
        ] {
            assert_eq!(stable_binary(Path::new(real), run_by.clone()), run_by, "{real}");
        }
    }

    #[test]
    fn the_server_is_found_beside_marfa_first_and_then_on_the_path() {
        let dir = std::env::temp_dir().join(format!("marfa-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (beside, elsewhere) = (dir.join("beside"), dir.join("elsewhere"));
        std::fs::create_dir_all(&beside).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let exe = beside.join("marfa");
        let path = std::env::join_paths([&elsewhere]).unwrap();
        assert_eq!(find_server(&exe, Some(&path)), None);
        std::fs::write(elsewhere.join("marfa-server"), "").unwrap();
        assert_eq!(
            find_server(&exe, Some(&path)),
            Some(elsewhere.join("marfa-server"))
        );
        std::fs::write(beside.join("marfa-server"), "").unwrap();
        assert_eq!(
            find_server(&exe, Some(&path)),
            Some(beside.join("marfa-server"))
        );
        assert_eq!(find_server(&exe, None), Some(beside.join("marfa-server")));
    }
}
