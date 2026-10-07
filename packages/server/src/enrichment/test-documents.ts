import { crc32, deflateRawSync } from "node:zlib";

/** A zip of `files`, each deflated, written by hand so a test needs no
 *  library beside the one under test. */
export function zip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const compressed = deflateRawSync(data, { level: 9 });
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A Word document whose body is `body`, which is where a test puts the
 *  amplification. */
export function docx(body: Buffer, extraParts = 0): Buffer {
  const text = (value: string) => Buffer.from(value);
  const extras: Record<string, Buffer> = {};
  for (let i = 0; i < extraParts; i++)
    extras[`extra/${String(i)}.txt`] = text("");
  return zip({
    ...extras,
    "[Content_Types].xml": text(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": text(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "word/document.xml": Buffer.concat([
      text(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${NS}"><w:body>`,
      ),
      body,
      text("</w:body></w:document>"),
    ]),
  });
}

/** One paragraph holding `characters` copies of one letter: a few hundred
 *  kilobytes on the wire, and the whole of it in memory once read. */
export function longParagraph(characters: number): Buffer {
  return Buffer.concat([
    Buffer.from("<w:p><w:r><w:t>"),
    Buffer.alloc(characters, "a"),
    Buffer.from("</w:t></w:r></w:p>"),
  ]);
}

/** `count` paragraphs of a few words: many small elements, none of them
 *  large, which is what fills a heap without inflating far. */
export function manyParagraphs(count: number): Buffer {
  return Buffer.from("<w:p><w:r><w:t>word</w:t></w:r></w:p>".repeat(count));
}
