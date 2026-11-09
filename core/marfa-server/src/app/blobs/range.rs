//! The one byte range a read honors.

/// What a read answers for the `Range` it was sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Slice {
    /// The whole blob: no range, or one the server does not read.
    Whole,
    /// Bytes `first` through `last`, both inside the blob.
    Part { first: u64, last: u64 },
    /// A range that starts at or past the end, or ends before it starts.
    Unsatisfiable,
}

/// Bounds past this, 2^53 - 1, are not read: a double holds no more whole numbers exactly.
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn bound(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>()
        .ok()
        .filter(|number| *number <= SAFE_INTEGER)
}

pub fn of(header: Option<&str>, size: u64) -> Slice {
    let Some(spec) = header.and_then(|text| text.trim().strip_prefix("bytes=")) else {
        return Slice::Whole;
    };
    let Some((first, last)) = spec.split_once('-') else {
        return Slice::Whole;
    };
    let Some(first) = bound(first.trim()) else {
        return Slice::Whole;
    };
    let last = match last.trim() {
        "" => None,
        text => match bound(text) {
            Some(last) => Some(last),
            None => return Slice::Whole,
        },
    };
    if first >= size || last.is_some_and(|last| last < first) {
        return Slice::Unsatisfiable;
    }
    let end = size - 1;
    Slice::Part {
        first,
        last: last.map_or(end, |last| last.min(end)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn part(first: u64, last: u64) -> Slice {
        Slice::Part { first, last }
    }

    #[test]
    fn reads_closed_open_and_clamped_ranges() {
        assert_eq!(of(Some("bytes=2-5"), 10), part(2, 5));
        assert_eq!(of(Some("bytes=4-"), 10), part(4, 9));
        assert_eq!(of(Some("bytes=4-400"), 10), part(4, 9));
        assert_eq!(of(Some("bytes=0-0"), 1), part(0, 0));
    }

    #[test]
    fn refuses_a_range_outside_the_blob() {
        assert_eq!(of(Some("bytes=10-"), 10), Slice::Unsatisfiable);
        assert_eq!(of(Some("bytes=3-2"), 10), Slice::Unsatisfiable);
        assert_eq!(of(Some("bytes=0-"), 0), Slice::Unsatisfiable);
    }

    #[test]
    fn answers_the_whole_blob_for_a_range_it_does_not_read() {
        for header in [
            None,
            Some("bytes=-3"),
            Some("bytes=0-1,4-5"),
            Some("items=0-1"),
            Some("bytes=a-b"),
            Some("bytes=1"),
            Some("bytes="),
            Some("bytes=0-9007199254740992"),
            Some("bytes=9007199254740992-"),
            Some("bytes=+1-2"),
        ] {
            assert_eq!(of(header, 10), Slice::Whole, "{header:?}");
        }
    }
}
