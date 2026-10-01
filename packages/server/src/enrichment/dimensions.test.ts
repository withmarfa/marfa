/**
 * The readers, at the seam, without a database.
 *
 * These pin what the two libraries actually do rather than what their
 * READMEs promise, because the gap between those is the whole reason the
 * sweeper records a reason instead of assuming coverage. The MP4 case in
 * particular asserts an absence: the media parser reads ISO-BMFF only as
 * far as its audio, so a QuickTime-family video gives up its duration and
 * not its size. Somebody will eventually want that gap closed, and this is
 * where they will find out it is still open.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deriveDimensions, isDimensionMime } from "./dimensions.js";

const fixture = (name: string): Promise<Buffer> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

describe("isDimensionMime", () => {
  it("admits the three media families and nothing else", () => {
    expect(isDimensionMime("image/png")).toBe(true);
    expect(isDimensionMime("audio/mpeg")).toBe(true);
    expect(isDimensionMime("video/webm; codecs=vp9")).toBe(true);
    expect(isDimensionMime("application/pdf")).toBe(false);
    expect(isDimensionMime("text/plain")).toBe(false);
  });
});

describe("deriveDimensions", () => {
  it("reads an image's pixel size", async () => {
    const outcome = await deriveDimensions(
      await fixture("sample.png"),
      "image/png",
    );
    expect(outcome).toEqual({
      kind: "dimensions",
      values: { width: 1700, height: 2200 },
    });
  });

  it("reads an audio file's duration", async () => {
    const outcome = await deriveDimensions(
      await fixture("sample.mp3"),
      "audio/mpeg",
    );
    expect(outcome.kind).toBe("dimensions");
    if (outcome.kind !== "dimensions") return;
    expect(outcome.values.duration).toBeGreaterThan(0.5);
    expect(outcome.values.duration).toBeLessThan(2);
    expect(outcome.values.width).toBeUndefined();
  });

  it("reads a webm's size and duration", async () => {
    const outcome = await deriveDimensions(
      await fixture("sample.webm"),
      "video/webm",
    );
    expect(outcome.kind).toBe("dimensions");
    if (outcome.kind !== "dimensions") return;
    expect(outcome.values.width).toBe(160);
    expect(outcome.values.height).toBe(120);
    expect(outcome.values.duration).toBeGreaterThan(0.5);
  });

  it("reads an mp4's duration and not its size", async () => {
    // The measured gap, asserted rather than described. Closing it means a
    // second video reader, not a new option on this one.
    const outcome = await deriveDimensions(
      await fixture("sample.mp4"),
      "video/mp4",
    );
    expect(outcome.kind).toBe("dimensions");
    if (outcome.kind !== "dimensions") return;
    expect(outcome.values.duration).toBeGreaterThan(0.5);
    expect(outcome.values.width).toBeUndefined();
    expect(outcome.values.height).toBeUndefined();
  });

  it("reports an image format it cannot read rather than throwing", async () => {
    const outcome = await deriveDimensions(
      Buffer.from("not an image at all"),
      "image/x-made-up",
    );
    expect(outcome).toEqual({ kind: "unreadable", reason: "no image reader" });
  });

  it("makes up no size from bytes that only start like a PNG", async () => {
    // The reader checks the signature and reads fixed offsets, so without a
    // header check the bytes after it become a width and a height. The
    // witness is the fixture above, whose header is a real one.
    const signature = (await fixture("sample.png")).subarray(0, 8);
    const noHeader = Buffer.concat([signature, Buffer.alloc(64, 0x5a)]);
    expect(await deriveDimensions(noHeader, "image/png")).toEqual({
      kind: "unreadable",
      reason: "no image header",
    });
    // A header whose size is zero is no size either.
    const zero = Buffer.from(await fixture("sample.png"));
    zero.writeUInt32BE(0, 16);
    expect(await deriveDimensions(zero, "image/png")).toEqual({
      kind: "unreadable",
      reason: "no image header",
    });
  });

  it("reads a GIF, a JPEG and each kind of WebP whose header is whole", async () => {
    // The witnesses for the malformed cases below: each format's reader is
    // reached and answers a size when its header is a real one.
    for (const [name, mime] of [
      ["sample.gif", "image/gif"],
      ["sample.jpg", "image/jpeg"],
      ["sample.webp", "image/webp"],
      ["sample-lossless.webp", "image/webp"],
      ["sample-extended.webp", "image/webp"],
    ] as const) {
      expect(await deriveDimensions(await fixture(name), mime), name).toEqual({
        kind: "dimensions",
        values: { width: 30, height: 20 },
      });
    }
  });

  const noHeader = { kind: "unreadable", reason: "no image header" };

  it("makes up no size from bytes that only start like a GIF", async () => {
    // The screen size sits at fixed offsets after the signature, so garbage
    // there reads as a size unless something checks what follows it.
    const real = await fixture("sample.gif");
    const garbage = Buffer.concat([
      real.subarray(0, 6),
      Buffer.alloc(64, 0x5a),
    ]);
    expect(await deriveDimensions(garbage, "image/gif")).toEqual(noHeader);
    // Cut inside its color table, the screen descriptor leads nowhere.
    expect(await deriveDimensions(real.subarray(0, 20), "image/gif")).toEqual(
      noHeader,
    );
  });

  it("makes up no size from bytes that only start like a JPEG", async () => {
    // A frame marker straight after the start of image, over garbage: the
    // reader takes the next bytes as a size though the segment runs past
    // the end of the file.
    const garbage = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
      Buffer.alloc(64, 0x5a),
    ]);
    expect(await deriveDimensions(garbage, "image/jpeg")).toEqual(noHeader);
    // A segment whose marker is not one, after the first: the reader skips
    // it by its length and finds the real frame after it.
    const real = await fixture("sample.jpg");
    const firstEnd = 4 + real.readUInt16BE(4);
    const notAMarker = Buffer.concat([
      real.subarray(0, firstEnd),
      Buffer.from([0x12, 0x34, 0x00, 0x02]),
      real.subarray(firstEnd),
    ]);
    expect(await deriveDimensions(notAMarker, "image/jpeg")).toEqual(noHeader);
    // A frame header whose length disagrees with its component count.
    const sof = real.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    const miscounted = Buffer.from(real);
    miscounted[sof + 9] = 7;
    expect(await deriveDimensions(miscounted, "image/jpeg")).toEqual(noHeader);
  });

  it("makes up no size from bytes that only start like a WebP", async () => {
    // Each chunk kind is read at fixed offsets once the RIFF header and the
    // chunk's name match, so each needs its own check of a real header.
    for (const name of [
      "sample.webp",
      "sample-lossless.webp",
      "sample-extended.webp",
    ]) {
      const head = (await fixture(name)).subarray(0, 16);
      const garbage = Buffer.concat([head, Buffer.alloc(64, 0x5a)]);
      expect(await deriveDimensions(garbage, "image/webp"), name).toEqual(
        noHeader,
      );
    }
  });

  it("reports a media file it cannot read rather than throwing", async () => {
    const outcome = await deriveDimensions(
      Buffer.from("not a recording either"),
      "audio/x-made-up",
    );
    expect(outcome.kind).toBe("unreadable");
    if (outcome.kind !== "unreadable") return;
    expect(outcome.reason).toMatch(/no readable dimensions|media parse failed/);
  });
});
