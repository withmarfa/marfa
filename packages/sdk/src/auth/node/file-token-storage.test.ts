/**
 * FileTokenStorage — the blob lands in the file's oauth slot, sibling
 * fields survive every operation, and delete removes only the slot.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenStorage } from "../storage.js";
import { FileTokenStorage } from "./file-token-storage.js";
import { readConfigFile, writeConfigFile } from "./config-file.js";

let workdir: string;
let path: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "marfa-sdk-file-storage-test-"));
  path = join(workdir, "default.json");
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

// Typed as the interface so calls go through the same (key, value) protocol
// the token provider uses.
function storage(): TokenStorage {
  return new FileTokenStorage({
    path,
    clientId: "client-1",
    issuer: "http://localhost:8602",
  });
}

describe("FileTokenStorage", () => {
  it("returns null before anything is stored", async () => {
    expect(await storage().get("ignored")).toBeNull();
  });

  it("stores the blob in the oauth slot with client_id and issuer alongside", async () => {
    await storage().set("ignored", '{"access_token":"at"}');
    const file = await readConfigFile(path);
    expect(file?.oauth).toEqual({
      client_id: "client-1",
      issuer: "http://localhost:8602",
      blob: '{"access_token":"at"}',
    });
  });

  it("round-trips through get", async () => {
    const s = storage();
    await s.set("ignored", "blob-value");
    expect(await s.get("ignored")).toBe("blob-value");
  });

  it("preserves sibling fields (url, key) across set", async () => {
    await writeConfigFile(path, { url: "http://localhost:8602", key: "k1" });
    await storage().set("ignored", "blob-value");
    const file = await readConfigFile(path);
    expect(file?.url).toBe("http://localhost:8602");
    expect(file?.key).toBe("k1");
    expect(file?.oauth?.blob).toBe("blob-value");
  });

  it("delete removes the session and leaves the registration", async () => {
    // It used to take the whole `oauth` slot. The registration store keeps
    // its record in that same slot, so signing out cost a fresh client
    // registration on the way back in and abandoned the old row, which
    // nothing on the client can revoke. A session ending says nothing about
    // whether the client the server minted is still good.
    await writeConfigFile(path, { url: "http://localhost:8602" });
    const s = storage();
    await s.set("ignored", "blob-value");
    await s.delete("ignored");
    const file = await readConfigFile(path);
    expect(file?.oauth?.blob).toBeUndefined();
    expect(file?.oauth?.client_id).toBe("client-1");
    expect(file?.url).toBe("http://localhost:8602");
    expect(await s.get("ignored")).toBeNull();
  });

  it("delete is a no-op when no file exists", async () => {
    await expect(storage().delete("ignored")).resolves.toBeUndefined();
  });
});
