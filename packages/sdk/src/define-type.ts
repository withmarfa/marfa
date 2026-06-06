import type { TypeSchema } from "@withmarfa/shared";

/**
 * Authoring helper for declaring custom Marfa types in TypeScript.
 *
 * The function is a no-op at runtime — it returns its input unchanged. Its
 * value is at the type level: `defineType` constrains the argument to a
 * structurally-valid `TypeSchema`, surfacing field-shape mistakes at compile
 * time rather than at `POST /types` rejection time. Pair with the SDK's
 * `client.types.register(schema)` call to register the type with the server.
 *
 * Example:
 *
 * ```ts
 * import { defineType } from "@withmarfa/sdk";
 *
 * export const acmeDeal = defineType({
 *   id: "acme.deal",
 *   label: "Deal",
 *   description: "A sales pipeline opportunity",
 *   version: 1,
 *   fields: {
 *     name: { type: "string", description: "Deal name", required: true },
 *     amount: { type: "number", description: "Deal value (USD)" },
 *   },
 * });
 *
 * await client.types.register(acmeDeal);
 * ```
 *
 * The helper preserves the literal types of the schema (via the generic
 * parameter), so downstream code that reads `acmeDeal.fields.name.type` sees
 * the narrowed literal `"string"` rather than the wide `FieldType` union.
 */
export function defineType<T extends TypeSchema>(schema: T): T {
  return schema;
}
