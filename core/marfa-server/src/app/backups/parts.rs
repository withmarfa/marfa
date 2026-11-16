//! A backup in parts: a manifest named for the backup, and the parts it names, each a line file
//! of the archive named by the SHA-256 of its bytes, so a part one backup shares with the last is
//! stored once.

use std::io::{self, Write};
use std::ops::Range;

use flate2::write::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::app::archive::{EDGES, FILES, INSTANCE, ITEMS, LINE_CAP, ROWS, VERSION, VERSIONS};
use crate::app::blobs::{ByteStream, Hash};

pub const FORMAT: &str = "marfa-backup";
/// The version of this layout of manifest and parts, apart from the archive version it holds.
const LAYOUT: u64 = 1;
const SUFFIX: &str = ".ndjson.gz";
/// A table whose values print to at least this many bytes is a part of its own; smaller ones
/// share a part up to it.
pub const TABLE_PART: i64 = 4 * 1024 * 1024;
/// About one table in this many ends the part of small tables it is in, by its name alone, so a
/// table added or changed moves no boundary but its own part's.
const SPREAD: u32 = 64;

/// The entries every backup has one part of, in the order the archive holds them; `rows.ndjson.gz`
/// follows in one or more.
const SINGLE: [&str; 5] = [FILES, INSTANCE, ITEMS, VERSIONS, EDGES];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub entry: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub lines: u64,
    /// For a part of rows, what marks the state of the tables it holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: String,
    pub version: u64,
    /// The archive's own manifest, which a restore checks the lines against.
    pub archive: Map<String, Value>,
    pub parts: Vec<Part>,
}

impl Manifest {
    pub fn new(archive: Map<String, Value>, parts: Vec<Part>) -> Manifest {
        Manifest {
            format: FORMAT.into(),
            version: LAYOUT,
            archive,
            parts,
        }
    }

    pub fn to_bytes(&self) -> crate::app::refusal::Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|_| {
            crate::app::refusal::Refusal::internal("a backup's manifest did not print")
        })
    }

    /// Reads a manifest, answering why it is not one this build restores.
    pub fn read(bytes: &[u8]) -> Result<Manifest, String> {
        if bytes.len() > LINE_CAP {
            return Err(format!("it is larger than {LINE_CAP} bytes"));
        }
        let manifest: Manifest = serde_json::from_slice(bytes)
            .map_err(|error| format!("it does not read as a backup's manifest: {error}"))?;
        if manifest.format != FORMAT {
            return Err(format!("it names the format {}", manifest.format));
        }
        if manifest.version != LAYOUT {
            return Err(format!(
                "it is of version {}, and this build reads version {LAYOUT}",
                manifest.version
            ));
        }
        let entries: Vec<&str> = manifest
            .parts
            .iter()
            .map(|part| part.entry.as_str())
            .collect();
        let rows = entries.get(SINGLE.len()..).unwrap_or_default();
        if entries.get(..SINGLE.len()) != Some(&SINGLE[..])
            || rows.is_empty()
            || rows.iter().any(|entry| *entry != ROWS)
        {
            return Err("it does not name one part of each line file, in order".into());
        }
        for part in &manifest.parts {
            if !is_hex(&part.sha256) || part.mark.as_deref().is_some_and(|mark| !is_hex(mark)) {
                return Err(format!("it names a part as {}", part.sha256));
            }
        }
        Ok(manifest)
    }

    /// The bytes a restore of the backup reads: its manifest and every part it names.
    pub fn size(&self, manifest: u64) -> u64 {
        self.parts.iter().fold(manifest, |total, part| {
            total.saturating_add(part.size_bytes)
        })
    }

    pub fn referenced(&self) -> impl Iterator<Item = &str> {
        self.parts.iter().map(|part| part.sha256.as_str())
    }
}

fn is_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The name a part is stored under.
pub fn name_of(sha256: &str) -> String {
    format!("{sha256}{SUFFIX}")
}

/// The hash a stored part's name gives, for a name exactly as `name_of` writes one.
pub fn parse(name: &str) -> Option<&str> {
    name.strip_suffix(SUFFIX).filter(|hex| is_hex(hex))
}

/// What the parts of rows are cut from: each carried table's item, name and printed size.
pub struct Cut<'a> {
    pub item_id: &'a str,
    pub table: &'a str,
    pub bytes: i64,
}

/// Cuts tables in archive order into the runs each part of rows holds.
pub fn groups(tables: &[Cut<'_>]) -> Vec<Range<usize>> {
    let mut groups = Vec::new();
    let (mut start, mut held) = (0, 0i64);
    for (at, table) in tables.iter().enumerate() {
        if table.bytes >= TABLE_PART {
            if start < at {
                groups.push(start..at);
            }
            groups.push(at..at + 1);
            (start, held) = (at + 1, 0);
            continue;
        }
        held = held.saturating_add(table.bytes);
        if held >= TABLE_PART || ends_a_part(table) {
            groups.push(start..at + 1);
            (start, held) = (at + 1, 0);
        }
    }
    if start < tables.len() {
        groups.push(start..tables.len());
    }
    groups
}

fn ends_a_part(table: &Cut<'_>) -> bool {
    let digest = Sha256::new()
        .chain_update(table.item_id)
        .chain_update([0])
        .chain_update(table.table)
        .finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % SPREAD == 0
}

/// What marks a run of tables' rows: the build that writes them and the batch that last changed
/// each table. A row write always names a new batch, so an equal mark means equal rows.
pub fn mark<'a>(
    writer: &str,
    tables: impl IntoIterator<Item = (&'a str, &'a str, &'a str)>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(writer);
    digest.update(format!("\n{VERSION}\n"));
    for (item_id, table, batch) in tables {
        for field in [item_id, table, batch] {
            digest.update(field);
            digest.update([0]);
        }
        digest.update(b"\n");
    }
    hex::encode(digest.finalize())
}

/// A part's bytes as they arrive, checked against what the manifest says of them.
#[derive(Default)]
pub struct Checked {
    digest: Sha256,
    size: u64,
}

impl Checked {
    pub fn update(&mut self, bytes: &[u8]) {
        self.digest.update(bytes);
        self.size += bytes.len() as u64;
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn matches(&self, part: &Part) -> bool {
        self.holds(&part.sha256, part.size_bytes)
    }

    /// Whether the bytes are `size` long and their SHA-256 is `sha256`.
    pub fn holds(&self, sha256: &str, size: u64) -> bool {
        self.size == size && hex::encode(self.digest.clone().finalize()) == sha256
    }
}

/// The error of a part whose bytes changed between being written and being stored.
#[derive(Debug)]
pub struct Changed;

impl std::fmt::Display for Changed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a part of the backup changed before it was stored")
    }
}

impl std::error::Error for Changed {}

impl Changed {
    pub fn is(error: &io::Error) -> bool {
        error.get_ref().is_some_and(|inner| inner.is::<Changed>())
    }
}

/// `bytes` as they are read, which fail before they end unless they are `part`'s, so no
/// destination takes them as whole.
pub fn checked(bytes: ByteStream, part: &Part) -> ByteStream {
    let state = (bytes, Some(Checked::default()), part.clone());
    futures_util::stream::unfold(state, |(mut bytes, checking, part)| async move {
        let mut checked = checking?;
        let changed = || Err(io::Error::other(Changed));
        match bytes.next().await {
            Some(Ok(chunk)) => {
                checked.update(&chunk);
                if checked.size() > part.size_bytes {
                    Some((changed(), (bytes, None, part)))
                } else {
                    Some((Ok(chunk), (bytes, Some(checked), part)))
                }
            }
            Some(Err(error)) => Some((Err(error), (bytes, None, part))),
            None if checked.matches(&part) => None,
            None => Some((changed(), (bytes, None, part))),
        }
    })
    .boxed()
}

/// The hashes of a `files.ndjson.gz` as its bytes arrive, one line at a time.
#[derive(Default)]
struct Hashes {
    pending: Vec<u8>,
    named: Vec<Hash>,
    broken: bool,
}

impl Hashes {
    fn take(&mut self, line: &[u8]) {
        if line.is_empty() {
            return;
        }
        let hash = serde_json::from_slice::<Value>(line)
            .ok()
            .and_then(|held| Hash::parse(held.get("hash")?.as_str()?).ok());
        match hash {
            Some(hash) => self.named.push(hash),
            None => self.broken = true,
        }
    }
}

impl Write for Hashes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut rest = bytes;
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            let mut line = std::mem::take(&mut self.pending);
            line.extend_from_slice(&rest[..at]);
            self.take(&line);
            rest = &rest[at + 1..];
        }
        if self.pending.len() + rest.len() > LINE_CAP {
            return Err(io::Error::other("a line is too long"));
        }
        self.pending.extend_from_slice(rest);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The files a backup's `files.ndjson.gz` part names, sorted, or `None` where its bytes are not
/// the part's or do not read.
pub async fn files_named(part: &Part, mut bytes: ByteStream) -> io::Result<Option<Vec<Hash>>> {
    let mut checked = Checked::default();
    let mut decoder = Some(GzDecoder::new(Hashes::default()));
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk?;
        checked.update(&chunk);
        if let Some(open) = decoder.as_mut()
            && open.write_all(&chunk).is_err()
        {
            decoder = None;
        }
    }
    if !checked.matches(part) {
        return Ok(None);
    }
    let Some(Ok(mut hashes)) = decoder.map(GzDecoder::finish) else {
        return Ok(None);
    };
    let last = std::mem::take(&mut hashes.pending);
    hashes.take(&last);
    if hashes.broken {
        return Ok(None);
    }
    let mut files: Vec<Hash> = hashes.named;
    files.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    files.dedup();
    Ok(Some(files))
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use futures_util::stream;

    use super::*;

    fn hex_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn part(entry: &str, body: &[u8]) -> Part {
        Part {
            entry: entry.into(),
            sha256: hex_of(body),
            size_bytes: body.len() as u64,
            lines: 0,
            mark: None,
        }
    }

    fn whole() -> Manifest {
        let mut parts: Vec<Part> = SINGLE
            .iter()
            .map(|entry| part(entry, entry.as_bytes()))
            .collect();
        parts.push(part(ROWS, b"a"));
        parts.push(part(ROWS, b"b"));
        Manifest::new(Map::new(), parts)
    }

    #[test]
    fn a_manifest_reads_back_as_it_was_written() {
        let manifest = whole();
        assert_eq!(
            Manifest::read(&manifest.to_bytes().unwrap()).unwrap(),
            manifest
        );
    }

    #[test]
    fn a_manifest_that_lacks_repeats_or_reorders_a_line_file_does_not_read() {
        let mut lacking = whole();
        lacking.parts.remove(2);
        let mut repeated = whole();
        repeated.parts.insert(1, repeated.parts[0].clone());
        let mut reordered = whole();
        reordered.parts.swap(1, 2);
        let mut no_rows = whole();
        no_rows.parts.truncate(SINGLE.len());
        let mut rows_between = whole();
        rows_between.parts.swap(4, 5);
        for broken in [lacking, repeated, reordered, no_rows, rows_between] {
            assert!(
                Manifest::read(&broken.to_bytes().unwrap()).is_err(),
                "{broken:?}"
            );
        }
    }

    #[test]
    fn a_manifest_naming_a_part_by_anything_but_its_hash_does_not_read() {
        for name in ["../../other/secret", &"A".repeat(64), &"a".repeat(63), ""] {
            let mut strange = whole();
            strange.parts[3].sha256 = name.to_string();
            assert!(
                Manifest::read(&strange.to_bytes().unwrap()).is_err(),
                "{name}"
            );
        }
        let mut marked = whole();
        marked.parts[5].mark = Some("not a mark".into());
        assert!(Manifest::read(&marked.to_bytes().unwrap()).is_err());
    }

    #[test]
    fn a_manifest_of_another_format_version_or_shape_does_not_read() {
        let mut other = whole();
        other.format = "marfa-archive".into();
        let mut later = whole();
        later.version = LAYOUT + 1;
        let mut extra = serde_json::to_value(whole()).unwrap();
        extra["parts"][0]["path"] = "elsewhere".into();
        for bytes in [
            other.to_bytes().unwrap(),
            later.to_bytes().unwrap(),
            serde_json::to_vec(&extra).unwrap(),
            b"\x1f\x8b not json".to_vec(),
        ] {
            assert!(Manifest::read(&bytes).is_err());
        }
    }

    #[test]
    fn a_part_is_named_by_its_hash_alone() {
        let hex = hex_of(b"part");
        assert_eq!(parse(&name_of(&hex)), Some(hex.as_str()));
        for stray in [
            hex.clone(),
            format!(".{hex}.ndjson.gz.0190a1b2.partial"),
            format!("{}.ndjson.gz", &hex[1..]),
            "notes.ndjson.gz".to_string(),
        ] {
            assert_eq!(parse(&stray), None, "{stray}");
        }
    }

    fn cut<'a>(tables: &'a [(String, i64)]) -> Vec<Cut<'a>> {
        tables
            .iter()
            .map(|(name, bytes)| Cut {
                item_id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
                table: name,
                bytes: *bytes,
            })
            .collect()
    }

    fn covered(groups: &[Range<usize>], count: usize) {
        let mut next = 0;
        for group in groups {
            assert_eq!(group.start, next);
            assert!(group.end > group.start);
            next = group.end;
        }
        assert_eq!(next, count);
    }

    async fn through_checked(chunks: &[&'static [u8]], part: &Part) -> Vec<io::Result<Bytes>> {
        let chunks: Vec<io::Result<Bytes>> = chunks
            .iter()
            .map(|chunk| Ok(Bytes::from_static(chunk)))
            .collect();
        checked(stream::iter(chunks).boxed(), part).collect().await
    }

    #[tokio::test]
    async fn checked_bytes_end_only_when_they_are_the_parts() {
        let part = part(ITEMS, b"onetwo");
        let whole = through_checked(&[b"one", b"two"], &part).await;
        assert_eq!(whole.len(), 2);
        assert!(whole.iter().all(Result::is_ok));
        let cases: [&[&'static [u8]]; 3] =
            [&[b"one", b"twx"], &[b"one", b"tw"], &[b"one", b"two", b"!"]];
        for changed in cases {
            let read = through_checked(changed, &part).await;
            let last = read.last().unwrap().as_ref().unwrap_err();
            assert!(Changed::is(last), "{changed:?}");
            assert!(read[..read.len() - 1].iter().all(Result::is_ok));
        }
    }

    #[test]
    fn a_large_table_is_a_part_of_its_own_and_small_ones_share() {
        let tables: Vec<(String, i64)> = (0..400)
            .map(|at| (format!("t{at:04}"), if at == 200 { TABLE_PART } else { 10 }))
            .collect();
        let groups = groups(&cut(&tables));
        covered(&groups, tables.len());
        assert!(groups.contains(&(200..201)));
        assert!(groups.len() > 2 && groups.len() < 60, "{}", groups.len());
    }

    #[test]
    fn small_tables_share_a_part_only_up_to_the_size_of_one() {
        let tables: Vec<(String, i64)> = (0..100)
            .map(|at| (format!("t{at:04}"), TABLE_PART / 3 + 1))
            .collect();
        let groups = groups(&cut(&tables));
        covered(&groups, tables.len());
        assert!(groups.iter().all(|group| group.len() <= 3));
    }

    #[test]
    fn a_table_added_or_grown_moves_only_the_boundaries_of_its_own_part() {
        let tables: Vec<(String, i64)> = (0..2000).map(|at| (format!("t{at:05}"), 10)).collect();
        let before = groups(&cut(&tables));
        let mut grown = tables.clone();
        grown[1000].1 = 5000;
        let mut added = tables.clone();
        added.insert(1000, ("t00999x".into(), 10));
        let names = |tables: &[(String, i64)], groups: &[Range<usize>]| -> Vec<Vec<String>> {
            groups
                .iter()
                .map(|group| tables[group.clone()].iter().map(|t| t.0.clone()).collect())
                .collect()
        };
        let was = names(&tables, &before);
        for changed in [grown, added] {
            let now = names(&changed, &groups(&cut(&changed)));
            let kept = now.iter().filter(|group| was.contains(group)).count();
            assert!(kept + 2 >= was.len(), "{kept} of {}", was.len());
        }
    }

    #[test]
    fn a_mark_changes_with_any_table_batch_or_build() {
        let base = [("i", "t", "b1"), ("i", "u", "b2")];
        let marked = mark("marfa-server 1", base);
        assert_eq!(marked, mark("marfa-server 1", base));
        assert!(is_hex(&marked));
        for other in [
            mark("marfa-server 2", base),
            mark("marfa-server 1", [("i", "t", "b1"), ("i", "u", "b3")]),
            mark("marfa-server 1", [("i", "t", "b1")]),
            mark("marfa-server 1", [("i", "tu", "b1"), ("i", "", "b2")]),
            mark("marfa-server 1", [("j", "t", "b1"), ("i", "u", "b2")]),
        ] {
            assert_ne!(marked, other);
        }
    }

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    fn streamed(bytes: Vec<u8>) -> ByteStream {
        let chunks: Vec<io::Result<Bytes>> = bytes
            .chunks(7)
            .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
            .collect();
        stream::iter(chunks).boxed()
    }

    #[tokio::test]
    async fn the_files_a_part_names_are_read_only_from_its_own_bytes() {
        let (a, b) = ("a".repeat(64), "b".repeat(64));
        let body = gzip(&format!(
            "{{\"hash\":\"sha256:{b}\",\"state\":\"lost\"}}\n{{\"hash\":\"sha256:{a}\",\"state\":\"not_carried\"}}\n"
        ));
        let named = part(FILES, &body);
        let read = files_named(&named, streamed(body.clone()))
            .await
            .unwrap()
            .unwrap();
        let read: Vec<&str> = read.iter().map(Hash::as_str).collect();
        assert_eq!(read, [format!("sha256:{a}"), format!("sha256:{b}")]);

        let mut altered = body.clone();
        let last = altered.len() - 9;
        altered[last] ^= 1;
        assert_eq!(files_named(&named, streamed(altered)).await.unwrap(), None);
        let broken = gzip("{\"state\":\"lost\"}\n");
        assert_eq!(
            files_named(&part(FILES, &broken), streamed(broken))
                .await
                .unwrap(),
            None
        );
    }
}
