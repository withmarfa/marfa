/**
 * What a picture may be. The kind is decided from the bytes: a signature, a
 * header that parses into a width and a height, and the marks that show the
 * file is whole. Nothing the sender claims about the file counts. The checks
 * do not decode the pixels, so a file that is whole in structure can still
 * fail to draw.
 */

/** The largest picture, in bytes: 2 MiB. */
export const PICTURE_MAX_BYTES = 2 * 1024 * 1024;

/** The largest width or height, in pixels. */
export const PICTURE_MAX_EDGE = 4096;

/** Where the picture is served: the instance's own address. */
export function ownerPictureAddress(authBaseUrl: string): string {
  return `${new URL(authBaseUrl).origin}/owner/picture`;
}

export type PictureContentType = "image/png" | "image/jpeg" | "image/webp";

export type PictureRefusal = "empty" | "unsupported" | "damaged" | "dimensions";

export type PictureReading =
  | {
      ok: true;
      contentType: PictureContentType;
      width: number;
      height: number;
    }
  | { ok: false; reason: PictureRefusal };

/** What each refusal says, in words a person reads under the field. */
export const PICTURE_WORDS: Readonly<Record<PictureRefusal, string>> = {
  empty: "That picture is empty. Use a PNG, JPEG or WebP picture.",
  unsupported: "Use a PNG, JPEG or WebP picture.",
  damaged: "That picture is damaged. Use a PNG, JPEG or WebP picture.",
  dimensions: `Use a picture between 1 and ${String(PICTURE_MAX_EDGE)} pixels on each side.`,
};

export const PICTURE_TOO_LARGE_WORDS = "Use a picture of 2 MiB or less.";

interface Size {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  return Array.from(text, (letter) => letter.charCodeAt(0)).every(
    (code, index) => bytes[at + index] === code,
  );
}

/** The byte at a position, 0 past the end. */
function byte(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0;
}

function u16be(bytes: Uint8Array, at: number): number {
  return (byte(bytes, at) << 8) | byte(bytes, at + 1);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    byte(bytes, at) * 0x1000000 +
    ((byte(bytes, at + 1) << 16) |
      (byte(bytes, at + 2) << 8) |
      byte(bytes, at + 3))
  );
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    byte(bytes, at) +
    byte(bytes, at + 1) * 0x100 +
    byte(bytes, at + 2) * 0x10000 +
    byte(bytes, at + 3) * 0x1000000
  );
}

function u24le(bytes: Uint8Array, at: number): number {
  return (
    byte(bytes, at) | (byte(bytes, at + 1) << 8) | (byte(bytes, at + 2) << 16)
  );
}

const PNG_CHUNK_OVERHEAD = 12;

/**
 * The IHDR chunk, which a PNG opens with, and then the chain of chunks to the
 * end: each one fits in the file, an IDAT comes before the IEND, and the IEND
 * is the last twelve bytes.
 */
function pngSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 24 || !ascii(bytes, 12, "IHDR") || u32be(bytes, 8) !== 13)
    return undefined;
  let at = PNG_SIGNATURE.length;
  let sawData = false;
  while (at + PNG_CHUNK_OVERHEAD <= bytes.length) {
    const length = u32be(bytes, at);
    if (length > bytes.length - at - PNG_CHUNK_OVERHEAD) return undefined;
    if (ascii(bytes, at + 4, "IDAT")) sawData = true;
    at += PNG_CHUNK_OVERHEAD + length;
    if (ascii(bytes, at - PNG_CHUNK_OVERHEAD + 4, "IEND")) {
      if (length !== 0 || at !== bytes.length || !sawData) return undefined;
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
  }
  return undefined;
}

/**
 * The frame header of a JPEG that browsers draw (baseline, extended
 * sequential or progressive), found by walking the segments from the start,
 * and then the end-of-image mark after the first scan's header.
 */
function jpegSize(bytes: Uint8Array): Size | undefined {
  let size: Size | undefined;
  let at = 2;
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = byte(bytes, at + 1);
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    at += 2;
    // Markers with no length: the restart markers, TEM and the start of image.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // The end of the image comes before any scan.
    if (marker === 0xd9) return undefined;
    if (at + 2 > bytes.length) return undefined;
    const length = u16be(bytes, at);
    if (length < 2 || at + length > bytes.length) return undefined;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xcc
    ) {
      if (marker > 0xc2 || size !== undefined || length < 8) return undefined;
      size = { width: u16be(bytes, at + 5), height: u16be(bytes, at + 3) };
    }
    at += length;
    if (marker === 0xda) {
      if (size === undefined) return undefined;
      return endsImage(bytes, at) ? size : undefined;
    }
  }
  return undefined;
}

/** Whether the end-of-image mark comes at or after `from`. */
function endsImage(bytes: Uint8Array, from: number): boolean {
  for (let at = from; at + 1 < bytes.length; at += 1)
    if (bytes[at] === 0xff && bytes[at + 1] === 0xd9) return true;
  return false;
}

/**
 * The first chunk of a RIFF container: lossy, lossless or extended. The size
 * the container declares is the size of the file.
 */
function webpSize(bytes: Uint8Array): Size | undefined {
  if (bytes.length < 12 || u32le(bytes, 4) !== bytes.length - 8)
    return undefined;
  if (ascii(bytes, 12, "VP8 ")) {
    if (
      bytes.length < 30 ||
      !startsWith(bytes.subarray(23), [0x9d, 0x01, 0x2a])
    )
      return undefined;
    return {
      width: (byte(bytes, 26) | (byte(bytes, 27) << 8)) & 0x3fff,
      height: (byte(bytes, 28) | (byte(bytes, 29) << 8)) & 0x3fff,
    };
  }
  if (ascii(bytes, 12, "VP8L")) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return undefined;
    const bits =
      byte(bytes, 21) |
      (byte(bytes, 22) << 8) |
      (byte(bytes, 23) << 16) |
      (byte(bytes, 24) << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (ascii(bytes, 12, "VP8X")) {
    if (bytes.length < 30) return undefined;
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return undefined;
}

export function readPicture(bytes: Uint8Array): PictureReading {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  let contentType: PictureContentType;
  let size: Size | undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) {
    contentType = "image/png";
    size = pngSize(bytes);
  } else if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    contentType = "image/jpeg";
    size = jpegSize(bytes);
  } else if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    contentType = "image/webp";
    size = webpSize(bytes);
  } else {
    return { ok: false, reason: "unsupported" };
  }
  if (size === undefined) return { ok: false, reason: "damaged" };
  const { width, height } = size;
  for (const edge of [width, height])
    if (edge < 1 || edge > PICTURE_MAX_EDGE)
      return { ok: false, reason: "dimensions" };
  return { ok: true, contentType, width, height };
}
