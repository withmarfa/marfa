import { describe, expect, it } from "vitest";
import { PICTURE_MAX_EDGE, readPicture } from "./picture.js";
import {
  avif,
  gif,
  html,
  jpeg,
  png,
  pngHeaderOnly,
  svg,
  webp,
  webpExtended,
  webpLossy,
} from "./test-pictures.js";

describe("readPicture", () => {
  it("decides the kind and size of each accepted kind from its bytes", () => {
    expect(readPicture(png(5, 7))).toEqual({
      ok: true,
      contentType: "image/png",
      width: 5,
      height: 7,
    });
    expect(readPicture(jpeg(300, 200))).toEqual({
      ok: true,
      contentType: "image/jpeg",
      width: 300,
      height: 200,
    });
    for (const file of [webp(40, 30), webpLossy(40, 30), webpExtended(40, 30)])
      expect(readPicture(file)).toEqual({
        ok: true,
        contentType: "image/webp",
        width: 40,
        height: 30,
      });
  });

  it("accepts the largest edge and refuses one past it, for each kind", () => {
    const edge = PICTURE_MAX_EDGE;
    for (const make of [
      (w: number, h: number) => pngHeaderOnly(w, h),
      (w: number, h: number) => jpeg(w, h),
      (w: number, h: number) => webp(w, h),
      (w: number, h: number) => webpLossy(w, h),
      (w: number, h: number) => webpExtended(w, h),
    ]) {
      expect(readPicture(make(edge, edge))).toMatchObject({ ok: true });
      expect(readPicture(make(edge + 1, 8))).toEqual({
        ok: false,
        reason: "dimensions",
      });
      expect(readPicture(make(8, edge + 1))).toEqual({
        ok: false,
        reason: "dimensions",
      });
    }
  });

  it("refuses a zero edge", () => {
    expect(readPicture(pngHeaderOnly(0, 8))).toEqual({
      ok: false,
      reason: "dimensions",
    });
    expect(readPicture(pngHeaderOnly(8, 0))).toEqual({
      ok: false,
      reason: "dimensions",
    });
    expect(readPicture(jpeg(0, 8))).toEqual({
      ok: false,
      reason: "dimensions",
    });
    expect(readPicture(webpLossy(0, 8))).toEqual({
      ok: false,
      reason: "dimensions",
    });
  });

  it("refuses an empty body", () => {
    expect(readPicture(new Uint8Array())).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses a file that is not one of the three kinds, whatever it looks like", () => {
    for (const file of [gif(), avif(), svg(), html(), Buffer.from("hello")])
      expect(readPicture(file)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("refuses a file cut inside its header, for each kind", () => {
    for (const whole of [png(), jpeg(), webp(), webpLossy(), webpExtended()]) {
      // The witness: the whole file reads.
      expect(readPicture(whole)).toMatchObject({ ok: true });
      for (const cut of [2, 4, 8, 12, 16, 20, 23]) {
        const result = readPicture(whole.subarray(0, cut));
        expect(result, `cut at ${String(cut)}`).toMatchObject({ ok: false });
      }
    }
  });

  it("refuses a JPEG that ends before its frame header", () => {
    const withoutFrame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(readPicture(withoutFrame)).toEqual({
      ok: false,
      reason: "damaged",
    });
  });

  it("reads a file whose header parses but whose data is cut short", () => {
    const whole = png(16, 16);
    expect(readPicture(whole.subarray(0, 40))).toMatchObject({
      ok: true,
      contentType: "image/png",
    });
  });
});
