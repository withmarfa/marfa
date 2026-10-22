import { deflateSync } from "node:zlib";

/**
 * Small picture files for fixtures about the owner's picture. Each header
 * declares the size it is asked for; `png` also carries pixel data, so a
 * browser can draw it.
 */

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return header;
}

/** A solid-color PNG whose header and pixel data agree. */
export function png(width = 8, height = 8, shade = 0x7f): Buffer {
  const row = Buffer.alloc(1 + width * 3, shade);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", pngHeader(width, height)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG that declares a size and carries no pixel data. */
export function pngHeaderOnly(width: number, height: number): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", pngHeader(width, height)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG whose frame header declares `width` by `height`. */
export function jpeg(width = 8, height = 8): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const frame = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  const scan = Buffer.from([
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    frame,
    scan,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function riff(fourcc: string, data: Buffer): Buffer {
  const padded =
    data.length % 2 === 0 ? data : Buffer.concat([data, Buffer.alloc(1)]);
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, "latin1");
  header.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), header, padded]);
  const out = Buffer.alloc(8);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(body.length, 4);
  return Buffer.concat([out, body]);
}

/** A lossless WebP whose header declares `width` by `height`. */
export function webp(width = 8, height = 8): Buffer {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(
    ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14),
    1,
  );
  return riff("VP8L", data);
}

export function gif(): Buffer {
  return Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
}

/** The start of an AVIF file: an ISO base media `ftyp` box. */
export function avif(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x1c]),
    Buffer.from("ftypavif", "latin1"),
    Buffer.alloc(16),
  ]);
}

export function svg(): Buffer {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script></svg>',
  );
}

export function html(): Buffer {
  return Buffer.from("<!doctype html><script>alert(1)</script>");
}

/** `header` followed by zeros, `size` bytes in all. */
export function padded(header: Buffer, size: number): Buffer {
  return Buffer.concat([header, Buffer.alloc(size - header.length)]);
}
