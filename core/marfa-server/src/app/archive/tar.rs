//! Ustar headers for regular files with short names; 8 GiB or more is written in base-256.

pub const BLOCK: usize = 512;
const NAME: usize = 100;
const OCTAL_MAX: u64 = 0o77_777_777_777;

fn octal(field: &mut [u8], value: u64) {
    let digits = field.len() - 1;
    let text = format!("{value:0digits$o}");
    field[..digits].copy_from_slice(text.as_bytes());
    field[digits] = 0;
}

/// The header of a regular file `name` of `size` bytes, or `None` for a name that does not fit.
pub fn header(name: &str, size: u64, mtime: u64) -> Option<[u8; BLOCK]> {
    if name.len() > NAME || name.as_bytes().contains(&0) {
        return None;
    }
    let mut block = [0u8; BLOCK];
    block[..name.len()].copy_from_slice(name.as_bytes());
    octal(&mut block[100..108], 0o644);
    octal(&mut block[108..116], 0);
    octal(&mut block[116..124], 0);
    if size <= OCTAL_MAX {
        octal(&mut block[124..136], size);
    } else {
        block[124] = 0x80;
        block[128..136].copy_from_slice(&size.to_be_bytes());
    }
    octal(&mut block[136..148], mtime.min(OCTAL_MAX));
    block[148..156].fill(b' ');
    block[156] = b'0';
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let sum: u32 = block.iter().map(|byte| u32::from(*byte)).sum();
    let check = format!("{sum:06o}");
    block[148..154].copy_from_slice(check.as_bytes());
    block[154] = 0;
    block[155] = b' ';
    Some(block)
}

/// The zero bytes that fill an entry of `size` bytes out to a whole block.
pub fn padding(size: u64) -> usize {
    let over = (size % BLOCK as u64) as usize;
    if over == 0 { 0 } else { BLOCK - over }
}

/// The two zero blocks that end an archive.
pub const END: [u8; 2 * BLOCK] = [0; 2 * BLOCK];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_holds_its_name_size_and_a_checksum_over_itself() {
        let block = header("items.ndjson.gz", 1234, 1_700_000_000).unwrap();
        assert_eq!(&block[..15], b"items.ndjson.gz");
        assert_eq!(&block[124..136], b"00000002322\0");
        assert_eq!(&block[257..265], b"ustar\x0000");
        let mut zeroed = block;
        zeroed[148..156].fill(b' ');
        let sum: u32 = zeroed.iter().map(|byte| u32::from(*byte)).sum();
        let held = std::str::from_utf8(&block[148..154]).unwrap();
        assert_eq!(u32::from_str_radix(held, 8).unwrap(), sum);
    }

    #[test]
    fn a_size_past_the_octal_field_is_written_in_base_256() {
        let size = 9 * 1024 * 1024 * 1024u64;
        let block = header("blobs/x", size, 0).unwrap();
        assert_eq!(block[124], 0x80);
        assert_eq!(
            u64::from_be_bytes(block[128..136].try_into().unwrap()),
            size
        );
    }

    #[test]
    fn a_name_longer_than_the_field_is_refused() {
        assert!(header(&"a".repeat(101), 1, 0).is_none());
        assert!(header(&"a".repeat(100), 1, 0).is_some());
    }

    #[test]
    fn an_entry_is_padded_to_a_whole_block() {
        assert_eq!(padding(0), 0);
        assert_eq!(padding(1), 511);
        assert_eq!(padding(512), 0);
        assert_eq!(padding(513), 511);
    }
}
