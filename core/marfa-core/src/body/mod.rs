//! A body's links and embeds as edges: how a body is read, and the item each
//! name in it names. A folder reads its files by this rule, and so does every
//! write through a working copy.

pub(crate) mod embed;
pub(crate) mod resolve;
pub(crate) mod text;
