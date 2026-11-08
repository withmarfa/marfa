//! The length of a sound or a video, and the size of its picture, from the file's
//! headers. Nothing is decoded and the file is never held in memory.

use symphonia::core::codecs::CodecParameters;
use symphonia::core::common::Limit;
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

use crate::source::Source;
use crate::{Refusal, matroska};

/// The longest duration taken as real: about three centuries. A header that states
/// more is damaged.
pub(crate) const MAX_DURATION_SECONDS: f64 = 1e10;

/// The most a tag may take in memory once read.
const MOST_TAG_BYTES: usize = 1 << 20;

/// What a media file states. A field is none when the file does not say.
#[derive(Debug, Default)]
pub(crate) struct Media {
    /// Seconds.
    pub(crate) duration: Option<f64>,
    /// Width and height in pixels of the first video track.
    pub(crate) size: Option<(u32, u32)>,
}

/// A duration that can be told to a person: a number from zero up to
/// `MAX_DURATION_SECONDS`. A negative zero is zero, which prints as `0`, not `-0`.
pub(crate) fn checked_duration(seconds: f64) -> Result<f64, Refusal> {
    if (0.0..=MAX_DURATION_SECONDS).contains(&seconds) {
        Ok(if seconds == 0.0 { 0.0 } else { seconds })
    } else {
        Err(Refusal::Malformed(
            "the file states no real duration".into(),
        ))
    }
}

pub(crate) fn read(mut source: Source, matroska: bool) -> Result<Media, Refusal> {
    if matroska {
        matroska::read(&mut source)
    } else {
        containers(source)
    }
}

/// MP3, WAV, FLAC, Ogg and MP4, which Symphonia takes apart. It states no duration
/// for WebM or Matroska.
fn containers(source: Source) -> Result<Media, Refusal> {
    let stream = MediaSourceStream::new(Box::new(source), MediaSourceStreamOptions::default());
    let tags = MetadataOptions::default()
        .limit_tag_bytes(Limit::Maximum(MOST_TAG_BYTES))
        .limit_visual_bytes(Limit::Maximum(0));
    let reader = symphonia::default::get_probe()
        .probe(&Hint::new(), stream, FormatOptions::default(), tags)
        .map_err(refusal)?;

    let mut media = Media::default();
    for track in reader.tracks() {
        let length = track
            .duration
            .zip(track.time_base)
            .and_then(|(duration, base)| base.calc_duration(duration))
            .map(|time| time.as_secs_f64());
        if let Some(seconds) = length {
            let seconds = checked_duration(seconds)?;
            media.duration = Some(media.duration.map_or(seconds, |known| known.max(seconds)));
        }
        if media.size.is_none()
            && let Some(CodecParameters::Video(video)) = &track.codec_params
            && let (Some(width), Some(height)) = (video.width, video.height)
            && width > 0
            && height > 0
        {
            media.size = Some((u32::from(width), u32::from(height)));
        }
    }
    Ok(media)
}

fn refusal(error: Error) -> Refusal {
    match error {
        Error::LimitError(why) => Refusal::OverLimit(why.to_owned()),
        other => Refusal::Malformed(other.to_string()),
    }
}
