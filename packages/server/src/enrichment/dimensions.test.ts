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
