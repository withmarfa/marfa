import { describe, it, expect } from "vitest";
import {
  blobLinkExpiry,
  MAX_BLOB_LINK_TTL_SECONDS,
  mintBlobLink,
  verifyBlobLink,
} from "./blob-link.js";

const SECRET = "s".repeat(32);
const HASH = `sha256:${"ab".repeat(32)}`;
const NOW = 1_800_000_000;

/** The query a minted link carries, the way the fetch door reads it. */
function query(url: string): { expires: string; signature: string } {
  const params = new URL(url).searchParams;
  return {
    expires: params.get("expires") ?? "",
    signature: params.get("signature") ?? "",
  };
}

describe("the instance-served blob link", () => {
  it("mints a link under the origin, for the hash, that verifies until it expires", () => {
    const url = mintBlobLink(SECRET, "https://marfa.example", HASH, NOW + 60);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://marfa.example");
    expect(parsed.pathname).toBe(`/blobs/${HASH}/fetch`);
    const { expires, signature } = query(url);
    expect(expires).toBe(String(NOW + 60));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW)).toBe(true);
    expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW + 59)).toBe(
      true,
    );
    expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW + 60)).toBe(
      false,
    );
  });

  it("lives its whole lifetime however late in a second it is minted, and dies within a second after", () => {
    const at = (ms: number) => Math.floor(ms / 1000);
    for (const into of [0, 1, 500, 999]) {
      const mintedMs = NOW * 1000 + into;
      const expiresAt = blobLinkExpiry(mintedMs, 1);
      const { expires, signature } = query(
        mintBlobLink(SECRET, "https://marfa.example", HASH, expiresAt),
      );
      expect(
        verifyBlobLink(SECRET, HASH, expires, signature, at(mintedMs)),
      ).toBe(true);
      expect(
        verifyBlobLink(SECRET, HASH, expires, signature, at(mintedMs + 999)),
      ).toBe(true);
      expect(
        verifyBlobLink(SECRET, HASH, expires, signature, at(mintedMs + 2000)),
      ).toBe(false);
    }
  });

  it("never outlives the seven-day cap, however late in a second it is minted", () => {
    const at = (ms: number) => Math.floor(ms / 1000);
    const capMs = MAX_BLOB_LINK_TTL_SECONDS * 1000;
    for (const into of [0, 1, 500, 999]) {
      const mintedMs = NOW * 1000 + into;
      const { expires, signature } = query(
        mintBlobLink(
          SECRET,
          "https://marfa.example",
          HASH,
          blobLinkExpiry(mintedMs, MAX_BLOB_LINK_TTL_SECONDS),
        ),
      );
      expect(
        verifyBlobLink(
          SECRET,
          HASH,
          expires,
          signature,
          at(mintedMs + capMs - 1000),
        ),
      ).toBe(true);
      expect(
        verifyBlobLink(SECRET, HASH, expires, signature, at(mintedMs + capMs)),
      ).toBe(false);
    }
  });

  it("refuses a signature that was altered, is not hex, or is the wrong length", () => {
    const { expires, signature } = query(
      mintBlobLink(SECRET, "https://marfa.example", HASH, NOW + 60),
    );
    expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW)).toBe(true);
    const flipped =
      (signature.startsWith("0") ? "1" : "0") + signature.slice(1);
    expect(verifyBlobLink(SECRET, HASH, expires, flipped, NOW)).toBe(false);
    expect(verifyBlobLink(SECRET, HASH, expires, "z".repeat(64), NOW)).toBe(
      false,
    );
    expect(
      verifyBlobLink(SECRET, HASH, expires, signature.slice(0, 62), NOW),
    ).toBe(false);
    expect(verifyBlobLink(SECRET, HASH, expires, signature + "00", NOW)).toBe(
      false,
    );
    expect(verifyBlobLink(SECRET, HASH, expires, "", NOW)).toBe(false);
  });

  it("verifies only under the secret it was minted with", () => {
    const { expires, signature } = query(
      mintBlobLink(SECRET, "https://marfa.example", HASH, NOW + 60),
    );
    expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW)).toBe(true);
    expect(verifyBlobLink("t".repeat(32), HASH, expires, signature, NOW)).toBe(
      false,
    );
  });

  it("binds the signature to the hash and to the expiry", () => {
    const { expires, signature } = query(
      mintBlobLink(SECRET, "https://marfa.example", HASH, NOW + 60),
    );
    expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW)).toBe(true);
    const other = `sha256:${"cd".repeat(32)}`;
    expect(verifyBlobLink(SECRET, other, expires, signature, NOW)).toBe(false);
    expect(verifyBlobLink(SECRET, HASH, String(NOW + 61), signature, NOW)).toBe(
      false,
    );
  });

  it("refuses an expiry that is not a plain number of seconds", () => {
    const { signature } = query(
      mintBlobLink(SECRET, "https://marfa.example", HASH, NOW + 60),
    );
    for (const expires of [
      "",
      "soon",
      "1e12",
      "-1",
      "1.5",
      String(NOW + 60) + "0000000",
    ]) {
      expect(verifyBlobLink(SECRET, HASH, expires, signature, NOW)).toBe(false);
    }
  });
});
