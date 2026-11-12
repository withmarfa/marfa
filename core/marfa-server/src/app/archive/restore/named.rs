//! The files an archive's manifest names, read from the start of the archive alone.

use std::io;

use futures_util::StreamExt;
use serde_json::Value;

use super::intake::{MANIFEST, TEXT_CAP};
use super::untar::{Part, Reader};
use crate::app::blobs::{ByteStream, Hash};

enum Stop {
    Read,
    NotAnArchive,
}

/// Every file the manifest names, or `None` for bytes that do not begin with a manifest.
pub async fn files_named(mut bytes: ByteStream) -> io::Result<Option<Vec<Hash>>> {
    let mut reader = Reader::default();
    let mut manifest: Option<Vec<u8>> = None;
    let mut read = false;
    while !read {
        let Some(chunk) = bytes.next().await else {
            return Ok(None);
        };
        let chunk = chunk?;
        let fed = reader.feed(
            &chunk,
            |part| match part {
                Part::Begins { name, size } => {
                    if manifest.is_some() || name != MANIFEST || size > TEXT_CAP as u64 {
                        return Err(Stop::NotAnArchive);
                    }
                    manifest = Some(Vec::with_capacity(size as usize));
                    Ok(())
                }
                Part::Bytes(part) => match manifest.as_mut() {
                    Some(held) => {
                        held.extend_from_slice(part);
                        Ok(())
                    }
                    None => Err(Stop::NotAnArchive),
                },
                Part::Ends => Err(Stop::Read),
                Part::Closed => Err(Stop::NotAnArchive),
            },
            |_| Stop::NotAnArchive,
        );
        match fed {
            Ok(()) => {}
            Err(Stop::Read) => read = true,
            Err(Stop::NotAnArchive) => return Ok(None),
        }
    }
    let Some(manifest) = manifest else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || named_in(&manifest))
        .await
        .map_err(io::Error::other)
}

fn named_in(manifest: &[u8]) -> Option<Vec<Hash>> {
    let Ok(Value::Object(held)) = serde_json::from_slice::<Value>(manifest) else {
        return None;
    };
    let keys = ["blobs", "missing_blobs"]
        .into_iter()
        .filter_map(|field| held.get(field)?.as_object())
        .flat_map(|listed| listed.keys().map(String::as_str));
    let listed = held
        .get("bucket_blobs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let mut files: Vec<Hash> = keys
        .chain(listed)
        .filter_map(|hash| Hash::parse(hash).ok())
        .collect();
    files.sort_by(|a, b| a.as_str().cmp(b.as_str()));
    files.dedup();
    Some(files)
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

    #[tokio::test]
    async fn names_every_file_the_manifest_lists_and_reads_no_further() {
        let manifest = format!(
            r#"{{"missing_blobs":{{"{a}":{{}},"{b}":{{}}}},"blobs":{{}},"bucket_blobs":["{b}","{c}","not a hash"]}}"#,
            a = hash('a'),
            b = hash('b'),
            c = hash('c'),
        );
        let mut bytes = archive(&[("manifest.json", manifest.as_bytes())]);
        bytes.truncate(BLOCK + manifest.len());
        let named = files_named(chunked(bytes)).await.unwrap().unwrap();
        let named: Vec<&str> = named.iter().map(Hash::as_str).collect();
        assert_eq!(named, [hash('a'), hash('b'), hash('c')]);
    }

    #[tokio::test]
    async fn names_nothing_for_bytes_that_do_not_begin_with_a_manifest() {
        let other = archive(&[("items.ndjson.gz", b"x"), ("manifest.json", b"{}")]);
        assert!(files_named(chunked(other)).await.unwrap().is_none());
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
