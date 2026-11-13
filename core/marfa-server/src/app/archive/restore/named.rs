//! The files a backup names, read from the start of its archive alone: its manifest, then
//! `files.ndjson.gz`.

use std::io::{self, Write};

use flate2::write::GzDecoder;
use futures_util::StreamExt;
use serde_json::Value;

use super::untar::{Part, Reader};
use crate::app::archive::{BLOBS, ENTRIES, FILES, FORMAT, LINE_CAP, MANIFEST, VERSION};
use crate::app::blobs::{ByteStream, Hash};

enum Stop {
    Read,
    NotAnArchive,
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

enum Reading {
    Before,
    Manifest(Vec<u8>),
    BetweenManifestAndFiles,
    Files(Box<GzDecoder<Hashes>>),
    Other,
}

/// Every file the backup names, or `None` for bytes that do not begin with a manifest of a
/// version this build reads followed by `files.ndjson.gz`. An entry it does not know is passed.
pub async fn files_named(mut bytes: ByteStream) -> io::Result<Option<Vec<Hash>>> {
    let mut reader = Reader::default();
    let mut reading = Reading::Before;
    let mut skipping = None;
    let mut done: Option<Vec<Hash>> = None;
    while done.is_none() {
        let Some(chunk) = bytes.next().await else {
            return Ok(None);
        };
        let chunk = chunk?;
        let fed = reader.feed(
            &chunk,
            |part| match part {
                Part::Begins { name, size } => {
                    let known = ENTRIES.contains(&name.as_str()) || name.starts_with(BLOBS);
                    let before = matches!(reading, Reading::Before);
                    let between = matches!(reading, Reading::BetweenManifestAndFiles);
                    match name.as_str() {
                        MANIFEST if before && size <= LINE_CAP as u64 => {
                            reading = Reading::Manifest(Vec::with_capacity(size as usize));
                        }
                        FILES if between => {
                            reading = Reading::Files(Box::new(GzDecoder::new(Hashes::default())));
                        }
                        _ if !known => {
                            skipping = Some(std::mem::replace(&mut reading, Reading::Other));
                        }
                        _ => return Err(Stop::NotAnArchive),
                    }
                    Ok(())
                }
                Part::Bytes(part) => match &mut reading {
                    Reading::Manifest(held) => {
                        held.extend_from_slice(part);
                        Ok(())
                    }
                    Reading::Files(decoder) => {
                        decoder.write_all(part).map_err(|_| Stop::NotAnArchive)
                    }
                    Reading::Other => Ok(()),
                    _ => Err(Stop::NotAnArchive),
                },
                Part::Ends => match std::mem::replace(&mut reading, Reading::Other) {
                    Reading::Manifest(held) => {
                        if !readable(&held) {
                            return Err(Stop::NotAnArchive);
                        }
                        reading = Reading::BetweenManifestAndFiles;
                        Ok(())
                    }
                    Reading::Files(decoder) => {
                        let mut hashes = decoder.finish().map_err(|_| Stop::NotAnArchive)?;
                        let last = std::mem::take(&mut hashes.pending);
                        hashes.take(&last);
                        if hashes.broken {
                            return Err(Stop::NotAnArchive);
                        }
                        done = Some(hashes.named);
                        Err(Stop::Read)
                    }
                    Reading::Other => {
                        reading = skipping.take().unwrap_or(Reading::Before);
                        Ok(())
                    }
                    _ => Err(Stop::NotAnArchive),
                },
                Part::Closed => Err(Stop::NotAnArchive),
            },
            |_| Stop::NotAnArchive,
        );
        match fed {
            Ok(()) | Err(Stop::Read) => {}
            Err(Stop::NotAnArchive) => return Ok(None),
        }
    }
    let mut files = done.unwrap_or_default();
    files.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    files.dedup();
    Ok(Some(files))
}

/// Whether a manifest names an archive of a version this build reads.
fn readable(manifest: &[u8]) -> bool {
    let Ok(Value::Object(held)) = serde_json::from_slice::<Value>(manifest) else {
        return false;
    };
    held.get("format").and_then(Value::as_str) == Some(FORMAT)
        && held
            .get("version")
            .and_then(Value::as_u64)
            .is_some_and(|version| (1..=VERSION).contains(&version))
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use futures_util::stream;

    use super::*;
    use crate::app::archive::tar::BLOCK;

    fn header(name: &str, size: usize) -> Vec<u8> {
        let mut block = vec![0u8; BLOCK];
        block[..name.len()].copy_from_slice(name.as_bytes());
        block[100..107].copy_from_slice(b"0000644");
        block[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        block[156] = b'0';
        block[148..156].copy_from_slice(b"        ");
        let sum: u32 = block.iter().map(|byte| u32::from(*byte)).sum();
        block[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        block
    }

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, body) in entries {
            out.extend(header(name, body.len()));
            out.extend_from_slice(body);
            out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
        }
        out.resize(out.len() + 2 * BLOCK, 0);
        out
    }

    /// The bytes in chunks of seven, so every boundary falls inside a block.
    fn chunked(bytes: Vec<u8>) -> ByteStream {
        let chunks: Vec<io::Result<Bytes>> = bytes
            .chunks(7)
            .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
            .collect();
        stream::iter(chunks).boxed()
    }

    fn hash(letter: char) -> String {
        format!("sha256:{}", letter.to_string().repeat(64))
    }

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    const MANIFEST_V1: &str = r#"{"format":"marfa-archive","version":1}"#;

    fn files_line(letter: char, state: &str) -> String {
        format!(
            r#"{{"hash":"{}","mime_type":null,"size_bytes":null,"state":"{state}"}}"#,
            hash(letter)
        )
    }

    #[tokio::test]
    async fn names_every_file_the_files_entry_lists_and_reads_no_further() {
        let files = gzip(&format!(
            "{}\n{}\n{}\n{}",
            files_line('a', "not_carried"),
            files_line('b', "lost"),
            files_line('b', "lost"),
            files_line('c', "carried"),
        ));
        let mut bytes = archive(&[
            ("._manifest.json", b"\x00\x05"),
            ("manifest.json", MANIFEST_V1.as_bytes()),
            ("PaxHeaders.1/files.ndjson.gz", b"path=x\n"),
            ("files.ndjson.gz", &files),
            ("instance.ndjson.gz", b"never read"),
        ]);
        let end = bytes.len() - 3 * BLOCK;
        bytes.truncate(end);
        let named = files_named(chunked(bytes)).await.unwrap().unwrap();
        let named: Vec<&str> = named.iter().map(Hash::as_str).collect();
        assert_eq!(named, [hash('a'), hash('b'), hash('c')]);
    }

    #[tokio::test]
    async fn names_nothing_for_bytes_that_do_not_begin_with_a_manifest_this_build_reads() {
        let files = gzip(&files_line('a', "carried"));
        let witness = archive(&[("manifest.json", MANIFEST_V1.as_bytes()), ("files.ndjson.gz", &files)]);
        assert!(files_named(chunked(witness)).await.unwrap().is_some());
        let other = archive(&[("items.ndjson.gz", b"x"), ("manifest.json", b"{}")]);
        assert!(files_named(chunked(other)).await.unwrap().is_none());
        for manifest in [r#"{"version":1,"blobs":{}}"#, r#"{"format":"marfa-archive","version":2}"#] {
            let old = archive(&[("manifest.json", manifest.as_bytes()), ("files.ndjson.gz", &files)]);
            assert!(files_named(chunked(old)).await.unwrap().is_none(), "{manifest}");
        }
        let no_files = archive(&[("manifest.json", MANIFEST_V1.as_bytes()), ("instance.ndjson.gz", &files)]);
        assert!(files_named(chunked(no_files)).await.unwrap().is_none());
        assert!(
            files_named(chunked(b"not a tar".repeat(100)))
                .await
                .unwrap()
                .is_none()
        );
        let short = archive(&[("manifest.json", b"{}")])[..BLOCK + 1].to_vec();
        assert!(files_named(chunked(short)).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn fails_where_the_store_fails_mid_read() {
        let failing: ByteStream = stream::iter(vec![
            Ok(Bytes::from(header("manifest.json", 10))),
            Err(io::Error::other("the store stopped")),
        ])
        .boxed();
        assert!(files_named(failing).await.is_err());
    }
}
