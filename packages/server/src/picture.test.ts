import { describe, expect, it } from "vitest";
import { PICTURE_MAX_EDGE, readPicture } from "./picture.js";
import {
  avif,
  gif,
  html,
  jpeg,
  png,
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
      (w: number, h: number) => png(w, h),
      (w: number, h: number) => jpeg(w, h),
      (w: number, h: number) => webp(w, h),
      (w: number, h: number) => webpLossy(w, h),
      (w: number, h: number) => webpExtended(w, h),
    ]) {
      expect(readPicture(make(edge, 1))).toMatchObject({ ok: true });
      expect(readPicture(make(1, edge))).toMatchObject({ ok: true });
      expect(readPicture(make(edge + 1, 1))).toEqual({
        ok: false,
        reason: "dimensions",
      });
      expect(readPicture(make(1, edge + 1))).toEqual({
        ok: false,
        reason: "dimensions",
      });
    }
  });

  it("refuses a zero edge", () => {
    expect(readPicture(png(0, 8))).toEqual({
      ok: false,
      reason: "dimensions",
    });
    expect(readPicture(png(8, 0))).toEqual({
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

  it("refuses a file cut at any length, for each kind", () => {
    for (const whole of [png(), jpeg(), webp(), webpLossy(), webpExtended()]) {
      expect(readPicture(whole)).toMatchObject({ ok: true });
      for (let cut = 1; cut < whole.length; cut += 1)
        expect(
          readPicture(whole.subarray(0, cut)),
          `${String(whole.length)} bytes cut at ${String(cut)}`,
        ).toMatchObject({ ok: false });
    }
  });

  it("refuses a JPEG that ends before its frame header", () => {
    const withoutFrame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    expect(readPicture(withoutFrame)).toEqual({
      ok: false,
      reason: "damaged",
    });
  });

  it("refuses a PNG with no pixel data, where one with it reads", () => {
    const whole = png();
    expect(readPicture(whole)).toMatchObject({ ok: true });
    const idat = whole.indexOf("IDAT") - 4;
    const idatLength = whole.readUInt32BE(idat);
    const without = Buffer.concat([
      whole.subarray(0, idat),
      whole.subarray(idat + 12 + idatLength),
    ]);
    expect(readPicture(without)).toEqual({ ok: false, reason: "damaged" });
  });

  it("refuses a PNG with bytes after its last chunk", () => {
    expect(readPicture(png())).toMatchObject({ ok: true });
    expect(readPicture(Buffer.concat([png(), Buffer.from([0])]))).toEqual({
      ok: false,
      reason: "damaged",
    });
  });

  it("refuses a PNG whose chunk length runs past the file", () => {
    const whole = Buffer.from(png());
    expect(readPicture(whole)).toMatchObject({ ok: true });
    whole.writeUInt32BE(0x7fffffff, whole.indexOf("IDAT") - 4);
    expect(readPicture(whole)).toEqual({ ok: false, reason: "damaged" });
  });

  it("refuses a WebP whose declared size is not the size of the file", () => {
    for (const whole of [webp(), webpLossy(), webpExtended()]) {
      expect(readPicture(whole)).toMatchObject({ ok: true });
      const longer = Buffer.concat([whole, Buffer.alloc(2)]);
      expect(readPicture(longer)).toEqual({ ok: false, reason: "damaged" });
      const smaller = Buffer.from(whole);
      smaller.writeUInt32LE(whole.readUInt32LE(4) - 2, 4);
      expect(readPicture(smaller)).toEqual({ ok: false, reason: "damaged" });
      const larger = Buffer.from(whole);
      larger.writeUInt32LE(whole.readUInt32LE(4) + 2, 4);
      expect(readPicture(larger)).toEqual({ ok: false, reason: "damaged" });
    }
  });

  it("refuses a JPEG whose scan has no end mark, even when an earlier segment holds one", () => {
    const whole = jpeg();
    expect(readPicture(whole)).toMatchObject({ ok: true });
    const thumbnail = Buffer.from([
      0xff, 0xe1, 0x00, 0x06, 0xff, 0xd8, 0xff, 0xd9,
    ]);
    const frame = whole.indexOf(Buffer.from([0xff, 0xc0]));
    const cut = Buffer.concat([
      whole.subarray(0, frame),
      thumbnail,
      whole.subarray(frame, whole.length - 2),
    ]);
    expect(readPicture(cut)).toEqual({ ok: false, reason: "damaged" });
  });

  it("takes the JPEG kinds browsers draw and refuses the others", () => {
    for (const kind of [0xc0, 0xc1, 0xc2])
      expect(readPicture(jpeg(8, 8, kind)), kind.toString(16)).toMatchObject({
        ok: true,
        contentType: "image/jpeg",
      });
    for (const kind of [
      0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ])
      expect(readPicture(jpeg(8, 8, kind)), kind.toString(16)).toEqual({
        ok: false,
        reason: "damaged",
      });
  });
});
