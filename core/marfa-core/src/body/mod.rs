//! A body's links and embeds as edges: how a body is read, and the item each
//! name in it names, held once so that every reader of a body keeps one rule.

pub(crate) mod embed;
pub(crate) mod resolve;
pub(crate) mod text;
