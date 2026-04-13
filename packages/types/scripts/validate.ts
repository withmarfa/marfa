import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const VALID_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
  "enum",
];

const VALID_FORMATS = ["url", "date", "datetime", "email", "bcp47", "iso3166"];
const VALID_STATES = ["new", "active", "archived", "trashed"];

interface FieldDef {
  type: string;
  description: string;
  enum_values?: string[];
  items_type?: string;
  format?: string;
}

interface TypeSchema {
  id: string;
  parent?: string;
  label: string;
  description: string;
  version: number;
  fields: Record<string, FieldDef>;
  required: string[];
  states: string[];
  default_state: string;
  transitions: Record<string, string[]>;
}

const coreDir = resolve(import.meta.dirname, "..", "core");
const files = readdirSync(coreDir).filter((f) => f.endsWith(".json"));

if (files.length === 0) {
  console.error("No JSON files found in core/");
  process.exit(1);
}

const schemas = new Map<string, TypeSchema>();
const schemaFiles = new Map<string, string>();
const errors: string[] = [];

function addError(file: string, message: string) {
  errors.push(`${file}: ${message}`);
}

// Load and parse all schemas
for (const file of files) {
  const path = join(coreDir, file);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    addError(file, "Could not read file");
    continue;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    addError(file, "Invalid JSON");
    continue;
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    addError(file, "Schema root must be an object");
    continue;
  }

  const schema = data as Record<string, unknown>;

  // Check required top-level keys
  for (const key of [
    "id",
    "label",
    "description",
    "version",
    "fields",
    "required",
    "states",
    "default_state",
    "transitions",
  ]) {
    if (!(key in schema)) {
      addError(file, `Missing required key: ${key}`);
    }
  }

  if (typeof schema.id !== "string") {
    addError(file, "`id` must be a string");
    continue;
  }

  if (typeof schema.label !== "string" || schema.label.length === 0) {
    addError(file, "`label` must be a non-empty string");
  }

  if (typeof schema.description !== "string") {
    addError(file, "`description` must be a string");
  }

  if (
    typeof schema.version !== "number" ||
    !Number.isInteger(schema.version) ||
    schema.version < 1
  ) {
    addError(file, "`version` must be a positive integer");
  }

  // Validate states
  if (Array.isArray(schema.states)) {
    for (const state of schema.states) {
      const s = typeof state === "string" ? state : JSON.stringify(state);
      if (!VALID_STATES.includes(s)) {
        addError(file, `Invalid state: ${s}`);
      }
    }
  }

  // Validate default_state
  if (
    typeof schema.default_state === "string" &&
    !VALID_STATES.includes(schema.default_state)
  ) {
    addError(file, `Invalid default_state: ${schema.default_state}`);
  }

  // Validate transitions
  if (typeof schema.transitions === "object" && schema.transitions !== null) {
    for (const [from, to] of Object.entries(
      schema.transitions as Record<string, unknown>,
    )) {
      if (!VALID_STATES.includes(from)) {
        addError(file, `Transition from invalid state: ${from}`);
      }
      if (Array.isArray(to)) {
        for (const target of to) {
          const t =
            typeof target === "string" ? target : JSON.stringify(target);
          if (!VALID_STATES.includes(t)) {
            addError(file, `Transition to invalid state: ${t}`);
          }
        }
      }
    }
  }

  if (
    typeof schema.fields !== "object" ||
    schema.fields === null ||
    Array.isArray(schema.fields)
  ) {
    addError(file, "`fields` must be an object");
    continue;
  }

  if (!Array.isArray(schema.required)) {
    addError(file, "`required` must be an array");
    continue;
  }

  // Check for duplicate IDs
  if (schemas.has(schema.id)) {
    addError(file, `Duplicate type ID: ${schema.id}`);
    continue;
  }

  // Validate fields
  const fieldsObj = schema.fields as Record<string, unknown>;
  for (const [fieldName, fieldDef] of Object.entries(fieldsObj)) {
    if (
      typeof fieldDef !== "object" ||
      fieldDef === null ||
      Array.isArray(fieldDef)
    ) {
      addError(file, `Field "${fieldName}" must be an object`);
      continue;
    }

    const def = fieldDef as Record<string, unknown>;

    if (typeof def.type !== "string") {
      addError(file, `Field "${fieldName}" missing "type"`);
    } else if (!VALID_TYPES.includes(def.type)) {
      addError(file, `Field "${fieldName}" has invalid type: ${def.type}`);
    }

    if (typeof def.description !== "string") {
      addError(file, `Field "${fieldName}" missing "description"`);
    }

    // Enum fields must have enum_values
    if (def.type === "enum") {
      if (!Array.isArray(def.enum_values) || def.enum_values.length === 0) {
        addError(
          file,
          `Enum field "${fieldName}" must have non-empty "enum_values"`,
        );
      }
    }

    // Array fields must have items_type
    if (def.type === "array") {
      if (typeof def.items_type !== "string") {
        addError(file, `Array field "${fieldName}" must have "items_type"`);
      }
    }

    // Validate format if present
    if ("format" in def) {
      const fmt = typeof def.format === "string" ? def.format : "<non-string>";
      if (
        typeof def.format !== "string" ||
        !VALID_FORMATS.includes(def.format)
      ) {
        addError(file, `Field "${fieldName}" has invalid format: ${fmt}`);
      }
    }
  }

  schemas.set(schema.id, schema as unknown as TypeSchema);
  schemaFiles.set(schema.id, file);
}

// Resolve all fields for a type (own + inherited)
function resolveFields(typeId: string): Record<string, FieldDef> {
  const schema = schemas.get(typeId);
  if (!schema) return {};

  const parentFields = schema.parent ? resolveFields(schema.parent) : {};
  return { ...parentFields, ...schema.fields };
}

// Cross-schema checks
for (const [id, schema] of schemas) {
  const file = schemaFiles.get(id) ?? "<unknown file>";

  // Check parent reference
  if (schema.parent) {
    if (!schemas.has(schema.parent)) {
      addError(file, `Parent type "${schema.parent}" does not exist`);
    }
  }

  // Check required fields exist in resolved fields
  const allFields = resolveFields(id);
  for (const reqField of schema.required) {
    if (!(reqField in allFields)) {
      addError(
        file,
        `Required field "${reqField}" not found in fields (own or inherited)`,
      );
    }
  }
}

// Report
console.log(
  `Validated ${String(schemas.size)} schemas from ${String(files.length)} files\n`,
);

if (errors.length > 0) {
  console.error(`Found ${String(errors.length)} error(s):\n`);
  for (const error of errors) {
    console.error(`  ✗ ${error}`);
  }
  process.exit(1);
} else {
  console.log("All schemas valid ✓");

  // Summary
  const parents = [...schemas.values()].filter((s) => !s.parent);
  const subtypes = [...schemas.values()].filter((s) => s.parent);
  console.log(
    `  ${String(parents.length)} root types, ${String(subtypes.length)} subtypes`,
  );
}
