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
});
