//! `app` holds what the server does and names no axum type, `db` is the only code that
//! opens SQLite, and `http` is the only place that names axum.

#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::disallowed_methods)
)]

pub mod app;
pub mod control_socket;
pub mod db;
pub mod failure;
pub mod folder_lock;
pub mod http;
pub mod listener;
pub mod log;
pub mod open_files;
pub mod private_files;
pub mod run;
pub mod server_lock;
pub mod settings;
pub mod telemetry;
