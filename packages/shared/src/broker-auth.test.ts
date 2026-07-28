/**
 * The rule both ends of the broker hop agree on. Pinned here rather
 * than in either caller so a change to the comparison has to be a
 * deliberate edit to a test that names what it protects.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { isBrokerAuthorized, constantTimeBytesEqual } from "./broker-auth.js";

const KEY = "broker_key_value";

/** SHA-256 tag width, and so the width of everything compared here. */
const TAG_BYTES = 32;

/** A stand-in tag. Any fixed bytes work; these are just not all alike. */
function tag(): Uint8Array {
  return Uint8Array.from({ length: TAG_BYTES }, (_, i) => (i * 7 + 11) % 256);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isBrokerAuthorized", () => {
  it("admits the exact Bearer form", async () => {
    await expect(isBrokerAuthorized(`Bearer ${KEY}`, KEY)).resolves.toBe(true);
  });

  it.each([
    ["absent header", undefined],
    ["null header", null],
    ["empty header", ""],
    ["bare key without the scheme", KEY],
    ["wrong key", "Bearer nope"],
    ["prefix of the key", `Bearer ${KEY.slice(0, -1)}`],
    ["key with trailing whitespace", `Bearer ${KEY} `],
    ["lowercased scheme", `bearer ${KEY}`],
    ["a different scheme", `Basic ${KEY}`],
    ["double scheme", `Bearer Bearer ${KEY}`],
  ])("refuses %s", async (_label, header) => {
    await expect(isBrokerAuthorized(header, KEY)).resolves.toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
  ])("fails closed when the configured key is %s", async (_label, key) => {
    // The interpolation trap: a caller as misconfigured as the callee
    // would send exactly what a naive compare accepts.
    await expect(isBrokerAuthorized("Bearer undefined", key)).resolves.toBe(
      false,
    );
    await expect(isBrokerAuthorized("Bearer ", key)).resolves.toBe(false);
    await expect(isBrokerAuthorized("Bearer null", key)).resolves.toBe(false);
    await expect(isBrokerAuthorized(undefined, key)).resolves.toBe(false);
  });

  it("admits a key longer than one hash block", async () => {
    // The comparison MACs both sides before comparing them, so a key
    // that spans several SHA-256 blocks exercises a different path
    // through Web Crypto than the short keys above.
    const long = "k".repeat(4096);
    await expect(isBrokerAuthorized(`Bearer ${long}`, long)).resolves.toBe(
      true,
    );
    await expect(isBrokerAuthorized(`Bearer ${long}x`, long)).resolves.toBe(
      false,
    );
  });

  it("compares bytes, not glyphs", async () => {
    // Two strings that render identically but differ byte for byte are
    // not interchangeable: the key is an opaque secret, not text to be
    // matched leniently. Precomposed U+00E9 against e + U+0301.
    await expect(isBrokerAuthorized("Bearer é", "é")).resolves.toBe(false);
    await expect(isBrokerAuthorized("Bearer é", "é")).resolves.toBe(true);
  });
});

/**
 * Every byte position has to reach the answer.
 *
 * The cases above cannot show that, and it is the property most likely
 * to be lost by accident. Turning the accumulating `|=` into a plain
 * `=` leaves a function that compares the final byte and nothing else,
 * reads as correct, and passes lint, types and the rest of this file:
 * the tags being compared are MACs under a key that changes every
 * call, so a wrong key still lands on a matching last byte about once
 * in 256, and the cases above notice only on the runs where it does
 * not. A test that catches a live authentication bypass on some runs
 * and not others is worse than no test, because it reads as coverage
 * and gets deleted the first time it flakes.
 *
 * A fixed pair of byte sequences removes the randomness. Thirty-two
 * pairs, each differing at one index and identical everywhere else,
 * say the thing exactly: change any byte and the answer changes. The
 * last-byte-only version fails thirty-one of them on every run.
 */
describe("constantTimeBytesEqual", () => {
  it("accepts identical sequences", () => {
    expect(constantTimeBytesEqual(tag(), tag())).toBe(true);
  });

  it.each(Array.from({ length: TAG_BYTES }, (_, i) => i))(
    "rejects a pair differing only at byte %i",
    (index) => {
      const a = tag();
      const b = tag();
      b[index] = (b[index] ?? 0) ^ 0xff;
      expect(constantTimeBytesEqual(a, b)).toBe(false);
      expect(constantTimeBytesEqual(b, a)).toBe(false);
    },
  );

  it("rejects a longer sequence that agrees on every shared byte", () => {
    // Only the length term can catch this one: the loop walks the
    // shorter side, and every byte it reads matches.
    const short = tag();
    const long = new Uint8Array(TAG_BYTES + 1);
    long.set(short);
    expect(constantTimeBytesEqual(short, long)).toBe(false);
  });

  it("rejects a shorter sequence that agrees on every shared byte", () => {
    // The mirror case, with the extra byte left at zero so reading off
    // the end of the shorter side cannot save it either.
    const short = tag();
    const long = new Uint8Array(TAG_BYTES + 1);
    long.set(short);
    expect(constantTimeBytesEqual(long, short)).toBe(false);
  });
});

/**
 * The compare is reached, and its key is not reusable.
 *
 * Two regressions the value-level cases cannot see. Replacing the whole
 * thing with `===` returns the same answers, and so does hoisting the
 * HMAC key to module scope. Both are visible in what the function asks
 * of Web Crypto: a compare that hashes calls `sign`, and a key minted
 * per call calls `getRandomValues` per call. A fixed key is what would
 * let an attacker precompute a tag for a guessed secret and read the
 * result off the comparison.
 */
describe("isBrokerAuthorized reaches the constant-time compare", () => {
  it("MACs under a key it generates for that call", async () => {
    const sign = vi.spyOn(globalThis.crypto.subtle, "sign");
    const randomValues = vi.spyOn(globalThis.crypto, "getRandomValues");

    await expect(isBrokerAuthorized(`Bearer ${KEY}`, KEY)).resolves.toBe(true);
    await expect(isBrokerAuthorized(`Bearer ${KEY}`, KEY)).resolves.toBe(true);

    expect(sign).toHaveBeenCalled();
    expect(randomValues).toHaveBeenCalledTimes(2);
    const keys = randomValues.mock.results.map((r) =>
      Array.from(r.value as Uint8Array).join(","),
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("touches no key material on the short-circuits", async () => {
    // The two refusals that answer before the compare. Asserting they
    // reach no crypto at all is what makes those short-circuits safe to
    // keep: a branch that reads nothing can leak nothing.
    const sign = vi.spyOn(globalThis.crypto.subtle, "sign");
    const randomValues = vi.spyOn(globalThis.crypto, "getRandomValues");

    await expect(isBrokerAuthorized(undefined, KEY)).resolves.toBe(false);
    await expect(isBrokerAuthorized(`Bearer ${KEY}`, "")).resolves.toBe(false);

    expect(sign).not.toHaveBeenCalled();
    expect(randomValues).not.toHaveBeenCalled();
  });
});

/**
 * The one property of a constant-time compare no input can demonstrate.
 *
 * A loop that returns on the first mismatch gives every answer this
 * file asserts, and leaks the position of that mismatch through how
 * long it took. The only check that could see it from the outside is a
 * timing measurement, which is the flaky-by-construction shape this
 * file exists to avoid, so the shape of the loop is asserted instead.
 * Rewriting the accumulation with a branch means editing this list and
 * saying why.
 */
describe("constantTimeBytesEqual takes no shortcut", () => {
  const SOURCE = readFileSync(
    new URL("./broker-auth.ts", import.meta.url),
    "utf8",
  );
  const MARKER = "export function constantTimeBytesEqual(";
  const start = SOURCE.indexOf(MARKER);
  // Top-level declarations close on a brace in the first column.
  const body = SOURCE.slice(start, SOURCE.indexOf("\n}", start));

  it("found the function to check", () => {
    // Vacuity guard. A rename would otherwise leave every assertion
    // below passing against an empty string.
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("for (");
  });

  it.each([
    ["if", /\bif\b/u],
    ["break", /\bbreak\b/u],
    ["continue", /\bcontinue\b/u],
  ])("branches on no `%s`", (_label, pattern) => {
    expect(body).not.toMatch(pattern);
  });

  it("has a single exit", () => {
    expect(body.match(/\breturn\b/gu)).toHaveLength(1);
  });
});
