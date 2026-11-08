//! What the command line and the server share about telemetry, so that one
//! shell setting means the same to both: how the standard `OTEL_*` settings
//! read, which PostHog host a project token may travel to, and the shape of
//! an exception event.
//!
//! Nothing here sends anything or starts a thread. Each program brings its own
//! client and decides what it is willing to wait for.

pub mod environment;
pub mod exception;
pub mod host;
pub mod identity;
pub mod otlp;
pub mod sampler;
