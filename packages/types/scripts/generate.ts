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

interface JsonSchema {
  id: string;
  parent?: string;
  label: string;
  description: string;
  version: number;
  fields: Record<string, JsonField>;
  required: string[];
  states: string[];
  default_state: string;
  transitions: Record<string, string[]>;
}

const coreDir = resolve(import.meta.dirname, "..", "core");
const outDir = resolve(import.meta.dirname, "..", "generated");

// Load all schemas
const files = readdirSync(coreDir).filter((f) => f.endsWith(".json"));
const schemas: JsonSchema[] = files.map((f) => {
  const raw = readFileSync(join(coreDir, f), "utf-8");
  return JSON.parse(raw) as JsonSchema;
});

// Sort: parents before children (no parent first, then by depth)
schemas.sort((a, b) => {
  const depthA = a.id.split(".").length;
  const depthB = b.id.split(".").length;
  return depthA - depthB;
});

// Generate variable name from type ID: core.work.book -> coreWorkBook
function varName(id: string): string {
  return id
    .split(".")
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("")
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Map JSON schema type+format to TypeScript FieldDefinition type.
// JSON schemas use type:"string" + format:"url", but FieldDefinition uses type:"url" directly.
const FORMAT_TO_TYPE: Record<string, string> = {
  url: "url",
  email: "email",
  datetime: "datetime",
  date: "date",
};

// Generate field definition as TypeScript object literal
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

// Build output — a self-contained ES module that imports schema-shape
// interfaces from src/ and exports the ALL_TYPES array plus individual consts.
const lines: string[] = [];
lines.push("// Auto-generated from core/*.json — do not edit manually.");
lines.push("// Run `pnpm --filter @mymehq/types generate` to regenerate.");
lines.push("");
lines.push(
  'import type { TypeSchema, ItemState } from "../src/schema-types.js";',
);
lines.push("");

// Build schema map for parent field resolution
const schemaMap = new Map<string, JsonSchema>();
for (const s of schemas) schemaMap.set(s.id, s);

// Resolve all fields for a type (own + inherited from parent chain)
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

// Emit each type
for (const schema of schemas) {
  const name = varName(schema.id);
  const { fields: resolvedFields, required: resolvedRequired } =
    resolveFields(schema);

  lines.push(`const ${name}: TypeSchema = {`);
  lines.push(`  id: "${schema.id}",`);
  if (schema.parent) lines.push(`  parent: "${schema.parent}",`);
  lines.push(`  label: "${schema.label}",`);
  lines.push(`  version: ${String(schema.version)},`);
  lines.push("  fields: {");
  for (const [fieldName, fieldDef] of Object.entries(resolvedFields)) {
    const isReq = resolvedRequired.has(fieldName);
    lines.push(`    ${fieldName}: ${fieldLiteral(fieldDef, isReq)},`);
  }
  lines.push("  },");
  lines.push(`  states: ${JSON.stringify(schema.states)} as ItemState[],`);
  lines.push(`  default_state: "${schema.default_state}" as ItemState,`);
  lines.push("  transitions: {");
  for (const [from, to] of Object.entries(schema.transitions)) {
    lines.push(`    ${from}: ${JSON.stringify(to)} as ItemState[],`);
  }
  lines.push("  },");
  lines.push("};");
  lines.push("");
}

// ALL_TYPES array
lines.push("export const ALL_TYPES: TypeSchema[] = [");
for (const schema of schemas) {
  lines.push(`  ${varName(schema.id)},`);
}
lines.push("];");
lines.push("");

// Write output
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "type-registry.ts");
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`Generated ${String(schemas.length)} types -> ${outPath}`);
