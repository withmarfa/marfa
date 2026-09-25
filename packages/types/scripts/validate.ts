/**
 * Checks every in-tree JSON schema against the runtime validator.
 *
 * This script owns no rules of its own. It loads `core/`, `core/system/`
 * and `core/edges/`, resolves each family in dependency order,
 * and runs `validateTypeSchema` / `validateEdgeTypeSchema` — the same
 * functions the registration routes call. A schema that passes here is one a
 * client could submit over the wire unchanged. It also asks
 * `unreadTopLevelKeys`, which the wire does not, so a file cannot carry a key
 * nothing reads.
 *
 * Usage: pnpm --filter @withmarfa/types validate
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TypeSchema } from "../src/schema-types.js";
import {
  unreadTopLevelKeys,
  validateEdgeTypeSchema,
  validateTypeSchema,
} from "../src/schema-validation.js";
import type { SchemaValidationIssue } from "../src/schema-validation.js";

const typesRoot = resolve(import.meta.dirname, "..");

const FAMILIES = [
  { name: "core", dir: join(typesRoot, "core") },
  { name: "system", dir: join(typesRoot, "core", "system") },
] as const;

interface RawSchema {
  family: string;
  file: string;
  data: Record<string, unknown>;
}

function loadFamily(family: string, dir: string): RawSchema[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.sort().map((file) => ({
    family,
    file,
    data: JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<
      string,
      unknown
    >,
  }));
}

/** The declared identifier, or "" when the file omits one — the validator
 *  reports that as an error, so ordering just needs to be stable. */
function schemaId(s: RawSchema): string {
  return typeof s.data.id === "string" ? s.data.id : "";
}

const registry = new Map<string, TypeSchema>();
const errors: string[] = [];

function report(where: string, issues: SchemaValidationIssue[]): void {
  for (const error of issues) {
    errors.push(`${where} → ${error.field}\n      ${error.message}`);
  }
}
const counts: Record<string, number> = {};
let checked = 0;

for (const family of FAMILIES) {
  const raws = loadFamily(family.name, family.dir);
  counts[family.name] = raws.length;
  // Ancestors must be in the registry before the schemas that name them;
  // identifier depth orders parents ahead of children, and the family order
  // puts core ahead of system.
  raws.sort(
    (a, b) =>
      schemaId(a).split(".").length - schemaId(b).split(".").length ||
      schemaId(a).localeCompare(schemaId(b)),
  );
  for (const raw of raws) {
    checked++;
    report(`${family.name}/${raw.file}`, unreadTopLevelKeys(raw.data, "type"));
    const result = validateTypeSchema(raw.data, {
      resolveSchema: (id) => registry.get(id),
    });
    if (!result.success) {
      report(`${family.name}/${raw.file}`, result.errors);
      continue;
    }
    if (registry.has(result.data.id)) {
      errors.push(
        `${family.name}/${raw.file} → id\n      Duplicate type id "${result.data.id}".`,
      );
      continue;
    }
    // Register with resolved fields so a child's inheritance check sees the
    // full ancestor set.
    const parent = result.data.parent
      ? registry.get(result.data.parent)
      : undefined;
    registry.set(result.data.id, {
      ...result.data,
      fields: { ...(parent?.fields ?? {}), ...result.data.fields },
    });
  }
}

// Edge types are their own family with their own validator; they share the
// item-field model for edge properties but none of the type machinery
// (inheritance, compatible_with), so they don't join the registry above.
const edgeRaws = loadFamily("edge", join(typesRoot, "core", "edges"));
const edgeIds = new Set<string>();
counts.edge = edgeRaws.length;
for (const raw of edgeRaws) {
  checked++;
  report(`edge/${raw.file}`, unreadTopLevelKeys(raw.data, "edge"));
  const result = validateEdgeTypeSchema(raw.data);
  if (!result.success) {
    report(`edge/${raw.file}`, result.errors);
    continue;
  }
  if (edgeIds.has(result.data.id)) {
    errors.push(
      `edge/${raw.file} → id\n      Duplicate edge type id "${result.data.id}".`,
    );
    continue;
  }
  edgeIds.add(result.data.id);
}

const summary = [...FAMILIES.map((f) => f.name), "edge"]
  .map((name) => `${String(counts[name] ?? 0)} ${name}`)
  .join(", ");
console.log(`Validated ${String(checked)} schemas (${summary})\n`);

if (errors.length > 0) {
  console.error(`Found ${String(errors.length)} error(s):\n`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}

console.log("All schemas valid ✓");
