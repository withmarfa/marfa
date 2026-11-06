use std::path::PathBuf;

use clap::Parser;

/// The settings the server reads, each from the environment variable the
/// contract names. A variable this build does not know is ignored.
#[derive(Parser, Debug, Clone)]
#[command(name = "marfa-server", version, about)]
pub struct Settings {
    /// The public HTTP port; 0 picks a free one.
    #[arg(long, env = "PORT", default_value_t = 8600)]
    pub port: u16,

    /// The address the public HTTP listener binds to. Unset binds the
    /// unspecified address, IPv6 where available.
    #[arg(long, env = "MARFA_LISTEN_HOST")]
    pub listen_host: Option<String>,

    #[arg(long, env = "SQLITE_PATH", default_value = "./data/marfa.db")]
    pub sqlite_path: PathBuf,

    /// The private local command's socket. Unset is `control/marfa.sock`
    /// beside the database.
    #[arg(long, env = "MARFA_CONTROL_SOCKET")]
    pub control_socket: Option<PathBuf>,

    /// Serve the control socket alone, with no public listener.
    #[arg(long, env = "MARFA_CONTROL_ONLY", default_value = "false", value_parser = boolean)]
    pub control_only: bool,

    #[arg(long, env = "MARFA_TEST_HOOKS", default_value = "false", value_parser = boolean)]
    pub test_hooks: bool,

    /// Milliseconds the clock runs ahead of the system's, honoured only with
    /// test hooks on.
    #[arg(
        long,
        env = "MARFA_TEST_CLOCK_OFFSET_MS",
        default_value_t = 0,
        allow_negative_numbers = true
    )]
    pub test_clock_offset_ms: i64,

    /// How long a write waits on SQLite's lock before it is refused.
    #[arg(long, env = "SQLITE_BUSY_BUDGET_MS", default_value_t = 5000)]
    pub busy_budget_ms: u64,

    #[arg(long, env = "BLOB_PATH", default_value = "./data/blobs")]
    pub blob_path: PathBuf,

    #[arg(long, env = "MARFA_DISK_RESERVE_BYTES", default_value_t = 128 * 1024 * 1024)]
    pub disk_reserve_bytes: u64,

    #[arg(long, env = "MARFA_MAX_REQUEST_BYTES", default_value_t = 1024 * 1024)]
    pub max_request_bytes: usize,

    /// The HMAC key API key hashes are made with.
    #[arg(long, env = "API_KEY_SALT", hide_env_values = true)]
    pub api_key_salt: Option<String>,

    /// Read and kept for the sign-in this slice does not serve yet.
    #[arg(long, env = "MARFA_AUTH_SECRET", hide_env_values = true)]
    pub auth_secret: Option<String>,

    /// SQLite's `synchronous` on every connection. Unset keeps SQLite's own
    /// default.
    #[arg(long, env = "MARFA_SQLITE_SYNCHRONOUS")]
    pub sqlite_synchronous: Option<String>,

    /// SQLite's `cache_size` on every connection. Unset keeps SQLite's own.
    #[arg(long, env = "MARFA_SQLITE_CACHE_SIZE", allow_negative_numbers = true)]
    pub sqlite_cache_size: Option<i64>,

    /// SQLite's `mmap_size` on every connection. Unset keeps SQLite's own.
    #[arg(long, env = "MARFA_SQLITE_MMAP_SIZE")]
    pub sqlite_mmap_size: Option<i64>,

    /// Connections kept open for reads, beside the one writer.
    #[arg(long, env = "MARFA_SQLITE_READERS", default_value_t = 4)]
    pub sqlite_readers: usize,
}

impl Settings {
    pub fn control_socket(&self) -> PathBuf {
        match &self.control_socket {
            Some(path) => path.clone(),
            None => self
                .sqlite_path
                .parent()
                .map(|dir| dir.join("control"))
                .unwrap_or_else(|| PathBuf::from("control"))
                .join("marfa.sock"),
        }
    }
}

fn boolean(text: &str) -> Result<bool, String> {
    match text.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "{text:?} is not a boolean: use true, 1, yes, on, false, 0, no or off"
        )),
    }
}
