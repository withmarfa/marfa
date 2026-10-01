import { imageDimensionsFromData, type ImageType } from "image-dimensions";
import { parseBuffer } from "music-metadata";

/**
 * The fields derivation can fill.
 *
 * Every one of them is optional on the type that declares it, deliberately:
 * a fact the server can work out from the file is worth having and is never
 * worth refusing the file over. The rest of the schema already agrees, since
 * `extracted_text` and the three geo fields on the same types are derived
 * and optional.
 */
export const DIMENSION_FIELDS = ["width", "height", "duration"] as const;

export type DimensionField = (typeof DIMENSION_FIELDS)[number];

export type DerivedDimensions = Partial<Record<DimensionField, number>>;

export type DimensionOutcome =
  | { kind: "dimensions"; values: DerivedDimensions }
  /**
   * Nothing readable. `reason` reaches the item's enrichment row, because
   * whether this ever needs a native probe is a question about what this
   * instance actually holds, and the alternative to recording it is
   * guessing.
   */
  | { kind: "unreadable"; reason: string };

function bareMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Whether a declared MIME is one a dimension reader would even look at.
 * Consulted before blob metadata or bytes, so an unreadable file costs
 * nothing, exactly as the text side's MIME gate does.
 */
export function isDimensionMime(mime: string): boolean {
  const bare = bareMime(mime);
  return (
    bare.startsWith("image/") ||
    bare.startsWith("audio/") ||
    bare.startsWith("video/")
  );
}

/** The largest width or height any of these formats can state. */
const MAX_SIDE = 2 ** 31 - 1;

const ascii = (data: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...data.subarray(start, end));

/**
 * A GIF's logical screen descriptor, and its global color table when the
 * descriptor declares one, must be whole and followed by an extension, an
 * image descriptor or the trailer.
 */
function wellFormedGif(data: Uint8Array): boolean {
  const flags = data[10] ?? 0;
  const table = flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
  const next = data[13 + table];
  return next === 0x21 || next === 0x2c || next === 0x3b;
}

/**
 * The reader walks a JPEG's segments by their lengths without checking
 * their markers, so each segment up to the frame header must open with a
 * marker, and the frame header must be whole, with a length that matches
 * its component count.
 */
function wellFormedJpeg(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return false;
    const marker = data[offset + 1] ?? 0;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return false;
    if (marker >= 0xc0 && marker <= 0xc3) {
      const components = data[offset + 9] ?? 0;
      return components > 0 && length === 8 + 3 * components;
    }
    offset += 2 + length;
  }
  return false;
}

/**
 * Each WebP chunk kind carries a mark of its own beside the size the reader
 * takes: the lossy frame's start code, the lossless signature byte and zero
 * version, and the extended header's fixed chunk length.
 */
function wellFormedWebp(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (ascii(data, 12, 16)) {
    case "VP8 ":
      return (
        data.length >= 30 &&
        ((data[20] ?? 1) & 0x01) === 0 &&
        data[23] === 0x9d &&
        data[24] === 0x01 &&
        data[25] === 0x2a
      );
    case "VP8L":
      return (
        data.length >= 25 && data[20] === 0x2f && (data[24] ?? 0) >> 5 === 0
      );
    case "VP8X":
      return data.length >= 30 && view.getUint32(16, true) === 10;
    default:
      return false;
  }
}

/**
 * Whether a size read from a header can be a real one. The reader looks at
 * a signature and then at fixed offsets, so bytes that merely start like a
 * PNG, GIF, JPEG or WebP yield whatever sits at those offsets; each format
 * is held to the structure around its size. A PNG states its size in the
 * `IHDR` chunk that has to come first (Apple's variant puts `CgBI` there),
 * and no format states a side of zero or past `MAX_SIDE`.
 */
function plausibleHeader(
  data: Uint8Array,
  size: { width: number; height: number; type: ImageType },
): boolean {
  const inRange = (side: number) =>
    Number.isInteger(side) && side > 0 && side <= MAX_SIDE;
  if (!inRange(size.width) || !inRange(size.height)) return false;
  switch (size.type) {
    case "png": {
      const chunk = ascii(data, 12, 16);
      return chunk === "IHDR" || chunk === "CgBI";
    }
    case "gif":
      return wellFormedGif(data);
    case "jpeg":
      return wellFormedJpeg(data);
    case "webp":
      return wellFormedWebp(data);
    default:
      return true;
  }
}

/**
 * Best-effort width, height and duration from the file's own header.
 *
 * Never throws and never guesses: a format neither reader recognizes comes
 * back `unreadable` with a reason, the sweeper records that, and the fields
 * stay absent. Both readers parse container metadata rather than decoding
 * content, so the cost is bounded by the header and not by the media's
 * length.
 *
 * Pure JavaScript on purpose. ffprobe, ffmpeg and sharp were considered and
 * rejected: they would be the first native binary and the first subprocess
 * in this server, which the handful of extra containers does not pay for.
 */
export async function deriveDimensions(
  bytes: Buffer,
  mimeType: string,
): Promise<DimensionOutcome> {
  const mime = bareMime(mimeType);
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (mime.startsWith("image/")) {
    // Synchronous and header-only, over PNG, JPEG, GIF, WebP, AVIF and
    // HEIF/HEIC. Returns undefined rather than throwing for a format it
    // does not read, which is the failure mode this wants: an absence to
    // record rather than an error to classify.
    const size = imageDimensionsFromData(data);
    if (!size) return { kind: "unreadable", reason: "no image reader" };
    if (!plausibleHeader(data, size)) {
      return { kind: "unreadable", reason: "no image header" };
    }
    return {
      kind: "dimensions",
      values: { width: size.width, height: size.height },
    };
  }

  let format: Awaited<ReturnType<typeof parseBuffer>>["format"];
  try {
    format = (
      await parseBuffer(
        data,
        { mimeType: mime, size: bytes.byteLength },
        { duration: true },
      )
    ).format;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "unreadable",
      reason: `media parse failed: ${message.slice(0, 200)}`,
    };
  }

  const values: DerivedDimensions = {};
  if (typeof format.duration === "number" && Number.isFinite(format.duration)) {
    values.duration = format.duration;
  }
  // Present for the EBML containers (WebM, Matroska) and absent for
  // ISO-BMFF (MP4, QuickTime): the parser reads those only as far as their
  // audio, so a video track's pixel dimensions are not there to take. An
  // MP4 therefore yields its duration and no size, which is recorded rather
  // than papered over.
  const video = format.trackInfo.find((track) => track.video)?.video;
  if (typeof video?.pixelWidth === "number") values.width = video.pixelWidth;
  if (typeof video?.pixelHeight === "number") values.height = video.pixelHeight;

  if (Object.keys(values).length === 0) {
    return {
      kind: "unreadable",
      reason: `no readable dimensions in container ${format.container ?? "unknown"}`,
    };
  }
  return { kind: "dimensions", values };
}
