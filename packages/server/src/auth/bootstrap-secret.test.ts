/**
 * The bootstrap secret's own behaviour, at the level the route tests cannot
 * reach.
 *
 * Every case here is one a route test passes without noticing, because the
 * sentinel claim stands behind the secret check and answers 401 for the same
 * requests. That makes the claim the only thing actually holding the door on
 * a route test, and this file is where the secret has to hold it alone.
 */
import { describe, it, expect } from "vitest";
import {
  BOOTSTRAP_SECRET_KEY,
  bootstrapSecretMatches,
  consumeBootstrapSecret,
  ensureBootstrapSecret,
} from "./bootstrap-secret.js";
import type { Storage } from "../storage/interface.js";

/**
 * A settings store with the two properties that matter: `claim` is atomic
 * insert-or-bail, and `release` removes the row so `get` answers null.
 */
function settingsStorage(): { storage: Storage; rows: Map<string, string> } {
  const rows = new Map<string, string>();
  const storage = {
    settings: {
      get: (key: string) => Promise.resolve(rows.get(key) ?? null),
      set: (key: string, value: string) => {
        rows.set(key, value);
        return Promise.resolve();
      },
      claim: (key: string, value: string) => {
        if (rows.has(key)) return Promise.resolve(false);
        rows.set(key, value);
        return Promise.resolve(true);
      },
      release: (key: string) => {
        rows.delete(key);
        return Promise.resolve();
      },
    },
  } as unknown as Storage;
  return { storage, rows };
}

describe("bootstrapSecretMatches", () => {
  it("refuses an empty presented secret against a consumed one", () => {
    // The case with teeth. `timingSafeEqual` answers true for two zero-length
    // buffers, and a request with no `Authorization` header presents the
    // empty string — so without the absent-secret check first, "secret gone"
    // is an open door rather than a closed one. That state is exactly what a
    // hand-repair of a stuck bootstrap leaves behind.
    expect(bootstrapSecretMatches("", "")).toBe(false);
    expect(bootstrapSecretMatches(null, "")).toBe(false);
    expect(bootstrapSecretMatches(null, "anything")).toBe(false);
  });

  it("answers false rather than throwing on a multi-byte presented secret", () => {
    // The guard compares byte length because `timingSafeEqual` does. A header
    // value may legally carry a byte in 0x80-0xFF, and a string-length guard
    // let one through to throw inside the comparison — which reaches the
    // caller as a 500 with a stack rather than a 401, on an unauthenticated
    // route, firing the error webhook with it.
    const stored = "a".repeat(64);
    const sameUnitsMoreBytes = "é" + "a".repeat(63);
    expect(sameUnitsMoreBytes.length).toBe(stored.length);
    expect(() =>
      bootstrapSecretMatches(stored, sameUnitsMoreBytes),
    ).not.toThrow();
    expect(bootstrapSecretMatches(stored, sameUnitsMoreBytes)).toBe(false);
  });

  it("admits the secret it stored, and nothing one character off", () => {
    const stored = "b".repeat(64);
    expect(bootstrapSecretMatches(stored, stored)).toBe(true);
    expect(bootstrapSecretMatches(stored, "c" + stored.slice(1))).toBe(false);
    expect(bootstrapSecretMatches(stored, stored.slice(0, 63))).toBe(false);
  });
});

describe("ensureBootstrapSecret", () => {
  it("returns the same secret across a restart before the first mint", async () => {
    const { storage } = settingsStorage();
    const first = await ensureBootstrapSecret(storage);
    const second = await ensureBootstrapSecret(storage);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hands every concurrent boot the one secret that was stored", async () => {
    // Two replicas booting against one database both read no secret. A
    // read-then-upsert has both generate one, both write, and both print
    // their own — after which one printed value is dead and the operator has
    // no way to tell which. Claiming makes the loser print the winner's.
    const { storage, rows } = settingsStorage();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureBootstrapSecret(storage)),
    );
    const stored = rows.get(BOOTSTRAP_SECRET_KEY);
    expect(stored).toBeTruthy();
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(stored);
  });
});

describe("consumeBootstrapSecret", () => {
  it("removes the row rather than blanking it", async () => {
    // A blanked row reads as absent in some places and as an empty string in
    // others, and leaves a credential-shaped key in a table nothing prunes.
    const { storage, rows } = settingsStorage();
    await ensureBootstrapSecret(storage);
    await consumeBootstrapSecret(storage);
    expect(rows.has(BOOTSTRAP_SECRET_KEY)).toBe(false);
    expect(await storage.settings.get(BOOTSTRAP_SECRET_KEY)).toBeNull();
  });
});
