import { describe, it, expect } from "vitest";
import {
  BLOB_FIXTURES,
  getFixtureByMime,
  getFixtureByName,
  getRandomFixture,
} from "./blob-fixtures.js";

describe("blob fixtures", () => {
  it("all fixtures generate without errors", () => {
    for (const fixture of BLOB_FIXTURES) {
      expect(() => fixture.generate()).not.toThrow();
    }
  });

  it("fixtures are approximately the target size (within 50%)", () => {
    for (const fixture of BLOB_FIXTURES) {
      const data = fixture.generate();
      const ratio = data.length / fixture.targetBytes;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(1.5);
    }
  });

  it("fixtures are deterministic with the same seed", () => {
    for (const fixture of BLOB_FIXTURES) {
      const a = fixture.generate(123);
      const b = fixture.generate(123);
      expect(a.length).toBe(b.length);
      // Every byte, not the first hundred. A JPEG's fixed header is 147 bytes
      // long, so a prefix check cannot see the scan data underneath it, which
      // is the only part a non-deterministic generator would vary.
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });
});

describe("PNG fixture", () => {
  it("starts with the PNG signature", () => {
    const fixture = getFixtureByName("mac-screenshot")!;
    const data = fixture.generate();
    expect(data[0]).toBe(137); // \x89
    expect(data[1]).toBe(80); // P
    expect(data[2]).toBe(78); // N
    expect(data[3]).toBe(71); // G
    expect(data[4]).toBe(13); // \r
    expect(data[5]).toBe(10); // \n
    expect(data[6]).toBe(26); // \x1a
    expect(data[7]).toBe(10); // \n
  });
});

describe("JPEG fixtures", () => {
  it("starts with SOI marker", () => {
    const fixture = getFixtureByName("iphone-photo")!;
    const data = fixture.generate();
    expect(data[0]).toBe(0xff);
    expect(data[1]).toBe(0xd8);
  });

  it("ends with EOI marker", () => {
    const fixture = getFixtureByName("iphone-photo")!;
    const data = fixture.generate();
    expect(data[data.length - 2]).toBe(0xff);
    expect(data[data.length - 1]).toBe(0xd9);
  });

  it("DSLR photo is larger than iPhone photo", () => {
    const iphone = getFixtureByName("iphone-photo")!.generate();
    const dslr = getFixtureByName("dslr-photo")!.generate();
    expect(dslr.length).toBeGreaterThan(iphone.length);
  });
});

describe("PDF fixtures", () => {
  it("starts with %PDF-", () => {
    const fixture = getFixtureByName("short-pdf")!;
    const data = fixture.generate();
    const header = new TextDecoder().decode(data.slice(0, 5));
    expect(header).toBe("%PDF-");
  });

  it("long PDF is larger than short PDF", () => {
    const short = getFixtureByName("short-pdf")!.generate();
    const long = getFixtureByName("long-pdf")!.generate();
    expect(long.length).toBeGreaterThan(short.length);
  });
});

describe("DOCX fixture", () => {
  it("starts with ZIP signature (PK)", () => {
    const fixture = getFixtureByName("word-document")!;
    const data = fixture.generate();
    expect(data[0]).toBe(0x50); // P
    expect(data[1]).toBe(0x4b); // K
    expect(data[2]).toBe(0x03);
    expect(data[3]).toBe(0x04);
  });
});

describe("CSV fixture", () => {
  it("starts with a header row", () => {
    const fixture = getFixtureByName("csv-export")!;
    const data = fixture.generate();
    const text = new TextDecoder().decode(data.slice(0, 50));
    expect(text).toContain("id,title,url,tags,created_at");
  });
});

describe("text fixture", () => {
  it("contains readable text", () => {
    const fixture = getFixtureByName("text-note")!;
    const data = fixture.generate();
    const text = new TextDecoder().decode(data);
    expect(text.length).toBeGreaterThan(100);
    // Should contain words, not random bytes
    expect(text).toMatch(/[a-zA-Z]{3,}/);
  });
});

describe("lookup functions", () => {
  it("getFixtureByMime finds fixtures", () => {
    expect(getFixtureByMime("image/png")).toBeDefined();
    expect(getFixtureByMime("image/jpeg")).toBeDefined();
    expect(getFixtureByMime("application/pdf")).toBeDefined();
    expect(getFixtureByMime("text/csv")).toBeDefined();
    expect(getFixtureByMime("text/plain")).toBeDefined();
  });

  it("getFixtureByMime returns undefined for unknown MIME", () => {
    expect(getFixtureByMime("video/mp4")).toBeUndefined();
  });

  it("getRandomFixture returns a fixture", () => {
    let i = 0;
    const rand = () => (i++ * 0.1) % 1;
    for (let j = 0; j < 20; j++) {
      const fixture = getRandomFixture(rand);
      expect(fixture).toBeDefined();
      expect(fixture.mimeType).toBeTruthy();
    }
  });
});
