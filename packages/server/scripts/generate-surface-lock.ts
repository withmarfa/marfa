/**
 * Regenerate `published-surface-lock.json` from the built tree.
 *
 * Run after a deliberate surface change, with the version already moved.
 * Running it to make a failing test pass without moving a version is the
 * one thing it must not be used for, and the test's message says so.
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPublishedSurfaces } from "../src/publishing/read-surfaces.js";
import { buildSurfaceLock } from "../src/publishing/published-surface.js";

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = resolve(SERVER_ROOT, "..");
const LOCK_PATH = resolve(SERVER_ROOT, "published-surface-lock.json");

const lock = buildSurfaceLock(readPublishedSurfaces(PACKAGES_DIR));
writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
console.log(
  `published-surface-lock.json: ${String(Object.keys(lock).length)} packages`,
);
