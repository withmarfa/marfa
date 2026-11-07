//! The rules of sign-in by OAuth: everything that decides on untrusted text
//! and needs no database or HTTP. The doors are built on top of these.

#![allow(dead_code)]

pub mod client;
pub mod metadata_document;
pub mod pkce;
pub mod redirect;
pub mod resource;
pub mod scope;
pub mod signed_link;
pub mod tokens;
