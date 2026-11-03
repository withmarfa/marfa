//! `marfa export --format archive` with no `--output`, as a process: the
//! archive is the whole of standard output and the progress remarks are
//! standard error's alone.

mod isolated;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Output;
use std::time::Duration;

use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use isolated::Isolated;

const TAR_BLOCK: usize = 512;

/// A gzip-compressed tar of a manifest that lists no missing blobs and one
/// item line.
fn archive() -> Vec<u8> {
    let manifest = br#"{"version":0,"blobs":{},"missing_blobs":{}}"#;
    let mut tar = Vec::new();
    for (name, body) in [
        ("manifest.json", manifest.as_slice()),
        ("items.ndjson", b"{}\n".as_slice()),
    ] {
        let mut header = [0u8; TAR_BLOCK];
        header[..name.len()].copy_from_slice(name.as_bytes());
        let size = format!("{:011o}\0", body.len());
        header[124..136].copy_from_slice(size.as_bytes());
        tar.extend_from_slice(&header);
        tar.extend_from_slice(body);
        tar.resize(tar.len().div_ceil(TAR_BLOCK) * TAR_BLOCK, 0);
    }
    tar.resize(tar.len() + 2 * TAR_BLOCK, 0);
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(&tar).unwrap();
    gzip.finish().unwrap()
}

/// A server that answers one request after `delay` with `sent` under a
/// `Content-Length` of `claimed`, then closes. Returns its URL.
fn server(delay: Duration, sent: Vec<u8>, claimed: usize) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else {
            return;
        };
        let mut request = [0u8; 4096];
        let _ = socket.read(&mut request);
        std::thread::sleep(delay);
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nX-Marfa-Contract: {}\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n",
            marfa_core::contract::CONTRACT_VERSION,
        );
        let _ = socket.write_all(head.as_bytes());
        let _ = socket.write_all(&sent);
    });
    url
}

fn export(name: &str, url: &str) -> Output {
    Isolated::new(name)
        .marfa()
        .args([
            "--url",
            url,
            "--key",
            "marfa_k1_x",
            "export",
            "--format",
            "archive",
        ])
        .output()
        .unwrap()
}

#[test]
fn says_it_is_working_on_standard_error_and_sends_the_whole_archive_to_standard_output() {
    let whole = archive();
    // The first remark comes at the fifth second.
    let url = server(Duration::from_secs(6), whole.clone(), whole.len());
    let output = export("export-stdout", &url);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stderr}");
    assert!(stderr.contains("still preparing the archive"), "{stderr}");
    assert_eq!(output.stdout, whole);
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains("still preparing"),
        "progress reached standard output"
    );
    let mut tar = Vec::new();
    GzDecoder::new(output.stdout.as_slice())
        .read_to_end(&mut tar)
        .unwrap();
    assert_eq!(&tar[..13], b"manifest.json");
}

#[test]
fn fails_when_the_archive_is_cut_short_on_standard_output() {
    let whole = archive();
    let url = server(
        Duration::ZERO,
        whole[..whole.len() / 2].to_vec(),
        whole.len(),
    );
    let output = export("export-stdout-cut", &url);
    assert!(!output.status.success(), "{:?}", output.status);
    assert_ne!(output.status.code(), Some(0));
    assert!(!output.stderr.is_empty());
}
