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

/// What the server is started with: everything the settings file holds, and
/// then this folder's paths and the port, which the settings file cannot set.
pub fn environment(dir: &Path, port: u16, settings: &EnvFile) -> Vec<(String, String)> {
    let layout = Layout::new(dir);
    let path = |path: PathBuf| path.to_string_lossy().into_owned();
    let mut environment: Vec<(String, String)> = settings
        .entries()
        .into_iter()
        .filter(|(name, _)| !names::FOLDER_DECIDED.contains(&name.as_str()))
        .collect();
    environment.extend([
        (names::PORT.to_string(), port.to_string()),
        (names::LISTEN_HOST.to_string(), "127.0.0.1".to_string()),
        (names::DATABASE_PATH.to_string(), path(layout.database())),
        (names::BLOB_PATH.to_string(), path(layout.blobs())),
        (names::CONTROL_SOCKET.to_string(), path(layout.socket())),
    ]);
    environment
}

/// A settings file that sets what the install folder decides is refused,
/// naming each setting.
pub fn refuse_folder_settings(settings: &EnvFile, file: &Path) -> Result<(), CliError> {
    let set: Vec<&str> = names::FOLDER_DECIDED
        .into_iter()
        .filter(|name| settings.get(name).is_some())
        .collect();
    if set.is_empty() {
        return Ok(());
    }
    Err(CliError::Usage(format!(
        "{} sets {}, which the install folder decides for a native server (the port is in .env, the data and the socket are under data/): remove {} from it",
        file.display(),
        set.join(", "),
        if set.len() == 1 { "it" } else { "them" },
    )))
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

/// `marfa-server` beside the real path of `marfa`, and nowhere else: a server
/// found on the path could be any program.
pub fn find_server(real_exe: &Path) -> Option<PathBuf> {
    real_exe
        .parent()
        .map(|dir| dir.join("marfa-server"))
        .filter(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_paths_are_the_folders_and_the_settings_file_cannot_move_them() {
        let dir = Path::new("/srv/marfa");
        let layout = Layout::new(dir);
        assert_eq!(layout.database(), Path::new("/srv/marfa/data/marfa.db"));
        assert_eq!(layout.blobs(), Path::new("/srv/marfa/data/blobs"));
        assert_eq!(
            layout.socket(),
            Path::new("/srv/marfa/data/control/marfa.sock")
        );

        let settings = EnvFile::parse(
            "MARFA_KEY_SALT=aa\nMARFA_AUTH_SECRET=bb\nMARFA_PORT=9000\nMARFA_LISTEN_HOST=0.0.0.0\nMARFA_DATABASE_PATH=/elsewhere/a.db\nMARFA_BLOB_PATH=/elsewhere/b\nMARFA_CONTROL_SOCKET=/elsewhere/s\n",
        );
        let built = environment(dir, 8601, &settings);
        let get = |name: &str| {
            built
                .iter()
                .find(|(set, _)| set == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("MARFA_PORT"), Some("8601"));
        assert_eq!(get("MARFA_LISTEN_HOST"), Some("127.0.0.1"));
        assert_eq!(get("MARFA_DATABASE_PATH"), Some("/srv/marfa/data/marfa.db"));
        assert_eq!(get("MARFA_BLOB_PATH"), Some("/srv/marfa/data/blobs"));
        assert_eq!(
            get("MARFA_CONTROL_SOCKET"),
            Some("/srv/marfa/data/control/marfa.sock")
        );
        assert_eq!(get("MARFA_KEY_SALT"), Some("aa"));
        for name in names::FOLDER_DECIDED {
            assert_eq!(built.iter().filter(|(n, _)| n == name).count(), 1, "{name}");
        }
    }

    #[test]
    fn a_settings_file_that_sets_what_the_folder_decides_is_refused_by_name() {
        let file = Path::new("/srv/marfa/marfa.env");
        let clean = EnvFile::parse("MARFA_KEY_SALT=aa\nMARFA_AUTH_SECRET=bb\n");
        assert!(refuse_folder_settings(&clean, file).is_ok());
        for name in names::FOLDER_DECIDED {
            let error = refuse_folder_settings(&EnvFile::parse(&format!("{name}=x\n")), file)
                .unwrap_err()
                .to_string();
            assert!(error.contains(name), "{error}");
        }
        let error =
            refuse_folder_settings(&EnvFile::parse("MARFA_PORT=1\nMARFA_BLOB_PATH=/x\n"), file)
                .unwrap_err()
                .to_string();
        assert!(error.contains("MARFA_PORT, MARFA_BLOB_PATH"), "{error}");
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
            assert_eq!(
                stable_binary(Path::new(real), run_by.clone()),
                run_by,
                "{real}"
            );
        }
    }

    #[test]
    fn the_server_is_found_beside_marfa_and_nowhere_else() {
        let dir = std::env::temp_dir().join(format!("marfa-find-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (beside, elsewhere) = (dir.join("beside"), dir.join("elsewhere"));
        std::fs::create_dir_all(&beside).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let exe = beside.join("marfa");
        std::fs::write(elsewhere.join("marfa-server"), "").unwrap();
        assert_eq!(find_server(&exe), None, "a server on the path is not used");
        std::fs::write(beside.join("marfa-server"), "").unwrap();
        assert_eq!(find_server(&exe), Some(beside.join("marfa-server")));
    }
}
