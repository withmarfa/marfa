//! A folder's placed files counted by directory, from the `path` of each `in-folder` edge.

use std::collections::BTreeMap;

use rusqlite::Transaction;

use super::read::from_reach;
use super::rows::{self, Placed};
use crate::app::access::Caller;
use crate::app::catalog::Catalog;
use crate::app::refusal::Result;

const MOST_CHARACTERS: usize = 1024;

pub struct Directory {
    pub path: String,
    pub direct_files: i64,
    pub all_files: i64,
    pub has_directories: bool,
}

pub struct Tree {
    pub direct_files: i64,
    pub total_files: i64,
    pub directories: Vec<Directory>,
}

fn names(path: &str) -> impl Iterator<Item = &str> {
    path.split('/')
        .filter(|name| !name.is_empty() && *name != ".")
}

pub fn under_names(text: &str) -> Option<Vec<String>> {
    if text.chars().count() > MOST_CHARACTERS
        || marfa_rules::edges::depth_below_root(text).is_none()
    {
        return None;
    }
    Some(names(text).map(str::to_string).collect())
}

#[derive(Default)]
struct Children(BTreeMap<String, (i64, i64)>);

impl Children {
    fn add(&mut self, name: &str, direct: i64, deeper: i64) {
        let held = self.0.entry(name.to_string()).or_default();
        held.0 += direct;
        held.1 += deeper;
    }
}

fn count_by_name(path: &str, under: &[String], here: &mut i64, children: &mut Children) -> bool {
    let mut path: Vec<&str> = names(path).collect();
    if path.pop().is_none() {
        return false;
    }
    if path.len() < under.len() || path.iter().zip(under).any(|(name, held)| name != held) {
        return true;
    }
    match path.get(under.len()) {
        None => *here += 1,
        Some(name) if path.len() == under.len() + 1 => children.add(name, 1, 0),
        Some(name) => children.add(name, 0, 1),
    }
    true
}

pub fn directories(
    tx: &Transaction<'_>,
    caller: &Caller,
    catalog: &Catalog,
    folder_id: &str,
    under: &[String],
) -> Result<Tree> {
    let reach = from_reach(tx, caller, catalog)?;
    let mut prefix = under.join("/");
    if !prefix.is_empty() {
        prefix.push('/');
    }
    let Placed {
        tallies,
        tidy,
        untidy,
    } = rows::placed(tx, folder_id, &prefix, reach.as_ref())?;
    let (mut here, mut children, mut total) = (0, Children::default(), tidy);
    for tally in tallies {
        match tally.name {
            Some(name) => children.add(&name, tally.direct, tally.deeper),
            None => here += tally.direct,
        }
    }
    for path in untidy {
        total += i64::from(count_by_name(&path, under, &mut here, &mut children));
    }
    let directories = children
        .0
        .into_iter()
        .map(|(name, (direct, deeper))| Directory {
            path: format!("{prefix}{name}"),
            direct_files: direct,
            all_files: direct + deeper,
            has_directories: deeper > 0,
        })
        .collect();
    Ok(Tree {
        direct_files: here,
        total_files: total,
        directories,
    })
}
