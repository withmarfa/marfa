/**
 * Shared config-file store IO — atomic writes, chmod 0600, path resolution, sync read,
 * roundtrip preservation of unknown fields.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configDir,
  deleteConfigFile,
  mergeConfigFile,
  parsePersistedTokens,
  readConfigFile,
  readConfigFileSync,
  resolveConfigPath,
  resolveInstanceName,
  writeConfigFile,
} from "./config-file.js";

let workdir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "marfa-sdk-auth-node-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = workdir;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(workdir, { recursive: true, force: true });
});

describe("resolveInstanceName", () => {
  it('defaults to "default" when no flag/env', () => {
    delete process.env.MARFA_INSTANCE;
    expect(resolveInstanceName()).toBe("default");
  });

  it("honors the MARFA_INSTANCE env", () => {
    process.env.MARFA_INSTANCE = "staging";
    expect(resolveInstanceName()).toBe("staging");
    delete process.env.MARFA_INSTANCE;
  });

  it("flag wins over env", () => {
    process.env.MARFA_INSTANCE = "staging";
    expect(resolveInstanceName("prod")).toBe("prod");
    delete process.env.MARFA_INSTANCE;
  });

  it.each([
    ["Default", "uppercase"],
    ["has space", "space"],
    ["", "empty"],
    ["-leading", "leading hyphen"],
    ["has_underscore", "underscore"],
    ["x".repeat(65), "too long"],
  ])('rejects "%s" (%s)', (name) => {
    expect(() => resolveInstanceName(name)).toThrow(/Invalid instance name/);
  });

  it("accepts lowercase alphanumeric and hyphens", () => {
    expect(resolveInstanceName("prod-eu-1")).toBe("prod-eu-1");
  });
});

describe("configDir / resolveConfigPath", () => {
  it("uses ~/.marfa/<instance>.json", () => {
    expect(configDir()).toBe(join(workdir, ".marfa"));
    expect(resolveConfigPath("default")).toBe(
      join(workdir, ".marfa", "default.json"),
    );
    expect(resolveConfigPath("staging")).toBe(
      join(workdir, ".marfa", "staging.json"),
    );
  });
});

describe("writeConfigFile", () => {
  it("creates ~/.marfa with mode 0700 and the file with mode 0600", async () => {
    const path = resolveConfigPath("default");
    await writeConfigFile(path, { url: "http://localhost:8602", key: "k1" });

    const dirStat = await stat(configDir());
    // mask off type bits, keep permission bits
    expect(dirStat.mode & 0o777).toBe(0o700);
    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("round-trips a config object", async () => {
    const path = resolveConfigPath("default");
    const written = {
      url: "http://localhost:8602",
      oauth: {
        client_id: "marfa-cli",
        issuer: "http://localhost:8602",
        blob: "{}",
      },
    };
    await writeConfigFile(path, written);
    const back = await readConfigFile(path);
    expect(back).toEqual(written);
  });

  it("overwrite is full replacement (writeConfigFile clears prior fields)", async () => {
    const path = resolveConfigPath("default");
    await writeConfigFile(path, { url: "http://localhost:8602", key: "k1" });
    await writeConfigFile(path, { url: "http://localhost:8602" });
    const back = await readConfigFile(path);
    expect(back).toEqual({ url: "http://localhost:8602" });
  });

  it("tightens dir mode if it pre-existed with looser perms", async () => {
    // Pre-create the dir with 0o755
    const dir = configDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);

    const path = resolveConfigPath("default");
    await writeConfigFile(path, { url: "http://localhost:8602" });
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

describe("mergeConfigFile", () => {
  it("preserves unrelated fields when patching", async () => {
    const path = resolveConfigPath("default");
    await writeConfigFile(path, { url: "http://localhost:8602", key: "k1" });
    await mergeConfigFile(path, {
      oauth: {
        client_id: "marfa-cli",
        issuer: "http://localhost:8602",
        blob: "{}",
      },
    });
    const back = await readConfigFile(path);
    expect(back?.url).toBe("http://localhost:8602");
    expect(back?.key).toBe("k1");
    expect(back?.oauth?.client_id).toBe("marfa-cli");
  });

  it("writes file at 0600 even on merge", async () => {
    const path = resolveConfigPath("default");
    await mergeConfigFile(path, { url: "http://localhost:8602" });
    const fileStat = await stat(path);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });
});

describe("readConfigFile / readConfigFileSync", () => {
  it("returns null on missing file (async)", async () => {
    expect(await readConfigFile(resolveConfigPath("default"))).toBeNull();
  });

  it("returns null on missing file (sync)", () => {
    expect(readConfigFileSync(resolveConfigPath("default"))).toBeNull();
  });

  it("throws on malformed JSON (async)", async () => {
    const path = resolveConfigPath("default");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(configDir(), { recursive: true, mode: 0o700 });
    await writeFile(path, "{not json", { mode: 0o600 });
    await expect(readConfigFile(path)).rejects.toThrow(/Failed to parse/);
  });

  it("throws on non-object JSON (sync)", async () => {
    const path = resolveConfigPath("default");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(configDir(), { recursive: true, mode: 0o700 });
    await writeFile(path, "[]", { mode: 0o600 });
    expect(() => readConfigFileSync(path)).toThrow(/expected JSON object/);
  });
});

describe("deleteConfigFile", () => {
  it("removes the file if present", async () => {
    const path = resolveConfigPath("default");
    await writeConfigFile(path, { url: "http://localhost:8602" });
    await deleteConfigFile(path);
    expect(await readConfigFile(path)).toBeNull();
  });

  it("is a no-op if missing", async () => {
    await expect(
      deleteConfigFile(resolveConfigPath("default")),
    ).resolves.toBeUndefined();
  });
});

describe("parsePersistedTokens", () => {
  it("parses a well-formed blob", () => {
    const blob = JSON.stringify({
      access_token: "at",
      refresh_token: "rt",
      access_expires_at: 1700000000000,
      scope: "core.note:read",
    });
    expect(parsePersistedTokens(blob)).toEqual({
      access_token: "at",
      refresh_token: "rt",
      access_expires_at: 1700000000000,
      scope: "core.note:read",
    });
  });

  it("throws on missing fields", () => {
    expect(() => parsePersistedTokens('{"access_token":"x"}')).toThrow(
      /malformed/,
    );
  });
});
