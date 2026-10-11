import type { TypeSchema } from "@withmarfa/shared";

export function labelledTypeDefinition<
  T extends { id: string; label?: string },
>(schema: T): T {
  if (!schema.label) {
    const last = schema.id.split(".").at(-1) ?? schema.id;
    schema.label = last
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return schema;
}

/** Makes equivalent field defaults comparable without flattening inheritance. */
export function canonicalTypeDefinition(schema: TypeSchema): TypeSchema {
  return labelledTypeDefinition({
    ...schema,
    fields: Object.fromEntries(
      Object.entries(schema.fields).map(([name, field]) => [
        name,
        {
          ...field,
          required: field.required ?? false,
          searchable: field.searchable ?? true,
        },
      ]),
    ),
  });
}
