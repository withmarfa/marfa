use super::*;

/// A fixture's file, type, seconds and picture size.
type Stated = (&'static str, &'static str, f64, Option<(u32, u32)>);

const FIXTURES: &[Stated] = &[
    ("sample.mp3", "audio/mpeg", 1.0, None),
    ("sample.wav", "audio/wav", 1.5, None),
    ("sample.flac", "audio/flac", 1.5, None),
    ("sample.ogg", "audio/ogg", 1.5, None),
    ("sample.opus", "audio/opus", 1.5065, None),
    // An Ogg video: its length comes from the Vorbis track, and the picture of a
    // Theora track is not read, so there is no size.
    ("sample.ogv", "video/ogg", 1.5, None),
    // An AAC track counts the encoder's padding in its length.
    ("sample.m4a", "audio/mp4", 1.564, None),
    ("sample-audio.webm", "audio/webm", 1.508, None),
    ("sample-audio.mkv", "audio/x-matroska", 1.508, None),
    ("sample.mp4", "video/mp4", 1.0, Some((160, 120))),
    ("sample.mov", "video/quicktime", 1.5, Some((96, 64))),
    ("sample.webm", "video/webm", 1.008, Some((160, 120))),
];

fn near(seconds: Option<f64>, expected: f64, name: &str) {
    let seconds = seconds.unwrap_or_else(|| panic!("{name} states no duration"));
    assert!(
        (seconds - expected).abs() < 0.06,
        "{name}: {seconds} seconds, not {expected}"
    );
}

/// A reading that failed, and not by a parser that panicked: a panic is caught and
/// reported as `Malformed` too, so it is told apart here.
fn assert_clean(result: Result<Reading, Refusal>, what: &str) {
    match result {
        Ok(reading) => assert!(reading.text.is_empty(), "{what}: text from a sound"),
        Err(Refusal::Malformed(why)) => {
            assert_ne!(
                Refusal::Malformed(why),
                crate::panicked(),
                "{what} panicked"
            );
        }
        Err(Refusal::OverLimit(_)) => {}
        Err(other) => panic!("{what}: {other:?}"),
    }
}

#[test]
fn every_format_states_its_length_and_its_picture() {
    for (name, mime, seconds, size) in FIXTURES {
        let reading = read(&fixture(name), mime);
        near(reading.duration, *seconds, name);
        let found = reading.dimensions.map(|size| (size.width, size.height));
        assert_eq!(found, *size, "{name}");
        assert!(reading.text.is_empty(), "{name}");
    }
}

#[test]
fn the_type_may_carry_parameters_and_capitals() {
    let reading = read(&fixture("sample.wav"), "Audio/X-WAV; codecs=1");
    near(reading.duration, 1.5, "sample.wav");
}

#[test]
fn other_kinds_of_sound_and_video_stay_unsupported() {
    for mime in ["audio/x-unknown", "video/x-flv", "video/mpeg", "audio/midi"] {
        assert_eq!(
            refusal(&fixture("sample.mp3"), mime, &options()),
            Refusal::Unsupported,
            "{mime}"
        );
    }
}

/// The top-level boxes of an MP4 file.
fn boxes(bytes: &[u8]) -> Vec<&[u8]> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        found.push(&bytes[at..at + size]);
        at += size;
    }
    found
}

#[test]
fn the_index_may_come_first_or_last() {
    for (name, mime) in [
        ("sample.mp4", "video/mp4"),
        ("sample.mov", "video/quicktime"),
    ] {
        let original = fixture(name);
        let parts = boxes(&original);
        let kind = |part: &&[u8]| part[4..8].to_vec();
        assert_eq!(
            kind(parts.last().unwrap()),
            b"moov",
            "{name} ends with its index"
        );
        let first: Vec<u8> = parts
            .iter()
            .filter(|part| kind(part) == b"ftyp")
            .chain(parts.iter().filter(|part| kind(part) == b"moov"))
            .chain(
                parts
                    .iter()
                    .filter(|part| kind(part) != b"ftyp" && kind(part) != b"moov"),
            )
            .flat_map(|part| part.iter().copied())
            .collect();
        assert_eq!(first.len(), original.len());
        assert_ne!(first, original);
        let last = read(&original, mime);
        let early = read(&first, mime);
        assert_eq!(early.duration, last.duration, "{name}");
        assert_eq!(early.dimensions, last.dimensions, "{name}");
        near(
            last.duration,
            if name == "sample.mp4" { 1.0 } else { 1.5 },
            name,
        );
    }
}

#[test]
fn a_file_cut_short_reads_as_far_as_it_goes_or_is_malformed() {
    for (name, mime, _, _) in FIXTURES {
        let bytes = fixture(name);
        let full = read(&bytes, mime).duration.unwrap();
        for part in 0..=16 {
            let cut = &bytes[..bytes.len() * part / 16];
            let result = read_here(cut, mime, &options());
            if let Ok(reading) = &result
                && let Some(seconds) = reading.duration
            {
                // MP3 with no length header is sized by its bytes, so a cut one is short.
                assert!(seconds <= full + 0.06, "{name} cut to {part}/16: {seconds}");
            }
            assert_clean(result, &format!("{name} cut to {part}/16"));
        }
    }
}

#[test]
fn text_that_claims_to_be_a_sound_is_malformed() {
    let words = b"This is only some words, though the file claims to be more.".repeat(40);
    for mime in [
        "audio/mpeg",
        "audio/wav",
        "audio/flac",
        "audio/ogg",
        "audio/mp4",
        "audio/webm",
        "audio/x-matroska",
        "video/mp4",
        "video/quicktime",
        "video/webm",
    ] {
        for bytes in [&words[..], b"", b"\0", &[0xFF; 4096][..]] {
            let result = read_here(bytes, mime, &options());
            match &result {
                Err(Refusal::Malformed(why)) => {
                    assert_ne!(Refusal::Malformed(why.clone()), crate::panicked(), "{mime}");
                }
                other => panic!("{mime} with {} bytes: {other:?}", bytes.len()),
            }
        }
    }
}

/// A small, fixed sequence of numbers: the same mutations on every run.
struct Numbers(u64);

impl Numbers {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, limit: usize) -> usize {
        (self.next() % limit as u64) as usize
    }
}

#[test]
fn damaged_files_never_crash_or_hang() {
    let started = std::time::Instant::now();
    let mut numbers = Numbers(0x9E37_79B9_7F4A_7C15);
    for (name, mime, _, _) in FIXTURES {
        let original = fixture(name);
        for round in 0..300 {
            let mut bytes = original.clone();
            for _ in 0..=numbers.below(8) {
                let at = numbers.below(bytes.len().min(2048));
                bytes[at] = match numbers.below(4) {
                    0 => 0x00,
                    1 => 0xFF,
                    2 => bytes[at] ^ (1 << numbers.below(8)),
                    _ => numbers.next() as u8,
                };
            }
            if round % 5 == 0 {
                bytes.truncate(1 + numbers.below(bytes.len()));
            }
            let began = std::time::Instant::now();
            let result = read_here(&bytes, mime, &options());
            assert!(
                began.elapsed() < std::time::Duration::from_secs(5),
                "{name} round {round} took {:?}",
                began.elapsed()
            );
            assert_clean(result, &format!("{name} round {round}"));
        }
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(120));
}

/// A Matroska element: its id, then its size in eight bytes, then its body.
fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
    let mut size = vec![0x01];
    size.extend_from_slice(&(body.len() as u64).to_be_bytes()[1..]);
    [id, &size, body].concat()
}

/// An element whose size is not stated.
fn open_element(id: &[u8], body: &[u8]) -> Vec<u8> {
    [id, &[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], body].concat()
}

fn block(id: &[u8], offset: i16) -> Vec<u8> {
    let mut body = vec![0x81];
    body.extend_from_slice(&offset.to_be_bytes());
    body.extend_from_slice(&[0x80, 0]);
    element(id, &body)
}

fn matroska(info: &[u8], clusters: &[u8], open_segment: bool) -> Vec<u8> {
    let header = element(&[0x1A, 0x45, 0xDF, 0xA3], &element(&[0x42, 0x82], b"webm"));
    let tracks = element(
        &[0x16, 0x54, 0xAE, 0x6B],
        &element(
            &[0xAE],
            &element(
                &[0xE0],
                &[
                    element(&[0xB0], &[0x02, 0x80]),
                    element(&[0xBA], &[0x01, 0x68]),
                ]
                .concat(),
            ),
        ),
    );
    let body = [
        element(&[0x15, 0x49, 0xA9, 0x66], info),
        tracks,
        clusters.to_vec(),
    ]
    .concat();
    let segment = if open_segment {
        open_element(&[0x18, 0x53, 0x80, 0x67], &body)
    } else {
        element(&[0x18, 0x53, 0x80, 0x67], &body)
    };
    [header, segment].concat()
}

fn scale() -> Vec<u8> {
    element(&[0x2A, 0xD7, 0xB1], &1_000_000u32.to_be_bytes())
}

fn cluster(blocks: &[Vec<u8>], open: bool) -> Vec<u8> {
    let body = [element(&[0xE7], &[0x00]), blocks.concat()].concat();
    if open {
        open_element(&[0x1F, 0x43, 0xB6, 0x75], &body)
    } else {
        element(&[0x1F, 0x43, 0xB6, 0x75], &body)
    }
}

#[test]
fn a_length_comes_from_the_last_block_when_the_file_states_none() {
    let blocks = [block(&[0xA3], 0), block(&[0xA3], 500), block(&[0xA3], 1500)];
    for (open_cluster, open_segment) in [(false, false), (true, false), (false, true), (true, true)]
    {
        let clusters = [
            cluster(&blocks[..1], false),
            cluster(&blocks[1..], open_cluster),
        ]
        .concat();
        let bytes = matroska(&scale(), &clusters, open_segment);
        let reading = read(&bytes, "video/webm");
        near(
            reading.duration,
            1.5,
            &format!("cluster open {open_cluster}, segment open {open_segment}"),
        );
        let size = reading.dimensions.expect("a picture size");
        assert_eq!((size.width, size.height), (640, 360));
    }
}

#[test]
fn a_stated_length_is_taken_in_the_scale_of_the_file() {
    let duration = element(&[0x44, 0x89], &2500.0f64.to_be_bytes());
    let bytes = matroska(&[scale(), duration].concat(), &cluster(&[], false), false);
    near(read(&bytes, "video/webm").duration, 2.5, "a stated length");
    let half = element(&[0x2A, 0xD7, 0xB1], &500_000u32.to_be_bytes());
    let duration = element(&[0x44, 0x89], &2500.0f32.to_be_bytes());
    let bytes = matroska(&[half, duration].concat(), &cluster(&[], false), false);
    near(read(&bytes, "video/webm").duration, 1.25, "a scale of half");
}

#[test]
fn a_length_nobody_could_have_is_malformed() {
    for seconds in [f64::NAN, f64::INFINITY, -5.0, 1e300] {
        let duration = element(&[0x44, 0x89], &seconds.to_be_bytes());
        let bytes = matroska(&[scale(), duration].concat(), &cluster(&[], false), false);
        let outcome = refusal(&bytes, "video/webm", &options());
        assert!(
            matches!(outcome, Refusal::Malformed(_)),
            "{seconds}: {outcome:?}"
        );
    }
}

#[test]
fn a_length_of_negative_zero_is_zero() {
    let duration = element(&[0x44, 0x89], &(-0.0f64).to_be_bytes());
    let bytes = matroska(&[scale(), duration].concat(), &cluster(&[], false), false);
    let seconds = read(&bytes, "video/webm").duration.expect("a length");
    assert_eq!(seconds, 0.0);
    assert!(seconds.is_sign_positive(), "{seconds:?} would print as -0");
}

#[test]
fn a_file_of_endless_elements_is_stopped() {
    let mut bytes = matroska(&scale(), &[], true);
    // Millions of empty blocks in a cluster that never ends.
    let empty = [0xA3, 0x80];
    bytes.extend_from_slice(&open_element(&[0x1F, 0x43, 0xB6, 0x75], &[]));
    bytes.extend(std::iter::repeat_n(empty, 2_000_000).flatten());
    let began = std::time::Instant::now();
    assert_clean(
        read_here(&bytes, "video/webm", &options()),
        "endless blocks",
    );
    assert!(began.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn a_picture_of_no_size_is_no_picture() {
    let tracks = element(
        &[0x16, 0x54, 0xAE, 0x6B],
        &element(
            &[0xAE],
            &element(
                &[0xE0],
                &[element(&[0xB0], &[0x00]), element(&[0xBA], &[0x00])].concat(),
            ),
        ),
    );
    let header = element(&[0x1A, 0x45, 0xDF, 0xA3], &[]);
    let duration = element(&[0x44, 0x89], &1000.0f64.to_be_bytes());
    let info = element(&[0x15, 0x49, 0xA9, 0x66], &[scale(), duration].concat());
    let segment = element(&[0x18, 0x53, 0x80, 0x67], &[info, tracks].concat());
    let reading = read(&[header, segment].concat(), "video/webm");
    near(reading.duration, 1.0, "a length with no picture");
    assert_eq!(reading.dimensions, None);
}

/// A cluster that starts at `millis`, with `blocks` blocks a millisecond apart.
fn live_cluster(millis: u32, blocks: i16, open: bool) -> Vec<u8> {
    let blocks: Vec<Vec<u8>> = (0..blocks).map(|at| block(&[0xA3], at)).collect();
    let body = [element(&[0xE7], &millis.to_be_bytes()), blocks.concat()].concat();
    if open {
        open_element(&[0x1F, 0x43, 0xB6, 0x75], &body)
    } else {
        element(&[0x1F, 0x43, 0xB6, 0x75], &body)
    }
}

/// A recording of `seconds` made of clusters that state no size, as a browser
/// writes while it is still recording, and no duration.
fn live_recording(seconds: u32, blocks: i16) -> Vec<u8> {
    let clusters: Vec<u8> = (0..seconds)
        .flat_map(|second| live_cluster(second * 1000, blocks, true))
        .collect();
    matroska(&scale(), &clusters, true)
}

#[test]
fn a_live_recording_is_as_long_as_its_last_block() {
    let bytes = live_recording(600, 100);
    near(
        read(&bytes, "video/webm").duration,
        599.099,
        "a live recording within the limit",
    );
}

#[test]
fn a_recording_over_the_limit_of_elements_is_measured_from_its_last_cluster() {
    // More headers than one walk reads: the walk is cut off in the middle.
    let bytes = live_recording(1500, 800);
    let began = std::time::Instant::now();
    near(
        read(&bytes, "video/webm").duration,
        1499.799,
        "a live recording over the limit",
    );
    assert!(began.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn clusters_of_a_stated_size_over_the_limit_are_measured_from_the_last_one() {
    let clusters: Vec<u8> = (0..1_100_000u32)
        .flat_map(|millis| live_cluster(millis, 1, false))
        .collect();
    let bytes = matroska(&scale(), &clusters, false);
    near(
        read(&bytes, "video/webm").duration,
        1100.0,
        "sized clusters over the limit",
    );
}

#[test]
fn a_cut_off_walk_that_finds_no_last_cluster_states_no_length() {
    // One cluster that never ends, with millions of blocks: the only cluster is both
    // the first and the last, and no walk of it reaches its end.
    let empty = [0xA3, 0x80];
    let blocks: Vec<u8> = std::iter::repeat_n(empty, 2_000_000).flatten().collect();
    for opening in [
        // With no timecode it cannot be told from bytes inside a block.
        Vec::new(),
        element(&[0xE7], &[0x05]),
    ] {
        let cluster = open_element(
            &[0x1F, 0x43, 0xB6, 0x75],
            &[opening, blocks.clone()].concat(),
        );
        let bytes = matroska(&scale(), &cluster, true);
        let reading = read(&bytes, "video/webm");
        assert_eq!(reading.duration, None);
        let size = reading.dimensions.expect("the picture is still told");
        assert_eq!((size.width, size.height), (640, 360));
    }
}

#[test]
fn the_bytes_of_a_cluster_id_inside_a_block_are_no_cluster() {
    let impostor = element(
        &[0xA3],
        &[
            &[0x81, 0x00, 0x00, 0x80][..],
            &[0x1F, 0x43, 0xB6, 0x75, 0xFF, 0xFF],
        ]
        .concat(),
    );
    let body = [
        element(&[0xE7], &[0x00]),
        block(&[0xA3], 0),
        block(&[0xA3], 750),
        impostor,
    ]
    .concat();
    let mut clusters: Vec<u8> = (0..1_050_000u32)
        .flat_map(|_| element(&[0xEC], &[]))
        .collect();
    clusters.extend(open_element(&[0x1F, 0x43, 0xB6, 0x75], &body));
    let bytes = matroska(&scale(), &clusters, true);
    near(
        read(&bytes, "video/webm").duration,
        0.75,
        "an id inside a block",
    );
}
