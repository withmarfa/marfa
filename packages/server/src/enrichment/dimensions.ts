import { imageDimensionsFromData } from "image-dimensions";
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
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The largest width or height any of these formats can state. */
const MAX_SIDE = 2 ** 31 - 1;

/**
 * Whether a size read from a header can be a real one. The reader looks at
 * a signature and then at fixed offsets, so bytes that merely start like a
 * PNG yield whatever sits at those offsets; a PNG states its size in the
 * `IHDR` chunk that has to come first (Apple's variant puts `CgBI` there),
 * and no format states a side of zero or past `MAX_SIDE`.
 */
function plausibleHeader(
  data: Uint8Array,
  size: { width: number; height: number },
): boolean {
  const inRange = (side: number) =>
    Number.isInteger(side) && side > 0 && side <= MAX_SIDE;
  if (!inRange(size.width) || !inRange(size.height)) return false;
  if (PNG_SIGNATURE.every((byte, i) => data[i] === byte)) {
    const chunk = String.fromCharCode(...data.subarray(12, 16));
    if (chunk === "CgBI") return true;
    return chunk === "IHDR";
  }
  return true;
}

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
