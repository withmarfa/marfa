import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarfaClient, type SecureStorage } from "./client.js";

/**
 * Static factory parity tests — covers `MarfaClient.fromEnvironment()`
 * and `MarfaClient.fromSecureStorage()`. Mirrors the Swift SDK's
 * `MarfaClientTests` coverage of the same surfaces.
 */

describe("MarfaClient.fromEnvironment", () => {
  let originalUrl: string | undefined;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalUrl = process.env.MARFA_API_URL;
    originalKey = process.env.MARFA_API_KEY;
    delete process.env.MARFA_API_URL;
    delete process.env.MARFA_API_KEY;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.MARFA_API_URL;
    else process.env.MARFA_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.MARFA_API_KEY;
    else process.env.MARFA_API_KEY = originalKey;
  });

  it("returns null when MARFA_API_URL is missing", () => {
    process.env.MARFA_API_KEY = "marfa_k1_test";
    expect(MarfaClient.fromEnvironment()).toBeNull();
  });

  it("returns null when MARFA_API_KEY is missing", () => {
    process.env.MARFA_API_URL = "http://localhost:8602";
    expect(MarfaClient.fromEnvironment()).toBeNull();
  });

  it("returns null when both env vars are missing", () => {
    expect(MarfaClient.fromEnvironment()).toBeNull();
  });

  it("returns null when MARFA_API_URL is empty", () => {
    process.env.MARFA_API_URL = "";
    process.env.MARFA_API_KEY = "marfa_k1_test";
    expect(MarfaClient.fromEnvironment()).toBeNull();
  });

  it("returns null when MARFA_API_KEY is empty", () => {
    process.env.MARFA_API_URL = "http://localhost:8602";
    process.env.MARFA_API_KEY = "";
    expect(MarfaClient.fromEnvironment()).toBeNull();
  });

  it("builds a client when both env vars are populated", () => {
    process.env.MARFA_API_URL = "http://localhost:8602";
    process.env.MARFA_API_KEY = "marfa_k1_test";
    const client = MarfaClient.fromEnvironment();
    expect(client).toBeInstanceOf(MarfaClient);
  });

  it("merges the extra options arg onto the env-derived credential", () => {
    process.env.MARFA_API_URL = "http://localhost:8602";
    process.env.MARFA_API_KEY = "marfa_k1_test";
    const client = MarfaClient.fromEnvironment({ timeoutMs: 1234 });
    // The client is opaque; we only assert the path didn't throw and a
    // client emerged. Per-request timeoutMs threading is covered in
    // transport-level tests.
    expect(client).toBeInstanceOf(MarfaClient);
  });
});

describe("MarfaClient.fromSecureStorage", () => {
  /** In-memory `SecureStorage` for the tests — production callers wire
   *  a real backend (file, OS keyring, etc). */
  class InMemoryStorage implements SecureStorage {
    constructor(private entries: Record<string, string>) {}
    get(account: string): Promise<string | null> {
      return Promise.resolve(this.entries[account] ?? null);
    }
  }

  it("throws when the storage returns no value for the account", async () => {
    const storage = new InMemoryStorage({});
    await expect(
      MarfaClient.fromSecureStorage({
        storage,
        account: "missing-account",
        url: "http://localhost:8602",
      }),
    ).rejects.toThrow(/missing-account/);
  });

  it("builds a client when the storage returns a key", async () => {
    const storage = new InMemoryStorage({
      "staging:admin": "marfa_k1_stored",
    });
    const client = await MarfaClient.fromSecureStorage({
      storage,
      account: "staging:admin",
      url: "http://localhost:8602",
    });
    expect(client).toBeInstanceOf(MarfaClient);
  });

  it("threads extra ClientConfig fields through", async () => {
    const storage = new InMemoryStorage({ x: "marfa_k1_x" });
    const client = await MarfaClient.fromSecureStorage({
      storage,
      account: "x",
      url: "http://localhost:8602",
      timeoutMs: 4321,
    });
    expect(client).toBeInstanceOf(MarfaClient);
  });
});
