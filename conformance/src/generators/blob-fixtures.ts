/**
 * Every fixture is a valid file with correct headers and an approximate target
 * size, synthesized from Node built-ins. No fixture file is checked in, so
 * nothing here depends on a binary the repository would have to carry.
 */

import { deflateSync } from "zlib";
import { Corpus } from "./corpus.js";

export interface BlobFixture {
  name: string;
  mimeType: string;
  extension: string;
  targetBytes: number;
  generate: (seed?: number) => Uint8Array;
}

// --- PNG generation ---

function generatePng(
  width: number,
  height: number,
  targetBytes: number,
  seed = 42,
): Uint8Array {
  // PNG signature
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = new Uint8Array(25);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, 13); // length
  ihdr.set([73, 72, 68, 82], 4); // "IHDR"
  ihdrView.setUint32(8, width);
  ihdrView.setUint32(12, height);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // color type (RGB)
  ihdr[18] = 0; // compression
  ihdr[19] = 0; // filter
  ihdr[20] = 0; // interlace
  ihdrView.setUint32(21, crc32(ihdr.subarray(4, 21)));

  // IEND chunk
  const iend = makeChunk("IEND", new Uint8Array(0));

  // Build IDAT chunks to reach target size.
  // Random pixel data doesn't compress well, so we use a small image with
  // repeating patterns (compresses to predictable size) and pad with
  // pre-compressed chunks to reach the target.
  const scanlineBytes = 1 + width * 3;
  // Use a small number of scanlines to keep the initial IDAT manageable
  const limitedHeight = Math.min(height, 16);
  const rawData = new Uint8Array(scanlineBytes * limitedHeight);
  const rng = seededRandom(seed);
  for (let y = 0; y < limitedHeight; y++) {
    rawData[y * scanlineBytes] = 0; // no filter
    // Use repeating color blocks (compresses well)
    const baseR = Math.floor(rng() * 256);
    const baseG = Math.floor(rng() * 256);
    const baseB = Math.floor(rng() * 256);
    for (let x = 0; x < width; x++) {
      const off = y * scanlineBytes + 1 + x * 3;
      rawData[off] = baseR;
      rawData[off + 1] = baseG;
      rawData[off + 2] = baseB;
    }
  }
  const compressed = deflateSync(rawData, { level: 9 });
  const idat = makeChunk("IDAT", compressed);

  const headerSize = signature.length + ihdr.length + idat.length + iend.length;
  if (headerSize >= targetBytes) {
    return concatBytes([signature, ihdr, idat, iend]);
  }

  // Pad with additional IDAT chunks containing pre-built compressed data
  // Use deflateSync on zero-filled buffers which compress very efficiently
  const remaining = targetBytes - headerSize;
  const padData = new Uint8Array(remaining);
  // Fill with a repeating pattern that deflates to roughly the right size
  for (let i = 0; i < remaining; i++) {
    padData[i] = i % 256;
  }
  const padChunk = makeChunk("IDAT", padData);

  return concatBytes([signature, ihdr, idat, padChunk, iend]);
}

// --- JPEG generation ---

function generateJpeg(
  width: number,
  height: number,
  targetBytes: number,
  seed = 42,
): Uint8Array {
  const parts: Uint8Array[] = [];

  // SOI marker
  parts.push(new Uint8Array([0xff, 0xd8]));

  // APP0 (JFIF header)
  const app0 = new Uint8Array([
    0xff,
    0xe0,
    0x00,
    0x10, // marker + length
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00, // "JFIF\0"
    0x01,
    0x01, // version 1.1
    0x00, // aspect ratio units (0 = no units)
    0x00,
    0x01, // X density
    0x00,
    0x01, // Y density
    0x00,
    0x00, // no thumbnail
  ]);
  parts.push(app0);

  // DQT (quantization table — minimal valid one)
  const dqt = new Uint8Array(69);
  dqt[0] = 0xff;
  dqt[1] = 0xdb; // marker
  dqt[2] = 0x00;
  dqt[3] = 0x43; // length (67)
  dqt[4] = 0x00; // table 0, 8-bit precision
  for (let i = 5; i < 69; i++) dqt[i] = 1; // all quantization values = 1
  parts.push(dqt);

  // SOF0 (start of frame — baseline DCT)
  const sof0 = new Uint8Array([
    0xff,
    0xc0,
    0x00,
    0x0b, // marker + length
    0x08, // precision (8 bits)
    (height >> 8) & 0xff,
    height & 0xff, // height
    (width >> 8) & 0xff,
    width & 0xff, // width
    0x01, // 1 component (grayscale — simplifies DHT/SOS)
    0x01,
    0x11,
    0x00, // component 1: id=1, sampling=1x1, quant table 0
  ]);
  parts.push(sof0);

  // DHT (Huffman table — minimal DC table)
  const dht = new Uint8Array([
    0xff,
    0xc4,
    0x00,
    0x1f, // marker + length
    0x00, // DC table, id 0
    0x00,
    0x01,
    0x05,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b,
  ]);
  parts.push(dht);

  // SOS (start of scan)
  const sos = new Uint8Array([
    0xff,
    0xda,
    0x00,
    0x08, // marker + length
    0x01, // 1 component
    0x01,
    0x00, // component 1, DC table 0 / AC table 0
    0x00,
    0x3f,
    0x00, // spectral selection: 0-63, successive approx: 0
  ]);
  parts.push(sos);

  // Entropy-coded data — random bytes (not valid DCT but fills to target size)
  // Ensure no 0xFF bytes appear without stuffing (0xFF → 0xFF 0x00)
  const headerSize = parts.reduce((sum, p) => sum + p.length, 0);
  const dataSize = targetBytes - headerSize - 2; // -2 for EOI
  const scanData = new Uint8Array(dataSize);
  // Seeded, not random. Blobs are content-addressed and the API exposes no
  // delete, so a fixture whose bytes change per run uploads a new object every
  // time and can never be reclaimed. Fixed bytes are what make repeat runs
  // deduplicate onto the same objects and keep the footprint flat.
  const rng = seededRandom(seed);
  const raw = new Uint8Array(dataSize);
  for (let k = 0; k < dataSize; k++) raw[k] = Math.floor(rng() * 256);
  let j = 0;
  for (let i = 0; i < dataSize && j < raw.length; i++) {
    scanData[i] = raw[j++];
    // Avoid accidental markers in the scan data
    if (scanData[i] === 0xff && i + 1 < dataSize) {
      scanData[++i] = 0x00; // byte stuffing
    }
  }
  parts.push(scanData);

  // EOI marker
  parts.push(new Uint8Array([0xff, 0xd9]));

  return concatBytes(parts);
}

// --- PDF generation ---

function generatePdf(targetBytes: number, seed = 42): Uint8Array {
  const corpus = new Corpus({ seed });
  const encoder = new TextEncoder();

  // PDF overhead is ~500 bytes, so generate targetBytes worth of text
  let textContent = "";
  while (encoder.encode(textContent).length < targetBytes * 0.8) {
    textContent += corpus.paragraph() + "\n\n";
  }

  const streamData = deflateSync(Buffer.from(textContent));

  const objects: string[] = [];

  // Object 1: Catalog
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");

  // Object 2: Pages
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj");

  // Object 3: Page
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj",
  );

  // Object 4: Content stream (compressed)
  const streamHeader = `4 0 obj\n<< /Length ${streamData.length} /Filter /FlateDecode >>\nstream\n`;
  const streamFooter = "\nendstream\nendobj";

  // Object 5: Font
  objects.push(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
  );

  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  let body = "";
  const offsets: number[] = [];

  let offset = header.length;
  for (const obj of objects) {
    offsets.push(offset);
    body += obj + "\n";
    offset += obj.length + 1;
  }

  offsets.splice(3, 0, offset);
  offset += streamHeader.length + streamData.length + streamFooter.length + 1;

  const bodyParts = [
    objects[0] + "\n",
    objects[1] + "\n",
    objects[2] + "\n",
    streamHeader,
  ];
  const bodyAfterStream = [
    streamFooter + "\n",
    objects[3] + "\n", // object 5 (font) is objects[3] in the array
  ];

  const bodyBefore = header + bodyParts.join("");
  const bodyAfter = bodyAfterStream.join("");

  // Cross-reference table
  const xrefOffset =
    encoder.encode(bodyBefore).length +
    streamData.length +
    encoder.encode(bodyAfter).length;
  const xref = `xref\n0 6\n0000000000 65535 f \n`;
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  const textParts = encoder.encode(bodyBefore + bodyAfter + xref + trailer);
  const result = new Uint8Array(textParts.length + streamData.length);

  const beforeStream = encoder.encode(bodyBefore);
  const afterStream = encoder.encode(bodyAfter + xref + trailer);

  result.set(beforeStream, 0);
  result.set(streamData, beforeStream.length);
  result.set(afterStream, beforeStream.length + streamData.length);

  // If under target, the corpus text wasn't enough — this shouldn't happen
  // with the 0.8 factor above, but pad if needed
  if (result.length < targetBytes) {
    const padded = new Uint8Array(targetBytes);
    padded.set(result, 0);
    // Fill remainder with comment lines (valid PDF)
    const padding = encoder.encode(
      "\n% " + "x".repeat(targetBytes - result.length - 3),
    );
    padded.set(padding, result.length);
    return padded;
  }

  return result;
}

// --- DOCX generation (minimal zip with XML) ---

function generateDocx(targetBytes: number, seed = 42): Uint8Array {
  const corpus = new Corpus({ seed });

  let bodyXml = "";
  while (new TextEncoder().encode(bodyXml).length < targetBytes * 0.7) {
    const para = corpus.paragraph();
    bodyXml += `<w:p><w:r><w:t>${escapeXml(para)}</w:t></w:r></w:p>`;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}</w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const files: { name: string; data: Uint8Array }[] = [
    {
      name: "[Content_Types].xml",
      data: new TextEncoder().encode(contentTypes),
    },
    { name: "_rels/.rels", data: new TextEncoder().encode(rels) },
    { name: "word/document.xml", data: new TextEncoder().encode(documentXml) },
  ];

  return createMinimalZip(files);
}

// --- CSV generation ---

/** Fixed reference date, so a generated CSV is byte-identical across runs. */
const CSV_EPOCH_MS = Date.UTC(2026, 0, 1);

function generateCsv(targetBytes: number, seed = 42): Uint8Array {
  const corpus = new Corpus({ seed });
  const rows: string[] = ["id,title,url,tags,created_at"];

  let byteCount = new TextEncoder().encode(rows[0]).length;
  let i = 0;

  while (byteCount < targetBytes) {
    const title = corpus.title().replace(/,/g, " ");
    const url = corpus.url();
    const tags = `"${corpus.word()},${corpus.word()}"`;
    // A fixed epoch rather than `Date.now()`, for the same reason the JPEG's
    // scan data is seeded: a wall-clock value makes every run's bytes unique.
    const date = new Date(CSV_EPOCH_MS - i * 86400000).toISOString();
    const row = `${i + 1},${title},${url},${tags},${date}`;
    rows.push(row);
    byteCount += new TextEncoder().encode(row + "\n").length;
    i++;
  }

  return new TextEncoder().encode(rows.join("\n"));
}

// --- Text generation ---

function generateText(targetBytes: number, seed = 42): Uint8Array {
  const corpus = new Corpus({ seed });
  let text = "";
  while (new TextEncoder().encode(text).length < targetBytes) {
    text += corpus.paragraph() + "\n\n";
  }
  return new TextEncoder().encode(text.slice(0, targetBytes));
}

// --- Fixtures registry ---

export const BLOB_FIXTURES: BlobFixture[] = [
  {
    name: "text-note",
    mimeType: "text/plain",
    extension: "txt",
    targetBytes: 5_120,
    generate: (seed = 42) => generateText(5_120, seed),
  },
  {
    name: "csv-export",
    mimeType: "text/csv",
    extension: "csv",
    targetBytes: 102_400,
    generate: (seed = 42) => generateCsv(102_400, seed),
  },
  {
    name: "mac-screenshot",
    mimeType: "image/png",
    extension: "png",
    targetBytes: 204_800,
    generate: (seed = 42) => generatePng(640, 480, 204_800, seed),
  },
  {
    name: "word-document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
    targetBytes: 204_800,
    generate: (seed = 42) => generateDocx(204_800, seed),
  },
  {
    name: "short-pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    targetBytes: 512_000,
    generate: (seed = 42) => generatePdf(512_000, seed),
  },
  {
    name: "iphone-photo",
    mimeType: "image/jpeg",
    extension: "jpg",
    targetBytes: 3_145_728, // 3MB
    generate: (seed = 42) => generateJpeg(2048, 1536, 3_145_728, seed),
  },
  {
    name: "long-pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    targetBytes: 5_242_880, // 5MB
    generate: (seed = 42) => generatePdf(5_242_880, seed),
  },
  {
    name: "dslr-photo",
    mimeType: "image/jpeg",
    extension: "jpg",
    targetBytes: 8_388_608, // 8MB
    generate: (seed = 42) => generateJpeg(4032, 3024, 8_388_608, seed),
  },
];

/** The first fixture registered for the type, not the closest match. */
export function getFixtureByMime(mime: string): BlobFixture | undefined {
  return BLOB_FIXTURES.find((f) => f.mimeType === mime);
}

export function getFixtureByName(name: string): BlobFixture | undefined {
  return BLOB_FIXTURES.find((f) => f.name === name);
}

/** Pick a random fixture using a PRNG, weighted toward smaller files. */
export function getRandomFixture(rand: () => number): BlobFixture {
  // Weight distribution: 40% small (<500KB), 40% medium (500KB-5MB), 20% large (>5MB)
  const r = rand();
  if (r < 0.4) {
    // Small: text, csv, png, docx
    const small = BLOB_FIXTURES.filter((f) => f.targetBytes < 512_000);
    return small[Math.floor(rand() * small.length)];
  } else if (r < 0.8) {
    // Medium: short-pdf, iphone-photo
    const medium = BLOB_FIXTURES.filter(
      (f) => f.targetBytes >= 512_000 && f.targetBytes <= 5_242_880,
    );
    return medium[Math.floor(rand() * medium.length)];
  } else {
    // Large: long-pdf, dslr-photo
    const large = BLOB_FIXTURES.filter((f) => f.targetBytes > 5_242_880);
    return large.length > 0
      ? large[Math.floor(rand() * large.length)]
      : BLOB_FIXTURES[BLOB_FIXTURES.length - 1];
  }
}

// --- Utility functions ---

function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)));
  return chunk;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Stored (uncompressed) entries only: a DOCX fixture needs a valid container,
 * not a small one.
 */
function createMinimalZip(
  files: { name: string; data: Uint8Array }[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const crc = crc32(file.data);

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression (stored)
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.data.length, true); // compressed size
    lv.setUint32(22, file.data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    parts.push(local);
    parts.push(file.data);

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra field length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralDir.push(central);

    offset += local.length + file.data.length;
  }

  // End of central directory
  const centralDirSize = centralDir.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  return concatBytes([...parts, ...centralDir, eocd]);
}
