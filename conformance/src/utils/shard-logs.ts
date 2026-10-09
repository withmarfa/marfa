import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FRESH_SERVER_LOGS } from "./fresh-server.js";

export interface Shards {
  /** Every request log the shards kept: each shard's server, then the servers its fixtures booted. */
  logs: string[];
  /** The document the servers served; every shard served the same. */
  document: unknown;
  shards: number;
}

/**
 * Reads the folder a run's shard artifacts were downloaded into, one folder
 * for each: the log of the server that shard drove, the logs of the servers
 * its fixtures booted, and the document it served.
 *
 * Refuses what would let a check pass for the wrong reason: no shards at all,
 * a shard without a log, and shards that served different documents, since
 * one document is held to every log.
 */
export function readShards(dir: string): Shards {
  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  if (names.length === 0) {
    throw new Error(`no shard folders in ${dir}; there is nothing to merge`);
  }
  const logs: string[] = [];
  let document: unknown;
  let served: string | undefined;
  for (const name of names) {
    const shard = join(dir, name);
    const log = join(shard, "server.log");
    const documentPath = join(shard, "openapi.json");
    if (!existsSync(log)) throw new Error(`${name} has no server.log`);
    if (!existsSync(documentPath)) {
      throw new Error(`${name} has no openapi.json`);
    }
    logs.push(log);
    const fresh = join(shard, FRESH_SERVER_LOGS);
    if (existsSync(fresh)) {
      logs.push(
        ...readdirSync(fresh)
          .filter((file) => file.endsWith(".log"))
          .sort()
          .map((file) => join(fresh, file)),
      );
    }
    const parsed: unknown = JSON.parse(readFileSync(documentPath, "utf8"));
    const text = JSON.stringify(parsed);
    if (served !== undefined && served !== text) {
      throw new Error(
        `${name} served a different document from the shards before it, so they were not one build`,
      );
    }
    served = text;
    document = parsed;
  }
  return { logs, document, shards: names.length };
}
