/**
 * Per-connection user mappings: the user's own routing of an integration's
 * incoming records, carried on `system.connection.properties.mapping` and
 * executed by the shared runtime rather than per-author code.
 *
 * The scope boundary is deliberate and narrow — conditions and field
 * assignment, not a templating language. A condition is a closed operator
 * over a dot-path into the upstream-faithful record; an assignment maps a
 * target field to a source path or a literal. Rule branching covers
 * conditional values; computed values are deliberately out.
 */
import { z } from "zod";
import {
  classifyNamespace,
  getResolvedFields,
  getTypeSchema,
} from "./type-registry.js";

/** Operators over a dot-path into the incoming record. */
const ConditionLeafSchema = z
  .object({
    path: z.string().min(1),
    op: z.enum(["equals", "not_equals", "exists", "missing", "contains"]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((leaf, ctx) => {
    const needsValue =
      leaf.op === "equals" ||
      leaf.op === "not_equals" ||
      leaf.op === "contains";
    if (needsValue && leaf.value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${leaf.op}" requires a value`,
      });
    }
    if (!needsValue && leaf.value !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `"${leaf.op}" takes no value`,
      });
    }
  });

const ConditionSchema = z.union([
  ConditionLeafSchema,
  z.object({ all: z.array(ConditionLeafSchema).min(1) }).strict(),
]);

/**
 * A target field is assigned from a source path or a literal. The literal
 * is still assignment rather than templating: it exists so a required
 * target field the source cannot supply (a discriminator, a flag) can be
 * satisfied. Scalars only — a structured constant would be a document
 * nobody validates.
 */
const AssignmentSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ const: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
]);

const RuleSchema = z
  .object({
    when: ConditionSchema,
    target_type: z.string().min(1),
    assign: z.record(z.string().min(1), AssignmentSchema),
  })
  .strict();

export const ConnectionMappingSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(RuleSchema).min(1),
    /**
     * What happens to a record no rule matches: fall through to the
     * selected write family (the default), or skip it. Skips are counted
     * and surface as one summary activity row per run — deliberate
     * routing away is not an error, but it is never invisible either.
     */
    otherwise: z.enum(["family", "skip"]).default("family"),
  })
  .strict();

export type ConnectionMapping = z.infer<typeof ConnectionMappingSchema>;
type MappingConditionLeaf = z.infer<typeof ConditionLeafSchema>;

export interface MappingIssue {
  field: string;
  message: string;
}

export type MappingValidation =
  | { ok: true; mapping: ConnectionMapping }
  | { ok: false; issues: MappingIssue[] };

/**
 * Validate a mapping document wholesale: shape first, then every rule
 * against the space's live registry. Each refusal names the field, so a
 * misconfiguration is fixable from the error alone.
 */
export function validateConnectionMapping(
  input: unknown,
  spaceId?: string,
): MappingValidation {
  const parsed = ConnectionMappingSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "_root",
        message: issue.message,
      })),
    };
  }
  const issues: MappingIssue[] = [];
  parsed.data.rules.forEach((rule, index) => {
    const at = `rules.${String(index)}`;
    const tier = classifyNamespace(rule.target_type);
    if (tier === "system" || tier === "marfa") {
      // The reserved-root item-write gate would refuse these writes at
      // runtime; refusing at configure time keeps the mint projection
      // from ever carrying a grant the gate contradicts.
      issues.push({
        field: `${at}.target_type`,
        message: `"${rule.target_type}" is in a reserved namespace and cannot be a mapping target`,
      });
      return;
    }
    const schema = getTypeSchema(rule.target_type, spaceId);
    if (!schema) {
      issues.push({
        field: `${at}.target_type`,
        message: `"${rule.target_type}" is not a registered type in this space`,
      });
      return;
    }
    const fields = getResolvedFields(rule.target_type, spaceId) ?? {};
    for (const key of Object.keys(rule.assign)) {
      if (!fields[key]) {
        issues.push({
          field: `${at}.assign.${key}`,
          message: `"${rule.target_type}" declares no field "${key}"`,
        });
      }
    }
    for (const [name, field] of Object.entries(fields)) {
      if (field.required && rule.assign[name] === undefined) {
        issues.push({
          field: `${at}.assign.${name}`,
          message: `"${rule.target_type}" requires "${name}", which this rule never assigns`,
        });
      }
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, mapping: parsed.data };
}

function valueAtPath(record: unknown, path: string): unknown {
  let cursor: unknown = record;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function leafHolds(leaf: MappingConditionLeaf, record: unknown): boolean {
  const found = valueAtPath(record, leaf.path);
  switch (leaf.op) {
    case "exists":
      return found !== undefined && found !== null;
    case "missing":
      return found === undefined || found === null;
    case "equals":
      return found === leaf.value;
    case "not_equals":
      return found !== leaf.value;
    case "contains":
      if (typeof found === "string" && typeof leaf.value === "string") {
        return found.includes(leaf.value);
      }
      if (Array.isArray(found)) {
        return found.includes(leaf.value);
      }
      return false;
  }
}

export type MappingOutcome =
  | {
      kind: "user";
      target_type: string;
      properties: Record<string, unknown>;
    }
  | { kind: "family" }
  | { kind: "skip" };

/**
 * Evaluate a mapping against one incoming record. First matching rule
 * wins. An assigned source path absent on this record omits the property
 * rather than failing here — write-time validation is what turns a
 * missing required field into a per-item failure, so the refusal carries
 * the type's own error rather than a second dialect of it.
 */
export function evaluateConnectionMapping(
  mapping: ConnectionMapping,
  record: unknown,
): MappingOutcome {
  for (const rule of mapping.rules) {
    const holds =
      "all" in rule.when
        ? rule.when.all.every((leaf) => leafHolds(leaf, record))
        : leafHolds(rule.when, record);
    if (!holds) continue;
    const properties: Record<string, unknown> = {};
    for (const [field, assignment] of Object.entries(rule.assign)) {
      if ("const" in assignment) {
        properties[field] = assignment.const;
      } else {
        const found = valueAtPath(record, assignment.path);
        if (found !== undefined) properties[field] = found;
      }
    }
    return { kind: "user", target_type: rule.target_type, properties };
  }
  return mapping.otherwise === "skip" ? { kind: "skip" } : { kind: "family" };
}
