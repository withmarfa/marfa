//! What a release is called, what it carries and whether it is newer.

use std::fmt;

use chrono::{DateTime, SecondsFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The three numbers of a release such as `0.0.75`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version([u64; 3]);

impl Version {
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.split('.');
        let mut numbers = [0u64; 3];
        for slot in &mut numbers {
            let part = parts.next()?;
            let plain = part.bytes().all(|byte| byte.is_ascii_digit())
                && !part.is_empty()
                && (part.len() == 1 || !part.starts_with('0'));
            if !plain {
                return None;
            }
            *slot = part.parse().ok()?;
        }
        parts.next().is_none().then_some(Version(numbers))
    }

    /// The release this build is.
    pub fn running() -> Version {
        Version::parse(env!("CARGO_PKG_VERSION")).unwrap_or(Version([0; 3]))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [major, minor, patch] = self.0;
        write!(out, "{major}.{minor}.{patch}")
    }
}

/// The name a release's archives carry for this machine, or `None` where no release has a build.
pub fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        _ => None,
    }
}

pub fn archive_name(version: &str, platform: &str) -> String {
    format!("marfa-{version}-{platform}.tar.gz")
}

pub fn checksums_name(version: &str) -> String {
    format!("marfa-{version}-checksums.txt")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub url: String,
    pub bytes: u64,
}

/// The newest published release a check found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Latest {
    pub version: String,
    pub published_at: String,
    /// The archive for this machine; `None` where the release carries none.
    pub archive: Option<Asset>,
    pub checksums: Option<Asset>,
}

impl Latest {
    pub fn version(&self) -> Option<Version> {
        Version::parse(&self.version)
    }
}

fn asset_named(assets: &[Value], name: &str) -> Option<Asset> {
    let found = assets
        .iter()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(name))?;
    Some(Asset {
        url: found.get("browser_download_url")?.as_str()?.to_string(),
        bytes: found.get("size")?.as_u64()?,
    })
}

/// Reads GitHub's answer for the latest release. A draft, a prerelease and anything that does
/// not read is refused, so the last known release stays.
pub fn read_latest(body: &[u8], platform: Option<&str>) -> Result<Latest, &'static str> {
    let untidy = "GitHub's answer was not a release this server can read";
    let release: Value = serde_json::from_slice(body).map_err(|_| untidy)?;
    let flag = |name: &str| release.get(name).and_then(Value::as_bool).ok_or(untidy);
    if flag("draft")? || flag("prerelease")? {
        return Err("GitHub's newest release is a draft or a prerelease, which is not offered");
    }
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or(untidy)?;
    let version = tag
        .strip_prefix('v')
        .and_then(Version::parse)
        .ok_or("GitHub's newest release is not named as a Marfa release is")?;
    let published_at = release
        .get("published_at")
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
        .map(|time| {
            time.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .ok_or(untidy)?;
    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .ok_or(untidy)?;
    let version = version.to_string();
    Ok(Latest {
        archive: platform
            .and_then(|platform| asset_named(assets, &archive_name(&version, platform))),
        checksums: asset_named(assets, &checksums_name(&version)),
        version,
        published_at,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn release(extra: Value) -> Vec<u8> {
        let mut body = json!({
            "tag_name": "v0.0.75",
            "draft": false,
            "prerelease": false,
            "published_at": "2026-11-16T09:30:00Z",
            "assets": [
                {"name": "marfa-0.0.75-linux-x86_64.tar.gz", "browser_download_url": "https://example.com/a.tar.gz", "size": 1234},
                {"name": "marfa-0.0.75-checksums.txt", "browser_download_url": "https://example.com/sums", "size": 99},
            ],
        });
        if let (Some(base), Some(over)) = (body.as_object_mut(), extra.as_object()) {
            base.extend(over.clone());
        }
        body.to_string().into_bytes()
    }

    #[test]
    fn a_release_reads_with_its_archive_for_this_platform_and_its_checksums() {
        let latest = read_latest(&release(json!({})), Some("linux-x86_64")).unwrap();
        assert_eq!(latest.version, "0.0.75");
        assert_eq!(latest.published_at, "2026-11-16T09:30:00.000Z");
        assert_eq!(latest.archive.unwrap().bytes, 1234);
        assert_eq!(latest.checksums.unwrap().url, "https://example.com/sums");
    }

    #[test]
    fn a_platform_the_release_has_no_archive_for_reads_with_none() {
        let latest = read_latest(&release(json!({})), Some("darwin-arm64")).unwrap();
        assert!(latest.archive.is_none());
        assert!(latest.checksums.is_some());
        assert!(
            read_latest(&release(json!({})), None)
                .unwrap()
                .archive
                .is_none()
        );
    }

    #[test]
    fn a_draft_a_prerelease_and_untidy_answers_are_refused() {
        for body in [
            release(json!({"draft": true})),
            release(json!({"prerelease": true})),
            release(json!({"tag_name": "0.0.75"})),
            release(json!({"tag_name": "v0.0.75-rc1"})),
            release(json!({"tag_name": "v1.2"})),
            release(json!({"published_at": "yesterday"})),
            release(json!({"assets": "none"})),
            release(json!({"draft": "no"})),
            b"<html>rate limited</html>".to_vec(),
            b"[]".to_vec(),
        ] {
            assert!(read_latest(&body, Some("linux-x86_64")).is_err());
        }
    }

    #[test]
    fn versions_compare_by_number_and_not_by_text() {
        let version = |text| Version::parse(text).unwrap();
        assert!(version("0.0.9") < version("0.0.10"));
        assert!(version("0.1.0") > version("0.0.99"));
        assert_eq!(version("0.0.75").to_string(), "0.0.75");
        for bad in [
            "", "1", "1.2", "1.2.3.4", "01.2.3", "1.2.x", "1..3", "v1.2.3", "1.2.-3",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn an_asset_without_a_size_or_link_is_no_asset() {
        let body = release(json!({"assets": [
            {"name": "marfa-0.0.75-linux-x86_64.tar.gz", "browser_download_url": "https://example.com/a"},
            {"name": "marfa-0.0.75-checksums.txt", "size": 5},
        ]}));
        let latest = read_latest(&body, Some("linux-x86_64")).unwrap();
        assert!(latest.archive.is_none() && latest.checksums.is_none());
    }
}
