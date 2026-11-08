//! The names of the server's settings that this command writes or reads. A
//! rename in the server is one edit here.

pub const PORT: &str = "PORT";
pub const LISTEN_HOST: &str = "MARFA_LISTEN_HOST";
pub const SQLITE_PATH: &str = "SQLITE_PATH";
pub const BLOB_PATH: &str = "BLOB_PATH";
pub const CONTROL_SOCKET: &str = "MARFA_CONTROL_SOCKET";
pub const API_KEY_SALT: &str = "API_KEY_SALT";
pub const AUTH_SECRET: &str = "MARFA_AUTH_SECRET";
pub const PROXY_CIDRS: &str = "TRUSTED_PROXY_CIDRS";
pub const PROXY_HEADER: &str = "TRUSTED_PROXY_HEADER";

/// The two secrets, made once.
pub const SECRETS: [&str; 2] = [API_KEY_SALT, AUTH_SECRET];

/// The settings the install folder decides for a native server. `run` sets
/// them from the folder and `.env`, and `install` refuses a settings file that
/// sets one, because the data, the socket and the port are the folder's.
pub const FOLDER_DECIDED: [&str; 5] = [PORT, LISTEN_HOST, SQLITE_PATH, BLOB_PATH, CONTROL_SOCKET];
