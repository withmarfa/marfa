import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readShards } from "./shard-logs.js";

describe("the logs the shards of a run kept", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marfa-shard-logs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function shard(name: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, path, ".."), { recursive: true });
      writeFileSync(join(dir, name, path), text);
    }
  }
  const document = JSON.stringify({ openapi: "3.1.0", paths: {} });

  it("reads each shard's server log and the logs of the servers its fixtures booted", () => {
    shard("marfa-server-log-compliance-1", {
      "server.log": "a",
      "openapi.json": document,
      "fresh-server-logs/one.log": "b",
      "fresh-server-logs/notes.txt": "not a log",
    });
    shard("marfa-server-log-device-1", {
      "server.log": "c",
      "openapi.json": document,
    });
    const read = readShards(dir);
    expect(read.logs.map((path) => path.slice(dir.length + 1))).toEqual([
      "marfa-server-log-compliance-1/server.log",
      "marfa-server-log-compliance-1/fresh-server-logs/one.log",
      "marfa-server-log-device-1/server.log",
    ]);
    expect(read.shards).toBe(2);
    expect(read.document).toEqual({ openapi: "3.1.0", paths: {} });
  });

  it("takes the document two shards served in different spacing as one", () => {
    shard("a", { "server.log": "x", "openapi.json": document });
    shard("b", {
      "server.log": "x",
      "openapi.json": JSON.stringify({ openapi: "3.1.0", paths: {} }, null, 2),
    });
    expect(readShards(dir).shards).toBe(2);
  });

  it("refuses shards that served different documents, which were not one build", () => {
    shard("a", { "server.log": "x", "openapi.json": document });
    shard("b", {
      "server.log": "x",
      "openapi.json": JSON.stringify({ openapi: "3.1.0", paths: { "/x": {} } }),
    });
    expect(() => readShards(dir)).toThrow(/different document/);
  });

  it("refuses a shard with no server log, which would pass for a shard that drew nothing", () => {
    shard("a", { "server.log": "x", "openapi.json": document });
    shard("b", { "openapi.json": document });
    expect(() => readShards(dir)).toThrow(/b has no server\.log/);
  });

  it("refuses a shard with no document", () => {
    shard("a", { "server.log": "x" });
    expect(() => readShards(dir)).toThrow(/a has no openapi\.json/);
  });

  it("refuses a directory with no shards in it, which would pass for a run that drew nothing", () => {
    expect(() => readShards(dir)).toThrow(/no shard/);
  });
});
