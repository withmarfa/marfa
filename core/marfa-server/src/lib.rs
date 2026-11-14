//! `app` holds what the server does and names no HTTP type, `db` is the only door to
//! SQLite, and `http` is the only place that names axum.

pub mod app;
pub mod control_socket;
pub mod db;
pub mod failure;
pub mod http;
pub mod listener;
pub mod log;
pub mod open_files;
pub mod private_files;
pub mod run;
pub mod settings;
pub mod telemetry;
