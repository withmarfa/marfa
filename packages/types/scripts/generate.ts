/**
 * Generates TypeScript type definitions from JSON schemas.
 * Output: generated/type-registry.ts
 *
 * Usage: pnpm generate
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface JsonField {
  type: string;
  description: string;
  enum_values?: string[];
  items_type?: string;
  format?: string;
}

interface JsonDisplayHints {
  title_field?: string;
  body_field?: string;
}

type JsonMergeStrategy = "last_writer_wins" | "keep_both_copies";

interface JsonMergePolicy {
  fields?: Record<string, JsonMergeStrategy>;
  default?: JsonMergeStrategy;
}

interface JsonSchema {
  id: string;
  parent?: string;
  label: string;
  description: string;
  version: number;
  fields: Record<string, JsonField>;
  required: string[];
  display_hints?: JsonDisplayHints;
  merge_policy?: JsonMergePolicy;
  _deferred?: boolean;
}

const coreDir = resolve(import.meta.dirname, "..", "core");
const systemDir = resolve(coreDir, "system");
const outDir = resolve(import.meta.dirname, "..", "generated");

// Load all schemas — skip dormant stubs (_deferred: true). Top-level core/*.json
// is the regular type set; core/system/*.json is the platform-internal
// `system.*` set which gets emitted into a separate registry.
const coreFiles = readdirSync(coreDir).filter((f) => f.endsWith(".json"));
const schemas: JsonSchema[] = coreFiles
  .map((f) => {
    const raw = readFileSync(join(coreDir, f), "utf-8");
    return JSON.parse(raw) as JsonSchema;
  })
  .filter((s) => s._deferred !== true);

let systemFiles: string[];
try {
  systemFiles = readdirSync(systemDir).filter((f) => f.endsWith(".json"));
} catch {
  systemFiles = [];
}
const systemSchemas: JsonSchema[] = systemFiles.map((f) => {
  const raw = readFileSync(join(systemDir, f), "utf-8");
  return JSON.parse(raw) as JsonSchema;
});

// Shadow rule (parallel to the server-side check in `validateTypeSchema`):
// in-tree core/system types may not declare a field whose name shadows a
// first-class field on the `Item` wire shape. Belt-and-braces against
// future regressions on first-party schemas. Authoritative list mirrors
// `RESERVED_ITEM_FIELDS` in `packages/shared/src/type-registry.ts`, which
// is itself derived from the `Item` interface in
// `packages/shared/src/types.ts`. Keep these two lists in sync — the
// freshness test in `type-registry.test.ts` covers the runtime side; this
// is the build-time gate.
const RESERVED_ITEM_FIELDS = new Set([
  "id",
  "type",
  "state",
  "tier",
  "tenant_id",
  "properties",
  "created_at",
  "updated_at",
  "timestamp",
  "source",
  "source_id",
  "version",
  "schema_version",
  "device",
  "capture_latitude",
  "capture_longitude",
]);

const shadowViolations: { typeId: string; field: string }[] = [];
for (const schema of [...schemas, ...systemSchemas]) {
  for (const fieldName of Object.keys(schema.fields)) {
    if (RESERVED_ITEM_FIELDS.has(fieldName)) {
      shadowViolations.push({ typeId: schema.id, field: fieldName });
    }
  }
}
if (shadowViolations.length > 0) {
  const lines = shadowViolations.map(
    (v) =>
      `  - ${v.typeId}: field "${v.field}" shadows a first-class Item field`,
  );
  console.error(
    `Build aborted: in-tree types declare ${String(shadowViolations.length)} field name(s) that shadow first-class Item wire fields.\n${lines.join("\n")}\n\nFirst-class fields live as top-level columns on the items table; custom-type properties that reuse those names produce ambiguous data. Rename the property, or use the first-class field directly. Authoritative list: RESERVED_ITEM_FIELDS in packages/shared/src/type-registry.ts.`,
  );
  process.exit(1);
}

schemas.sort((a, b) => {
  const depthA = a.id.split(".").length;
  const depthB = b.id.split(".").length;
  return depthA - depthB;
});

function varName(id: string): string {
  return id
    .split(".")
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("")
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// JSON schemas use type:"string" + format:"url"; FieldDefinition uses type:"url" directly.
const FORMAT_TO_TYPE: Record<string, string> = {
  url: "url",
  email: "email",
  datetime: "datetime",
  date: "date",
};

function fieldLiteral(field: JsonField, isRequired: boolean): string {
  const effectiveType =
    (field.format && FORMAT_TO_TYPE[field.format]) ?? field.type;
  const parts: string[] = [`type: "${effectiveType}"`];
  if (field.description) {
    const escaped = field.description
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    parts.push(`description: "${escaped}"`);
  }
  if (isRequired) parts.push("required: true");
  if (field.enum_values) {
    parts.push(
      `enum_values: [${field.enum_values.map((v) => `"${v}"`).join(", ")}]`,
    );
  }
  if (field.items_type) parts.push(`items_type: "${field.items_type}"`);
  return `{ ${parts.join(", ")} }`;
}

const lines: string[] = [];
lines.push("// Auto-generated from core/*.json — do not edit manually.");
lines.push("// Run `pnpm --filter @withmarfa/types generate` to regenerate.");
lines.push("");
lines.push('import type { TypeSchema } from "../src/schema-types.js";');
lines.push("");

const schemaMap = new Map<string, JsonSchema>();
for (const s of schemas) schemaMap.set(s.id, s);

function resolveFields(schema: JsonSchema): {
  fields: Record<string, JsonField>;
  required: Set<string>;
} {
  const chain: JsonSchema[] = [];
  let current: JsonSchema | undefined = schema;
  while (current) {
    chain.unshift(current);
    current = current.parent ? schemaMap.get(current.parent) : undefined;
  }
  const fields: Record<string, JsonField> = {};
  const required = new Set<string>();
  for (const ancestor of chain) {
    Object.assign(fields, ancestor.fields);
    for (const r of ancestor.required) required.add(r);
  }
  return { fields, required };
}

function resolveDisplayHints(schema: JsonSchema): JsonDisplayHints | undefined {
  let current: JsonSchema | undefined = schema;
  while (current) {
    if (current.display_hints) return current.display_hints;
    current = current.parent ? schemaMap.get(current.parent) : undefined;
  }
  return undefined;
}

// Resolve merge_policy — walk parent chain and merge field-by-field.
// Child `fields` entries merge over parent `fields` (per-key); child `default`
// replaces parent `default`. An absent `fields` on a child does not erase the
// parent's entries.
function resolveMergePolicy(schema: JsonSchema): JsonMergePolicy | undefined {
  const chain: JsonSchema[] = [];
  let current: JsonSchema | undefined = schema;
  while (current) {
    chain.unshift(current);
    current = current.parent ? schemaMap.get(current.parent) : undefined;
  }
  const fields: Record<string, JsonMergeStrategy> = {};
  let defaultStrategy: JsonMergeStrategy | undefined;
  let saw = false;
  for (const ancestor of chain) {
    const p = ancestor.merge_policy;
    if (!p) continue;
    saw = true;
    if (p.fields) Object.assign(fields, p.fields);
    if (p.default) defaultStrategy = p.default;
  }
  if (!saw) return undefined;
  const out: JsonMergePolicy = {};
  if (Object.keys(fields).length > 0) out.fields = fields;
  if (defaultStrategy) out.default = defaultStrategy;
  return out;
}

for (const schema of schemas) {
  const name = varName(schema.id);
  const { fields: resolvedFields, required: resolvedRequired } =
    resolveFields(schema);

  lines.push(`const ${name}: TypeSchema = {`);
  lines.push(`  id: "${schema.id}",`);
  if (schema.parent) lines.push(`  parent: "${schema.parent}",`);
  lines.push(`  label: "${schema.label}",`);
  if (schema.description) {
    const escapedDescription = schema.description
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    lines.push(`  description: "${escapedDescription}",`);
  }
  lines.push(`  version: ${String(schema.version)},`);
  lines.push("  fields: {");
  for (const [fieldName, fieldDef] of Object.entries(resolvedFields)) {
    const isReq = resolvedRequired.has(fieldName);
    lines.push(`    ${fieldName}: ${fieldLiteral(fieldDef, isReq)},`);
  }
  lines.push("  },");
  const resolvedHints = resolveDisplayHints(schema);
  if (resolvedHints) {
    const parts: string[] = [];
    if (resolvedHints.title_field) {
      parts.push(`title_field: "${resolvedHints.title_field}"`);
    }
    if (resolvedHints.body_field) {
      parts.push(`body_field: "${resolvedHints.body_field}"`);
    }
    if (parts.length > 0) {
      lines.push(`  display_hints: { ${parts.join(", ")} },`);
    }
  }
  const resolvedPolicy = resolveMergePolicy(schema);
  if (resolvedPolicy) {
    const parts: string[] = [];
    if (
      resolvedPolicy.fields &&
      Object.keys(resolvedPolicy.fields).length > 0
    ) {
      const entries = Object.entries(resolvedPolicy.fields)
        .map(([k, v]) => `${k}: "${v}"`)
        .join(", ");
      parts.push(`fields: { ${entries} }`);
    }
    if (resolvedPolicy.default) {
      parts.push(`default: "${resolvedPolicy.default}"`);
    }
    if (parts.length > 0) {
      lines.push(`  merge_policy: { ${parts.join(", ")} },`);
    }
  }
  lines.push("};");
  lines.push("");
}

lines.push("export const ALL_TYPES: TypeSchema[] = [");
for (const schema of schemas) {
  lines.push(`  ${varName(schema.id)},`);
}
lines.push("];");
lines.push("");

// system.* set — emitted as a separate registry; the consuming runtime
// registers these alongside ALL_TYPES but tracks them separately so search
// defaults can exclude them and the bounded lifecycle (`active | revoked`)
// applies only to this set.
for (const schema of systemSchemas) {
  const name = varName(schema.id);
  const { fields: resolvedFields, required: resolvedRequired } =
    resolveFields(schema);
  lines.push(`const ${name}: TypeSchema = {`);
  lines.push(`  id: "${schema.id}",`);
  if (schema.parent) lines.push(`  parent: "${schema.parent}",`);
  lines.push(`  label: "${schema.label}",`);
  if (schema.description) {
    const escapedDescription = schema.description
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    lines.push(`  description: "${escapedDescription}",`);
  }
  lines.push(`  version: ${String(schema.version)},`);
  lines.push("  fields: {");
  for (const [fieldName, fieldDef] of Object.entries(resolvedFields)) {
    const isReq = resolvedRequired.has(fieldName);
    lines.push(`    ${fieldName}: ${fieldLiteral(fieldDef, isReq)},`);
  }
  lines.push("  },");
  lines.push("};");
  lines.push("");
}

lines.push("export const ALL_SYSTEM_TYPES: TypeSchema[] = [");
for (const schema of systemSchemas) {
  lines.push(`  ${varName(schema.id)},`);
}
lines.push("];");
lines.push("");

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "type-registry.ts");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(
  `Generated ${String(schemas.length)} core types + ${String(systemSchemas.length)} system types -> ${outPath}`,
);

interface JsonFieldLike {
  type: string;
  description?: string;
  enum_values?: string[];
  items_type?: string;
  format?: string;
}

interface JsonEdgeSchema {
  id: string;
  label?: string;
  description?: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  source_type_constraints?: string[];
  target_type_constraints?: string[];
  cascade_on_delete?: "cascade" | "orphan" | "block";
  property_schema?: Record<string, JsonFieldLike>;
}

const edgesDir = resolve(import.meta.dirname, "..", "core", "edges");

function loadEdgeSchemas(): JsonEdgeSchema[] {
  try {
    const edgeFiles = readdirSync(edgesDir).filter((f) => f.endsWith(".json"));
    return edgeFiles.map((f) => {
      const raw = readFileSync(join(edgesDir, f), "utf-8");
      return JSON.parse(raw) as JsonEdgeSchema;
    });
  } catch {
    // No edges directory yet — emit empty registry.
    return [];
  }
}

const edgeSchemas: JsonEdgeSchema[] = loadEdgeSchemas();

function edgeVarName(id: string): string {
  return id
    .split("-")
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("");
}

function fieldLiteralForEdge(field: JsonFieldLike): string {
  const effectiveType =
    (field.format && FORMAT_TO_TYPE[field.format]) ?? field.type;
  const parts: string[] = [`type: "${effectiveType}"`];
  if (field.description) {
    const escaped = field.description
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    parts.push(`description: "${escaped}"`);
  }
  if (field.enum_values) {
    parts.push(
      `enum_values: [${field.enum_values.map((v) => `"${v}"`).join(", ")}]`,
    );
  }
  if (field.items_type) parts.push(`items_type: "${field.items_type}"`);
  return `{ ${parts.join(", ")} }`;
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
  const name = edgeVarName(edge.id);
  edgeLines.push(`const ${name}: EdgeTypeSchema = {`);
  edgeLines.push(`  id: "${edge.id}",`);
  if (edge.label) edgeLines.push(`  label: "${edge.label}",`);
  if (edge.description) {
    const esc = edge.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    edgeLines.push(`  description: "${esc}",`);
  }
  edgeLines.push(`  cardinality: "${edge.cardinality}",`);
  const src = edge.source_type_constraints ?? ["*"];
  const tgt = edge.target_type_constraints ?? ["*"];
  edgeLines.push(
    `  source_type_constraints: [${src.map((t) => `"${t}"`).join(", ")}],`,
  );
  edgeLines.push(
    `  target_type_constraints: [${tgt.map((t) => `"${t}"`).join(", ")}],`,
  );
  edgeLines.push(
    `  cascade_on_delete: "${edge.cascade_on_delete ?? "orphan"}",`,
  );
  const propSchema = edge.property_schema ?? {};
  if (Object.keys(propSchema).length === 0) {
    edgeLines.push(`  property_schema: {},`);
  } else {
    edgeLines.push("  property_schema: {");
    for (const [fieldName, fieldDef] of Object.entries(propSchema)) {
      edgeLines.push(`    ${fieldName}: ${fieldLiteralForEdge(fieldDef)},`);
    }
    edgeLines.push("  },");
  }
  edgeLines.push("};");
  edgeLines.push("");
}

edgeLines.push("export const ALL_EDGE_TYPES: EdgeTypeSchema[] = [");
for (const edge of edgeSchemas) {
  edgeLines.push(`  ${edgeVarName(edge.id)},`);
}
edgeLines.push("];");
edgeLines.push("");

const edgeOutPath = join(outDir, "edge-type-registry.ts");
writeFileSync(edgeOutPath, edgeLines.join("\n") + "\n");
console.log(
  `Generated ${String(edgeSchemas.length)} edge types -> ${edgeOutPath}`,
);
