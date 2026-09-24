import { afterEach, describe, expect, it } from "vitest";
import {
  THUMBNAIL_MAX_BYTES,
  registerTypeSchema,
  unregisterTypeSchema,
  validateProperties,
} from "./type-registry.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBPVP8 "),
]);

const uri = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString("base64")}`;
const padded = (head: Buffer, size: number) =>
  Buffer.concat([head, Buffer.alloc(size - head.length, 7)]);

const TYPE = "test.thumbnail";
afterEach(() => {
  unregisterTypeSchema(TYPE);
});

function check(value: unknown) {
  registerTypeSchema({
    id: TYPE,
    version: 1,
    fields: { thumbnail: { type: "thumbnail" } },
  });
  return validateProperties(TYPE, { thumbnail: value });
}

describe("a thumbnail's value", () => {
  it("is a PNG, JPEG or WebP data URI up to the cap", () => {
    for (const value of [
      uri("image/png", padded(PNG, THUMBNAIL_MAX_BYTES)),
      uri("image/jpeg", padded(JPEG, 200)),
      uri("image/webp", padded(WEBP, 201)),
      uri("image/png", padded(PNG, 202)),
    ]) {
      expect(check(value), value.slice(0, 40)).toEqual({
        success: true,
        data: { thumbnail: value },
      });
    }
  });

  it("is refused over the cap, naming the field", () => {
    const result = check(
      uri("image/png", padded(PNG, THUMBNAIL_MAX_BYTES + 1)),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.field).toBe("thumbnail");
      expect(result.errors[0]?.message).toContain(
        String(THUMBNAIL_MAX_BYTES + 1),
      );
    }
  });

  it("is refused when it is not an image, or not the image it says", () => {
    for (const value of [
      uri("text/plain", padded(PNG, 64)),
      uri("image/gif", Buffer.from("GIF89a")),
      uri("image/jpeg", padded(PNG, 64)),
      uri("image/png", Buffer.from("not an image at all")),
      "https://example.com/thumb.png",
      `data:image/png;base64,${padded(PNG, 64).toString("base64")}A`,
      "data:image/png;base64,",
    ]) {
      expect(check(value).success, value.slice(0, 40)).toBe(false);
    }
  });

  it("is refused when its bytes miss the signature by one byte", () => {
    const nearMisses: [string, Buffer][] = [
      // Everything of the PNG signature but its last byte.
      ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0])],
      // A JPEG's first two bytes, and not its third.
      ["image/jpeg", Buffer.from([0xff, 0xd8, 0x00, 0xe0])],
      // A RIFF container that is not a WebP one.
      [
        "image/webp",
        Buffer.concat([
          Buffer.from("RIFF"),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from("WAVEfmt "),
        ]),
      ],
    ];
    for (const [mime, head] of nearMisses) {
      // The witness: the same length and padding with the real signature
      // is taken, so the refusal below is the signature's.
      const real = { "image/png": PNG, "image/jpeg": JPEG, "image/webp": WEBP }[
        mime
      ];
      expect(check(uri(mime, padded(real ?? PNG, 64))).success, mime).toBe(
        true,
      );
      const result = check(uri(mime, padded(head, 64)));
      expect(result.success, `${mime} near miss`).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.message).toContain(
          "image, as its data URI says",
        );
      }
    }
  });

  it("is refused when its base64 is not the one spelling of its bytes", () => {
    // The witness: the canonical spelling of the same eight bytes is taken.
    expect(check("data:image/png;base64,iVBORw0KGgo=").success).toBe(true);
    // The last character carries a bit the bytes do not use: a lenient
    // decoder reads the same bytes, a strict one refuses it.
    const result = check("data:image/png;base64,iVBORw0KGgp=");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0]?.message).toContain("canonical base64");
    }
  });

  it("is refused, not failed on, when its base64 is not whole groups of four", () => {
    // Base64 of a length no encoder writes, which the decoder throws on
    // rather than answering: a refusal here, never an error.
    for (const value of [
      "data:image/png;base64,AAAAA",
      "data:image/png;base64,iVBORw0KGgoAA",
    ]) {
      const result = check(value);
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(result.errors[0]?.field).toBe("thumbnail");
      }
    }
  });
});
