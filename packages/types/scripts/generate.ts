/**
 * Generates the TypeScript registries from the in-tree JSON schemas.
 *
 * Output: generated/type-registry.ts, generated/edge-type-registry.ts
 *
 * Every schema goes through the same `validateTypeSchema` the runtime
 * `POST /types` endpoint uses, so a schema that builds here is one a client
 * could have submitted over the wire.
 *
 * Usage: pnpm generate
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FieldDefinition, TypeSchema } from "../src/schema-types.js";
import {
  validateEdgeTypeSchema,
  validateTypeSchema,
} from "../src/schema-validation.js";

const typesRoot = resolve(import.meta.dirname, "..");
const coreDir = join(typesRoot, "core");
const connectorsDir = join(typesRoot, "connectors");
const systemDir = join(coreDir, "system");
const edgesDir = join(coreDir, "edges");
const outDir = join(typesRoot, "generated");

interface RawSchema {
  file: string;
  data: Record<string, unknown>;
}

function loadDir(dir: string): RawSchema[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.sort().map((file) => ({
    file: join(dir, file),
    data: JSON.parse(readFileSync(join(dir, file), "utf-8")) as Record<
      string,
      unknown
    >,
  }));
}

// Dormant stubs stay on disk as a record of shape but never reach the runtime
// registry, so they are neither validated nor emitted.
const active = (schemas: RawSchema[]): RawSchema[] =>
  schemas.filter((s) => s.data._deferred !== true);

const coreRaw = active(loadDir(coreDir));
const connectorRaw = active(loadDir(connectorsDir));
const systemRaw = active(loadDir(systemDir));

/** The declared identifier, or "" when the file omits one — the validator
 *  reports that as an error, so ordering just needs to be stable. */
function schemaId(s: RawSchema): string {
  return typeof s.data.id === "string" ? s.data.id : "";
}

// Parents must be validated and registered before their children, and
// `compatible_with` targets before the connector types that claim them. Sorting
// by identifier depth puts every ancestor ahead of its descendants, and the
// family order below puts core ahead of the connectors that reference it.
function byDepth(a: RawSchema, b: RawSchema): number {
  const depth = (s: RawSchema) => schemaId(s).split(".").length;
  return depth(a) - depth(b) || schemaId(a).localeCompare(schemaId(b));
}

const registry = new Map<string, TypeSchema>();
const failures: string[] = [];

/**
 * Merges an ancestor chain into one field map. The emitted registry entries
 * carry fully resolved fields so a consumer reading a subtype sees everything
 * an item of that type may hold without walking parents itself.
 */
function resolveFields(schema: TypeSchema): Record<string, FieldDefinition> {
  const chain: TypeSchema[] = [];
  const seen = new Set<string>();
  let cursor: TypeSchema | undefined = schema;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parent ? registry.get(cursor.parent) : undefined;
  }
  const fields: Record<string, FieldDefinition> = {};
  for (const ancestor of chain) {
    for (const [name, def] of Object.entries(ancestor.fields)) {
      // A child may sharpen an inherited field's description or tighten it to
      // required; required-ness is never lost on the way down.
      const inherited = fields[name];
      fields[name] = inherited?.required ? { ...def, required: true } : def;
    }
  }
  return fields;
}

/** Nearest declaration wins; an omitted block inherits the ancestor's. */
function resolveInherited<K extends "display_hints" | "merge_policy">(
  schema: TypeSchema,
  key: K,
): TypeSchema[K] {
  const seen = new Set<string>();
  let cursor: TypeSchema | undefined = schema;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor[key]) return cursor[key];
    cursor = cursor.parent ? registry.get(cursor.parent) : undefined;
  }
  return undefined;
}

/**
 * `merge_policy` is the one inherited block that composes rather than
 * replaces: a child's per-field entries layer over the ancestors' and its
 * `default` replaces theirs, so a subtype can override one field's strategy
 * without restating the rest.
 */
function resolveMergePolicy(schema: TypeSchema): TypeSchema["merge_policy"] {
  const chain: TypeSchema[] = [];
  const seen = new Set<string>();
  let cursor: TypeSchema | undefined = schema;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parent ? registry.get(cursor.parent) : undefined;
  }
  const fields: Record<string, string> = {};
  let defaultStrategy: string | undefined;
  let saw = false;
  for (const ancestor of chain) {
    const policy = ancestor.merge_policy;
    if (!policy) continue;
    saw = true;
    if (policy.fields) Object.assign(fields, policy.fields);
    if (policy.default) defaultStrategy = policy.default;
  }
  if (!saw) return undefined;
  const out = {} as NonNullable<TypeSchema["merge_policy"]>;
  if (Object.keys(fields).length > 0) {
    out.fields = fields as NonNullable<TypeSchema["merge_policy"]>["fields"];
  }
  if (defaultStrategy) {
    out.default = defaultStrategy as NonNullable<
      TypeSchema["merge_policy"]
    >["default"];
  }
  return out;
}

function buildFamily(raws: RawSchema[]): TypeSchema[] {
  const built: TypeSchema[] = [];
  for (const raw of [...raws].sort(byDepth)) {
    const result = validateTypeSchema(raw.data, {
      resolveSchema: (id) => registry.get(id),
    });
    if (!result.success) {
      for (const error of result.errors) {
        failures.push(`  ${raw.file}\n    ${error.field}: ${error.message}`);
      }
      continue;
    }
    const schema: TypeSchema = {
      ...result.data,
      fields: {},
    };
    registry.set(schema.id, schema);
    schema.fields = resolveFields(result.data);
    const hints = resolveInherited(result.data, "display_hints");
    if (hints) schema.display_hints = hints;
    const mergePolicy = resolveMergePolicy(result.data);
    if (mergePolicy) schema.merge_policy = mergePolicy;
    built.push(schema);
  }
  return built;
}

const coreTypes = buildFamily(coreRaw);
const connectorTypes = buildFamily(connectorRaw);
const systemTypes = buildFamily(systemRaw);

if (failures.length > 0) {
  console.error(
    `Build aborted: ${String(failures.length)} in-tree schema error(s). The build-time and runtime validators are the same module, so every one of these would also be rejected by POST /types.\n\n${failures.join("\n")}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function varName(id: string): string {
  return id
    .split(".")
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("")
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function fieldLiteral(field: FieldDefinition): string {
  const parts: string[] = [`type: ${quote(field.type)}`];
  if (field.description) parts.push(`description: ${quote(field.description)}`);
  if (field.required) parts.push("required: true");
  if (field.enum_values) {
    parts.push(`enum_values: [${field.enum_values.map(quote).join(", ")}]`);
  }
  if (field.items_type) parts.push(`items_type: ${quote(field.items_type)}`);
  if (field.format) parts.push(`format: ${quote(field.format)}`);
  if (field.searchable === false) parts.push("searchable: false");
  if (field.maxLength !== undefined) {
    parts.push(`maxLength: ${String(field.maxLength)}`);
  }
  if (field.maxItems !== undefined) {
    parts.push(`maxItems: ${String(field.maxItems)}`);
  }
  return `{ ${parts.join(", ")} }`;
}

function emitSchema(schema: TypeSchema, lines: string[]): void {
  lines.push(`const ${varName(schema.id)}: TypeSchema = {`);
  lines.push(`  id: ${quote(schema.id)},`);
  if (schema.parent) lines.push(`  parent: ${quote(schema.parent)},`);
  if (schema.label) lines.push(`  label: ${quote(schema.label)},`);
  if (schema.description) {
    lines.push(`  description: ${quote(schema.description)},`);
  }
  lines.push(`  version: ${String(schema.version)},`);
  lines.push("  fields: {");
  for (const [name, def] of Object.entries(schema.fields)) {
    lines.push(`    ${name}: ${fieldLiteral(def)},`);
  }
  lines.push("  },");
  if (schema.display_hints) {
    const parts: string[] = [];
    if (schema.display_hints.title_field) {
      parts.push(`title_field: ${quote(schema.display_hints.title_field)}`);
    }
    if (schema.display_hints.body_field) {
      parts.push(`body_field: ${quote(schema.display_hints.body_field)}`);
    }
    if (parts.length > 0) {
      lines.push(`  display_hints: { ${parts.join(", ")} },`);
    }
  }
  if (schema.merge_policy) {
    const parts: string[] = [];
    const policyFields = schema.merge_policy.fields;
    if (policyFields && Object.keys(policyFields).length > 0) {
      const entries = Object.entries(policyFields)
        .map(([k, v]) => `${k}: ${quote(v)}`)
        .join(", ");
      parts.push(`fields: { ${entries} }`);
    }
    if (schema.merge_policy.default) {
      parts.push(`default: ${quote(schema.merge_policy.default)}`);
    }
    if (parts.length > 0) {
      lines.push(`  merge_policy: { ${parts.join(", ")} },`);
    }
  }
  // Emitted as declared, never flattened down the parent chain. Roles resolve
  // through the ancestry at lookup time because they have to: a type
  // registered at runtime under a shipped parent never passes through this
  // codegen, and a role that only worked for in-tree types would be a role
  // only we can use.
  if (schema.roles && schema.roles.length > 0) {
    lines.push(`  roles: [${schema.roles.map(quote).join(", ")}],`);
  }
  if (schema.compatible_with && schema.compatible_with.length > 0) {
    lines.push(
      `  compatible_with: [${schema.compatible_with.map(quote).join(", ")}],`,
    );
  }
  lines.push("};");
  lines.push("");
}

const lines: string[] = [];
lines.push(
  "// Auto-generated from core/*.json, connectors/*.json and core/system/*.json — do not edit manually.",
);
lines.push("// Run `pnpm --filter @withmarfa/types generate` to regenerate.");
lines.push("");
lines.push('import type { TypeSchema } from "../src/schema-types.js";');
lines.push("");

for (const schema of coreTypes) emitSchema(schema, lines);
lines.push("export const ALL_TYPES: TypeSchema[] = [");
for (const schema of coreTypes) lines.push(`  ${varName(schema.id)},`);
lines.push("];");
lines.push("");

// Connector types ship in the same package but are a separate family: they
// describe one vendor's payload shape rather than a life-noun the whole
// platform agrees on, and a deployment that talks to none of those vendors
// carries them purely as a compatibility target. Emitting them separately is
// what lets the catalog say which is which; both families register into the
// same runtime registry, so the identifiers a caller sees are unchanged.
for (const schema of connectorTypes) emitSchema(schema, lines);
lines.push("export const ALL_CONNECTOR_TYPES: TypeSchema[] = [");
for (const schema of connectorTypes) lines.push(`  ${varName(schema.id)},`);
lines.push("];");
lines.push("");

// The `system.*` set is registered alongside the rest but tracked separately so
// search defaults can exclude it and the bounded `active | revoked` lifecycle
// applies only here.
for (const schema of systemTypes) emitSchema(schema, lines);
lines.push("export const ALL_SYSTEM_TYPES: TypeSchema[] = [");
for (const schema of systemTypes) lines.push(`  ${varName(schema.id)},`);
lines.push("];");
lines.push("");

// The identifier set as literal types, so a consumer that keys a map or a
// switch by type id can be checked by the compiler rather than by whoever
// remembers to look. Four sibling repositories carried maps naming types
// this package had already deleted; nothing failed, because a plain
// `Record<string, …>` cannot tell a live identifier from a dead one.
const allTypeIds = [...coreTypes, ...connectorTypes, ...systemTypes]
  .map((schema) => schema.id)
  .sort();
lines.push("export const ALL_TYPE_IDS = [");
for (const id of allTypeIds) lines.push(`  ${quote(id)},`);
lines.push("] as const;");
lines.push("");
lines.push("export type PlatformTypeId = (typeof ALL_TYPE_IDS)[number];");
lines.push("");

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "type-registry.ts");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(
  `Generated ${String(coreTypes.length)} core + ${String(connectorTypes.length)} connector + ${String(systemTypes.length)} system types -> ${outPath}`,
);

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

// Edge JSON goes through the same validator the runtime registration route
// family uses, so a malformed file fails the build here instead of reaching
// the registry as a blind cast. The validator also owns normalization:
// constraints defaulted, cascade defaulted, property fields folded through
// the item-field model.
const edgeSchemas = loadDir(edgesDir).map((raw) => {
  const result = validateEdgeTypeSchema(raw.data);
  if (!result.success) {
    console.error(`Invalid edge type schema in ${raw.file}:`);
    for (const error of result.errors) {
      console.error(`  ✗ ${error.field}: ${error.message}`);
    }
    process.exit(1);
  }
  return result.data;
});

function edgeVarName(id: string): string {
  return id
    .split("-")
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("");
}

const edgeLines: string[] = [];
edgeLines.push(
  "// Auto-generated from core/edges/*.json — do not edit manually.",
);
edgeLines.push(
  "// Run `pnpm --filter @withmarfa/types generate` to regenerate.",
);
edgeLines.push("");
edgeLines.push('import type { EdgeTypeSchema } from "../src/schema-types.js";');
edgeLines.push("");

for (const edge of edgeSchemas) {
  edgeLines.push(`const ${edgeVarName(edge.id)}: EdgeTypeSchema = {`);
  edgeLines.push(`  id: ${quote(edge.id)},`);
  if (edge.label) edgeLines.push(`  label: ${quote(edge.label)},`);
  if (edge.description) {
    edgeLines.push(`  description: ${quote(edge.description)},`);
  }
  edgeLines.push(`  cardinality: ${quote(edge.cardinality)},`);
  const src = edge.source_type_constraints;
  const tgt = edge.target_type_constraints;
  edgeLines.push(`  source_type_constraints: [${src.map(quote).join(", ")}],`);
  edgeLines.push(`  target_type_constraints: [${tgt.map(quote).join(", ")}],`);
  edgeLines.push(`  cascade_on_delete: ${quote(edge.cascade_on_delete)},`);
  const propSchema = edge.property_schema;
  if (Object.keys(propSchema).length === 0) {
    edgeLines.push(`  property_schema: {},`);
  } else {
    edgeLines.push("  property_schema: {");
    // Already normalized by the validator: a `format: "url"` on an edge
    // property has collapsed to `type: "url"` exactly as on an item field.
    for (const [name, def] of Object.entries(propSchema)) {
      edgeLines.push(`    ${name}: ${fieldLiteral(def)},`);
    }
    edgeLines.push("  },");
  }
  edgeLines.push("};");
  edgeLines.push("");
}

edgeLines.push("export const ALL_EDGE_TYPES: EdgeTypeSchema[] = [");
for (const edge of edgeSchemas) edgeLines.push(`  ${edgeVarName(edge.id)},`);
edgeLines.push("];");
edgeLines.push("");

const edgeOutPath = join(outDir, "edge-type-registry.ts");
writeFileSync(edgeOutPath, edgeLines.join("\n") + "\n");
console.log(
  `Generated ${String(edgeSchemas.length)} edge types -> ${edgeOutPath}`,
);
