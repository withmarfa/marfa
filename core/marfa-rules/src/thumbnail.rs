use crate::error::RuleError;

#[derive(Debug, Clone, PartialEq)]
pub struct Thumbnail {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// Cap on a decoded thumbnail.
pub const THUMBNAIL_MAX_BYTES: usize = 16 * 1024;

impl Thumbnail {
    /// Checked again on read: a held value may predate its field's type.
    pub fn from_data_uri(value: &str) -> Result<Thumbnail, RuleError> {
        use base64::Engine;
        let unreadable =
            |why: &str| RuleError::decoding(format!("a thumbnail that is {why}: {:.40}", value));
        let (mime_type, data) = value
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,"))
            .ok_or_else(|| unreadable("not a base64 data URI"))?;
        let signed: fn(&[u8]) -> bool = match mime_type {
            "image/png" => |bytes| bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "image/jpeg" => |bytes| bytes.starts_with(b"\xff\xd8\xff"),
            "image/webp" => {
                |bytes| bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice())
            }
            _ => return Err(unreadable("not a PNG, JPEG or WebP image")),
        };
        // The standard engine refuses unused bits set and non-canonical padding.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| unreadable("not canonical base64"))?;
        if bytes.len() > THUMBNAIL_MAX_BYTES {
            return Err(unreadable("over the thumbnail cap"));
        }
        if !signed(&bytes) {
            return Err(unreadable("not the image its data URI names"));
        }
        Ok(Thumbnail {
            mime_type: mime_type.to_string(),
            bytes,
        })
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::*;
    use crate::error::Code;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0";
    const WEBP: &[u8] = b"RIFF\0\0\0\0WEBPVP8 ";

    fn uri(mime_type: &str, head: &[u8], size: usize) -> String {
        let mut bytes = head.to_vec();
        bytes.resize(size, 7);
        format!(
            "data:{mime_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn a_thumbnail_reads_as_the_image_its_data_uri_names() {
        for (mime_type, head) in [
            ("image/png", PNG),
            ("image/jpeg", JPEG),
            ("image/webp", WEBP),
        ] {
            let read = Thumbnail::from_data_uri(&uri(mime_type, head, 64)).unwrap();
            assert_eq!(read.mime_type, mime_type);
            assert_eq!(read.bytes.len(), 64);
            assert!(read.bytes.starts_with(head));
        }
        let at_cap = Thumbnail::from_data_uri(&uri("image/png", PNG, THUMBNAIL_MAX_BYTES)).unwrap();
        assert_eq!(at_cap.bytes.len(), THUMBNAIL_MAX_BYTES);
    }

    #[test]
    fn a_value_the_server_would_refuse_is_not_read_as_a_thumbnail() {
        let refused = [
            ("not an image", uri("text/plain", PNG, 64)),
            ("another image", uri("image/gif", b"GIF89a", 64)),
            ("an uppercase type", uri("image/PNG", PNG, 64)),
            ("not the image it names", uri("image/jpeg", PNG, 64)),
            (
                "a signature short by a byte",
                uri("image/png", &PNG[..7], 64),
            ),
            (
                "a RIFF that is not WebP",
                uri("image/webp", b"RIFF\0\0\0\0WAVEfmt ", 64),
            ),
            (
                "over the cap",
                uri("image/png", PNG, THUMBNAIL_MAX_BYTES + 1),
            ),
            (
                "unused bits set",
                "data:image/png;base64,iVBORw0KGgp=".to_string(),
            ),
            (
                "padding left off",
                "data:image/png;base64,iVBORw0KGgo".to_string(),
            ),
            ("a link", "https://example.com/thumb.png".to_string()),
            ("empty", "data:image/png;base64,".to_string()),
        ];
        for (what, value) in refused {
            assert!(
                matches!(
                    Thumbnail::from_data_uri(&value),
                    Err(RuleError {
                        code: Code::Decoding,
                        ..
                    })
                ),
                "{what} was read as a thumbnail"
            );
        }
        assert_eq!(
            Thumbnail::from_data_uri("data:image/png;base64,iVBORw0KGgo=")
                .unwrap()
                .bytes,
            PNG
        );
    }
}
